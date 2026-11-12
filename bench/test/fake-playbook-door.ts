import { realpathSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { domainNamed } from '../tasks/domains.ts'
import type { Call, Domain, Instance, Words } from '../tasks/shared.ts'
import type { Fake, FakeOptions } from './fake-model.ts'
import { startFake } from './fake-model.ts'

/**
 * How the door marks a blank: the ask's, its value in place; an earlier step's result's, by a key; or its own to fill.
 * The last three are blanks no local rule may fill: an ask value not marked local, a model's value, a blank ask value.
 */
export type Mark = 'ask' | 'door' | { from: number; path: string } | 'ask-not-local' | 'model-in-place' | 'blank-ask'

/** One step the door plans: its tool, the value each argument should get, and how each blank is marked. */
export interface Planned {
  tool: string
  args: Record<string, string>
  marks: Record<string, Mark>
}

export type FillKind = 'filled' | 'needs_model' | 'stop' | 'done'

/** A call made under an answer, as the door names it in the answer's `spent` and in `x-reactor-spent`. */
export interface SpentCall {
  model: string
  tokens_in: number
  tokens_out: number
  purpose: string
}

export type DoorRoute = 'playbooks' | 'playbooks/fill' | 'playbooks/reply'

export interface DoorOptions {
  domain: Domain
  seed: number
  days: number
  /** The words the run asks in; the door knows only the asks of that setting. */
  words?: Words
  /** A playbook of the test's own for a job; the one its reference solution shows unless given. */
  plan?: (inst: Instance) => Planned[] | undefined
  /** A blank's mark in place of the planned one. */
  mark?: (inst: Instance, stepNo: number, name: string) => Mark | undefined
  /** The fill answer's kind for a step; filled unless given. */
  kind?: (inst: Instance, stepNo: number) => FillKind | undefined
  /**
   * The reply route's answer for a job: the words or why a model is needed. Unless given, the words of the job's
   * reference reply, as a small model that wrote exactly what the oracle would.
   */
  reply?: (inst: Instance) => { kind: 'words'; text: string } | { kind: 'needs_model'; reason: string } | undefined
  /** The playbook's source for a job; template unless given, and none for a job with no playbook. */
  source?: (inst: Instance) => 'template' | 'plan' | 'cold' | undefined
  /** The reason a fill answer gives; none unless given. */
  reason?: (inst: Instance, stepNo: number) => string | undefined
  /** Who a filled answer says filled the step; the large model unless given. */
  filler?: (inst: Instance, stepNo: number) => 'ask' | 'result' | 'small' | 'large' | null
  /** The step a filled answer carries, for a test that wants it to differ from the plan. */
  fillAs?: (inst: Instance, stepNo: number, step: DoorStep) => DoorStep
  /** Jobs whose last acting step is the decoy, as the fake model's own `wrong` scripts them. */
  wrong?: ReadonlySet<string>
  /** Jobs the door makes no playbook for: needs_model, and no steps. */
  noPlaybook?: ReadonlySet<string>
  /**
   * Serve the agent's own calls through pass: a pass asks one small-model round (run_model) and the answer to it is
   * served, the job's next scripted call or its reply, by the small model. Every pass is needs_model unless set.
   */
  servePass?: boolean
  /** The playbook switch off: each playbook path answers 404, as a path the door never served. */
  off?: boolean
  /** What an answer says it spent: in its body's `spent`, and in `x-reactor-spent` when a header list is given. */
  spent?: (route: DoorRoute, inst: Instance, stepNo: number | null) => { body?: SpentCall[]; header?: SpentCall[] }
  /** Statuses to answer the first reports with, in order, before answering normally. */
  reportStatuses?: number[]
  /** The models a model's fill names as spent when no test scripts the spend; the tests' price book's own unless given. */
  models?: { large: string; small: string }
  /** Passed to the fake model that answers /v1/chat/completions behind the door. */
  model?: Omit<FakeOptions, 'domain' | 'seed' | 'days' | 'words'>
}

export interface DoorBlank {
  name: string
  value: string | null
  local: boolean
  filled_by: 'ask' | 'result' | 'model' | null
  from?: { step_no: number; path: string }
}

export interface DoorStep {
  step_no: number
  tool: string
  blanks: DoorBlank[]
}

export interface DoorSeen {
  route: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

export interface Door {
  /** The base URL, ending in /v1. */
  url: string
  /** Every playbook request, in order; chat requests are the fake model's `seen`. */
  seen: DoorSeen[]
  model: Fake
  close: () => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What a fill a model made names as spent, as the door names it, unless a test scripts the spend. */
const fillSpent = (model: string): SpentCall[] => [{ model, tokens_in: 100, tokens_out: 10, purpose: 'fill' }]

/** A job's reference calls, its last act swapped for the decoy on a wrong job, as the fake model scripts them. */
const scriptOf = (domain: Domain, inst: Instance, wrong: boolean): Call[] => {
  const { calls } = inst.solve()
  if (!wrong) {
    return calls
  }
  const last = calls.map((c) => domain.acting.has(c.tool)).lastIndexOf(true)
  return last === -1 ? [...calls, inst.decoy()] : calls.map((c, i) => (i === last ? inst.decoy() : c))
}

/** A value's mark: the ask's when the ask carries it, an earlier result's when a tool called once before holds it at a key. */
const markOf = (ask: string, value: string, before: readonly Call[], results: readonly unknown[]): Mark => {
  if (ask.toLowerCase().includes(value.toLowerCase())) {
    return 'ask'
  }
  for (const [j, result] of results.entries()) {
    const once = before.filter((c) => c.tool === before[j]?.tool).length === 1
    const path = once && isRecord(result) ? Object.keys(result).find((key) => result[key] === value) : undefined
    if (path !== undefined) {
      return { from: j + 1, path }
    }
  }
  return 'door'
}

/** The playbook a job's reference solution shows: a step per call, a blank per argument, each marked as markOf reads it. */
export const plannedOf = (domain: Domain, inst: Instance, wrong = false): Planned[] => {
  const calls = scriptOf(domain, inst, wrong)
  const session = inst.open()
  const results = calls.map((c) => session.call(c.tool, c.args))
  return calls.map((c, i) => {
    const args = Object.fromEntries(Object.entries(c.args).map(([name, value]) => [name, String(value)]))
    const marks = Object.fromEntries(
      Object.entries(args).map(([name, value]) => [
        name,
        markOf(inst.ask, value, calls.slice(0, i), results.slice(0, i)),
      ]),
    )
    return { tool: c.tool, args, marks }
  })
}

const blankOf = (name: string, value: string, mark: Mark): DoorBlank => {
  if (mark === 'ask') {
    return { name, value, local: true, filled_by: 'ask' }
  }
  if (mark === 'door') {
    return { name, value: null, local: false, filled_by: null }
  }
  if (mark === 'ask-not-local') {
    return { name, value, local: false, filled_by: 'ask' }
  }
  if (mark === 'model-in-place') {
    return { name, value, local: true, filled_by: 'model' }
  }
  if (mark === 'blank-ask') {
    return { name, value: '   ', local: true, filled_by: 'ask' }
  }
  return { name, value: null, local: true, filled_by: null, from: { step_no: mark.from, path: mark.path } }
}

/** The reply route's path, its job id the one segment between. */
const REPLY_PATH = /^\/v1\/playbooks\/([^/]+)\/reply$/

/** The pass route's path: the library's per-step path for the agent's own call, which this door never serves. */
const PASS_PATH = /^\/v1\/playbooks\/([^/]+)\/pass$/
const ANSWER_PATH = /^\/v1\/playbooks\/([^/]+)\/answer$/

export const startDoor = async (opts: DoorOptions): Promise<Door> => {
  const { domain, seed, days, words } = opts
  const model = await startFake({ domain, seed, days, words, ...opts.model })
  const byAsk = new Map(domain.instances(seed, days, words).map((i) => [i.ask, i]))
  const jobs = new Map<string, Instance>()
  const asked = new Map<string, Record<string, unknown>[]>()
  const reportStatuses = [...(opts.reportStatuses ?? [])]
  const seen: DoorSeen[] = []
  let made = 0

  const planOf = (inst: Instance): Planned[] =>
    opts.plan?.(inst) ?? plannedOf(domain, inst, opts.wrong?.has(inst.id) ?? false)
  const markAt = (inst: Instance, planned: Planned, stepNo: number, name: string): Mark =>
    opts.mark?.(inst, stepNo, name) ?? planned.marks[name] ?? 'door'

  const answer = async (
    path: string,
    headers: IncomingHttpHeaders,
    raw: string,
  ): Promise<{ status: number; payload: unknown; headers?: Record<string, string> }> => {
    const spentOf = (route: DoorRoute, inst: Instance, stepNo: number | null, byModel: string | null = null) => {
      const spent = opts.spent?.(route, inst, stepNo) ?? (byModel === null ? {} : { body: fillSpent(byModel) })
      return {
        body: spent.body ?? [],
        headers: spent.header === undefined ? undefined : { 'x-reactor-spent': JSON.stringify(spent.header) },
      }
    }
    const body = JSON.parse(raw) as Record<string, unknown>
    // A reply names its job in the path; it is seen under its route's name, the job read off the path.
    const replied = REPLY_PATH.exec(path)
    const passed = PASS_PATH.exec(path)
    const answered = ANSWER_PATH.exec(path)
    seen.push({
      route:
        replied !== null
          ? 'playbooks/reply'
          : passed !== null
            ? 'playbooks/pass'
            : answered !== null
              ? 'playbooks/answer'
              : path.slice('/v1/'.length),
      headers,
      body,
    })
    if (opts.servePass === true && (passed !== null || answered !== null)) {
      const jobId = decodeURIComponent((passed ?? answered)?.[1] ?? '')
      const inst = jobs.get(jobId)
      if (inst === undefined) {
        return { status: 400, payload: { error: { message: 'no such job' } } }
      }
      if (passed !== null) {
        asked.set(jobId, body.messages as Record<string, unknown>[])
        return {
          status: 200,
          payload: {
            kind: 'run_model',
            model: 'small',
            prompt: { messages: body.messages, max_tokens: 100, temperature: 0 },
            token: `token-${jobId}`,
            step_no: 0,
            spent: [],
          },
        }
      }
      const done = (asked.get(jobId) ?? []).filter((m) => m.role === 'assistant').length
      const next = inst.solve().calls[done]
      const message =
        next === undefined
          ? { role: 'assistant', content: inst.solve().reply }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${done}`,
                  type: 'function',
                  function: { name: next.tool, arguments: JSON.stringify(next.args) },
                },
              ],
            }
      return {
        status: 200,
        payload: {
          kind: 'served',
          answer: { id: 'served', choices: [{ index: 0, message, finish_reason: 'stop' }] },
          filled_by: 'small',
          spent: [],
        },
      }
    }
    if (passed !== null) {
      // The agent's own call is the agent's: the fake door serves none, so every pass hands it back.
      return {
        status: 200,
        payload: {
          kind: 'needs_model',
          reason: 'the fake door serves no pass',
          job_id: decodeURIComponent(passed[1] ?? ''),
          spent: [],
        },
      }
    }
    if (replied !== null) {
      const jobId = decodeURIComponent(replied[1] ?? '')
      const inst = jobs.get(jobId)
      if (inst === undefined || typeof body.ask !== 'string' || !Array.isArray(body.steps)) {
        return { status: 400, payload: { error: { message: 'The request body must carry the ask and the steps.' } } }
      }
      const said = opts.reply?.(inst) ?? { kind: 'words' as const, text: inst.solve().reply }
      const spent = spentOf(
        'playbooks/reply',
        inst,
        null,
        said.kind === 'words' ? (opts.models?.small ?? 'small-model') : null,
      )
      return {
        status: 200,
        payload: {
          job_id: jobId,
          ...said,
          filled_by: said.kind === 'words' ? 'small' : null,
          spent: spent.body,
        },
        headers: spent.headers,
      }
    }
    if (path === '/v1/playbooks') {
      if (typeof body.ask !== 'string' || !Array.isArray(body.tools)) {
        return { status: 400, payload: { error: { message: 'The request body must carry an ask and its tools.' } } }
      }
      const inst = byAsk.get(body.ask)
      if (inst === undefined) {
        return { status: 400, payload: { error: { message: 'no task with that ask' } } }
      }
      const named = headers['x-reactor-run']
      made += 1
      const jobId = typeof named === 'string' && named !== '' ? named : `job-${made}`
      jobs.set(jobId, inst)
      const steps = (opts.noPlaybook?.has(inst.id) ?? false) ? [] : planOf(inst)
      const spent = spentOf('playbooks', inst, null)
      return {
        status: 200,
        payload: {
          job_id: jobId,
          tenant: 'tenant-test',
          ask: body.ask,
          tools: body.tools,
          source: steps.length === 0 ? 'none' : (opts.source?.(inst) ?? 'template'),
          needs_model: steps.length === 0,
          issued_at: '2026-10-25T00:00:00.000Z',
          expires_at: '2026-10-25T01:00:00.000Z',
          steps: steps.map((planned, i) => ({
            step_no: i + 1,
            tool: planned.tool,
            blanks: Object.entries(planned.args).map(([name, value]) =>
              blankOf(name, value, markAt(inst, planned, i + 1, name)),
            ),
          })),
          spent: spent.body,
        },
        headers: spent.headers,
      }
    }
    if (path === '/v1/playbooks/fill') {
      const inst = typeof body.job_id === 'string' ? jobs.get(body.job_id) : undefined
      const stepNo = body.step_no
      const planned = inst === undefined || typeof stepNo !== 'number' ? undefined : planOf(inst)[stepNo - 1]
      if (inst === undefined || typeof stepNo !== 'number' || planned === undefined) {
        return { status: 400, payload: { error: { message: 'The request body must be a fill request for one step.' } } }
      }
      const kind = opts.kind?.(inst, stepNo) ?? 'filled'
      const filled: DoorStep = {
        step_no: stepNo,
        tool: planned.tool,
        blanks: Object.entries(planned.args).map(([name, value]) => {
          const mark = markAt(inst, planned, stepNo, name)
          return {
            ...blankOf(name, value, mark),
            value,
            filled_by: mark === 'ask' ? 'ask' : typeof mark === 'object' ? 'result' : 'model',
          }
        }),
      }
      const filledBy = kind !== 'filled' ? null : opts.filler === undefined ? 'large' : opts.filler(inst, stepNo)
      const models = opts.models ?? { large: 'big-model', small: 'small-model' }
      const byModel =
        kind !== 'filled' || filledBy === 'ask' || filledBy === 'result'
          ? null
          : filledBy === 'small'
            ? models.small
            : models.large
      const spent = spentOf('playbooks/fill', inst, stepNo, byModel)
      const reason = opts.reason?.(inst, stepNo)
      return {
        status: 200,
        payload: {
          job_id: body.job_id,
          step_no: stepNo,
          kind,
          ...(kind === 'filled' ? { step: opts.fillAs?.(inst, stepNo, filled) ?? filled } : {}),
          filled_by: filledBy,
          ...(reason === undefined ? {} : { reason }),
          spent: spent.body,
        },
        headers: spent.headers,
      }
    }
    const status = reportStatuses.shift()
    if (status !== undefined) {
      return { status, payload: { error: { message: `scripted ${status}` } } }
    }
    return { status: 200, payload: { job_id: body.job_id, tenant: 'tenant-test', kind: 'needs_model' } }
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const path = new URL(req.url ?? '', 'http://fake').pathname
      const reply = (status: number, text: string, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(text)
      }
      void (async () => {
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          // The door's chat route, played by the fake model, so a reply in words comes from the plain arm's oracle.
          const forwarded = await fetch(`${model.url}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
              ...(typeof req.headers['x-reactor-run'] === 'string'
                ? { 'x-reactor-run': req.headers['x-reactor-run'] }
                : {}),
            },
            body: raw,
          })
          const spent = forwarded.headers.get('x-reactor-spent')
          reply(forwarded.status, await forwarded.text(), spent === null ? {} : { 'x-reactor-spent': spent })
          return
        }
        const known =
          ['/v1/playbooks', '/v1/playbooks/fill', '/v1/playbooks/report'].includes(path) ||
          REPLY_PATH.test(path) ||
          PASS_PATH.test(path) ||
          (opts.servePass === true && ANSWER_PATH.test(path))
        if (req.method !== 'POST' || !known || opts.off === true) {
          reply(404, JSON.stringify({ error: { message: 'not found' } }))
          return
        }
        const answered = await answer(path, req.headers, raw)
        reply(answered.status, JSON.stringify(answered.payload), answered.headers)
      })()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    model,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      })
      await model.close()
    },
  }
}

// node test/fake-playbook-door.ts --domain support-ops --seed 1 --days 1 --large MODEL --small MODEL prints its base
// URL and serves until stopped; a model's fill names its spend at the --large or --small model.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      domain: { type: 'string' },
      seed: { type: 'string' },
      days: { type: 'string' },
      words: { type: 'string' },
      large: { type: 'string' },
      small: { type: 'string' },
    },
  })
  const door = await startDoor({
    domain: domainNamed(values.domain ?? 'support-ops'),
    seed: Number(values.seed ?? '1'),
    days: Number(values.days ?? '1'),
    words: values.words === 'same' ? 'same' : 'new',
    models: { large: values.large ?? 'big-model', small: values.small ?? 'small-model' },
  })
  console.log(door.url)
  const stop = (): void => {
    void door.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
