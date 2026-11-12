import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOpenAIRunner } from '@agencer/reactor'
import type { Domain, Instance, Words } from '../tasks/shared.ts'
import type { KeyUse } from './ledger.ts'
import { earlierUse, useKey } from './ledger.ts'
import type { Ended, Event, FilledBy, Reply } from './playbook-client.ts'
import { playJob, stampOf, stepLineOf } from './playbook-client.ts'
import { playJobWithLibrary } from './library-client.ts'
import type { PriceBook, ServedBy } from './prices.ts'
import { costOf, priceOf, servedBy } from './prices.ts'

export type Arm = 'plain' | 'reactor' | 'playbook'

/** The playbook arm's clients by name: the bare one here, and the customer's library beside it once it plugs in. */
export const CLIENTS = { bare: playJob, library: playJobWithLibrary } as const

export type ClientName = keyof typeof CLIENTS

export interface RunOptions {
  arm: Arm
  domain: Domain
  days: number
  /** The OpenAI-shaped base URL, ending before `/chat/completions`, like https://api.openai.com/v1. */
  baseUrl: string
  key: string
  large: string
  /** The small model the reactor key was made with; null on the plain arm. */
  small: string | null
  seed: number
  /** The words each day asks a job in; new unless given. */
  words?: Words
  runId: string
  out: string
  prices: PriceBook
  harnessCommit: string
  maxSteps?: number
  settleSeconds?: number
  timeoutSeconds?: number
  /** The key ledger file the reactor arm checks its key against and files it in; none means the key is not checked. */
  ledger?: string
  /** Refuse to start the reactor arm on a key the ledger has seen. */
  freshKeyRequired?: boolean
  /** The playbook arm's client, by its name in CLIENTS; bare unless given. */
  client?: ClientName
  /**
   * The customer's own provider, the library client's: the OpenAI-shaped base URL the runner and the agent's own chat
   * calls go to, and its key. Both are required with the library client; neither is written to a file.
   */
  providerUrl?: string
  providerKey?: string
  /** Whether the playbook arm's fills let the door call a model; true unless given. */
  allowModel?: boolean
  /** Whether the playbook arm asks the door for a job's final reply (2026-10-28); off unless given. */
  reply?: boolean
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export interface StepLine {
  run_id: string
  arm: Arm
  domain: string
  day: number
  instance: string
  template: string
  step: number
  /** A door line is one answer of the playbook routes, on the playbook arm only. */
  kind: 'tool' | 'talk' | 'error' | 'door'
  tool: string | null
  tool_calls: number
  served_by: ServedBy | null
  response_model: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  usage_reported: boolean
  latency_ms: number
  retries: number
  cost_usd: number
  /**
   * What the engine's calls under this step cost, from `x-reactor-spent` (2026-10-20): the planner, the embedder
   * and the checks, each at its own model. Absent on lines written before, which score as 0.
   */
  overhead_usd?: number
  /** How many of those calls named a model `prices.json` has no line for; they count $0 above. */
  overhead_unpriced?: number
  /**
   * How many of the step's tool calls the tool itself refused (the bench tools answer `{ error }`), 2026-10-23: the
   * scorer counts them on tasks that still passed. Absent on lines written before, which score as 0.
   */
  tool_failures?: number
  /** On the playbook arm: who filled the step a tool line called. */
  filled_by?: FilledBy
  /** On the playbook arm, on a tool line the tool refused: the call as it was sent and the tool's words (2026-10-30). */
  refused?: { call: Record<string, string>; error: string }
  /** On the playbook arm: the route a door, talk or error line answered, and what a fill answer said. */
  route?: string
  said?: string | null
  /** On a round's line that settled a route's answer: that route, whose verdict `said` then is (2026-11-04). */
  settles?: string
  /**
   * When the line's step ended, in whole ms since its job started (2026-11-09): the time between two tool
   * lines is what the agent waited for the second step, the door's rounds and any model run on either side included.
   * Absent on lines written before.
   */
  at_ms?: number
  /** On the playbook arm: the reason a fill answer gave, when it gave one, 2026-10-27. */
  reason?: string
  error: string | null
}

/** The fields every line of one task shares. */
type LineBase = Pick<StepLine, 'run_id' | 'arm' | 'domain' | 'day' | 'instance' | 'template'>

/** Whether a tool result is the bench tools' own refusal: a JSON object whose `error` is text, and nothing else. */
export const toolFailed = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  !Array.isArray(result) &&
  typeof (result as { error?: unknown }).error === 'string'

export interface TaskLine {
  run_id: string
  arm: Arm
  domain: string
  day: number
  instance: string
  template: string
  form: number
  passed: boolean
  reason: string
  steps: number
  tool_steps: number
  capped: boolean
  seconds: number
  /** On the playbook arm: the step line (who filled each step), how the job ended, and whether the door took its report. */
  step_line?: string
  ended?: Ended | 'plain'
  reported?: boolean
}

export interface RunRecord {
  benchmark: 'repeat-bill'
  version: '0.1'
  run_id: string
  arm: Arm
  domain: string
  days: number
  tasks_per_day: number
  seed: number
  words: Words
  large_model: string
  small_model: string | null
  base_url: string
  max_steps: number
  timeout_seconds: number
  settle_seconds: number
  /** The playbook arm's client and whether its fills let the door call a model; absent on the other arms. */
  client?: string
  allow_model?: boolean
  /** Whether the playbook arm asked the door for each job's final reply; absent on the other arms and before 2026-10-28. */
  reply?: 'on' | 'off'
  /** The prices every step of this run was costed at, so a later edit to prices.json cannot change it. */
  prices: Record<string, { in_per_mtok: number; out_per_mtok: number }>
  harness_commit: string
  node: string
  started_at: string
  finished_at: string | null
  /** Whether the key ledger had seen the reactor key at this base URL; null on the plain arm and when not checked. */
  key_seen_before: boolean | null
  /** The run the ledger names for that key when it had seen it; null otherwise. */
  key_earlier_run_id: string | null
}

export const MAX_STEPS = 25
export const SETTLE_SECONDS = 65

/** The step cap a domain runs at: its own, or the default. */
export const capOf = (domain: Domain): number => domain.maxSteps ?? MAX_STEPS
export const TIMEOUT_SECONDS = 120
const BACKOFF_MS = [1000, 4000]

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

/** One call the engine made under a step, as `x-reactor-spent` names it. */
export interface SpentCall {
  model: string
  tokens_in: number
  tokens_out: number
}

/** The calls a spent list names, the header's or a door answer's `spent`; an entry this cannot read names none. */
const callsIn = (list: unknown): SpentCall[] =>
  Array.isArray(list)
    ? list.flatMap((entry) => {
        const call = asObject(entry)
        return call !== undefined &&
          typeof call.model === 'string' &&
          typeof call.tokens_in === 'number' &&
          typeof call.tokens_out === 'number'
          ? [{ model: call.model, tokens_in: call.tokens_in, tokens_out: call.tokens_out }]
          : []
      })
    : []

/** The calls `x-reactor-spent` names; none for no header or one this cannot read. */
const spentFrom = (header: string | null): SpentCall[] => {
  if (header === null) {
    return []
  }
  try {
    return callsIn(JSON.parse(header))
  } catch {
    return []
  }
}

/** What a door answer spent: the header's calls when it names one, else the answer's own `spent`, never the two added. */
const doorSpent = (answer: Extract<Answer, { ok: true }>): SpentCall[] =>
  answer.spent.length > 0 ? answer.spent : callsIn(answer.body.spent)

export type Answer =
  | { ok: true; body: Record<string, unknown>; spent: SpentCall[]; latencyMs: number; retries: number }
  | { ok: false; error: string; latencyMs: number; retries: number }

/**
 * The commit this harness ran from, marked -dirty when a tracked file of bench/ has uncommitted changes.
 * Run output is untracked and prices.json is recorded in every run, so neither counts. Unknown outside git.
 */
export const harnessCommit = (benchDir: string): string => {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: benchDir, encoding: 'utf8' }).trim()
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude)prices.json'],
      { cwd: benchDir, encoding: 'utf8' },
    )
    return dirty.trim() === '' ? head : `${head}-dirty`
  } catch {
    return 'unknown'
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const parseArguments = (raw: unknown): unknown => {
  if (typeof raw !== 'string') {
    return raw
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** The first choice's message, the one part of a response the loop reads. */
const messageOf = (body: Record<string, unknown>): Record<string, unknown> | undefined =>
  asObject(asObject(Array.isArray(body.choices) ? body.choices[0] : undefined)?.message)

/** The tool calls a message asks for, each with its id, its tool and its arguments as sent. */
const toolCallsIn = (message: Record<string, unknown>): { id: string; name: string; arguments: unknown }[] =>
  (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap((c: unknown) => {
    const call = asObject(c)
    const fn = asObject(call?.function)
    return call !== undefined && fn !== undefined && typeof fn.name === 'string'
      ? [{ id: String(call.id ?? ''), name: fn.name, arguments: fn.arguments }]
      : []
  })

/** Which model filled a playbook step: the door's small or large one, other when it named nobody, none on the client. */
const filledOn = (e: Extract<Event, { kind: 'tool' }>): ServedBy | null => {
  if (e.filled_by === 'small' || e.filled_by === 'large') {
    return e.filled_by
  }
  return e.by === 'door' && e.filled_by === null ? 'other' : null
}

/** The base URL with no query or credentials in it, for the record. */
const publicUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  return `${url.origin}${url.pathname}`
}

export const runArm = async (opts: RunOptions): Promise<RunRecord> => {
  const maxSteps = opts.maxSteps ?? capOf(opts.domain)
  const words = opts.words ?? 'new'
  const timeoutSeconds = opts.timeoutSeconds ?? TIMEOUT_SECONDS
  const settleSeconds = opts.arm !== 'plain' ? (opts.settleSeconds ?? SETTLE_SECONDS) : 0
  const sleep = opts.sleep ?? realSleep
  const log = opts.log ?? (() => undefined)
  const clientName = opts.client ?? 'bare'
  const allowModel = opts.allowModel ?? true
  const askReply = opts.reply ?? false
  // Parsed before anything is written, so a base URL that cannot be read leaves nothing behind.
  const parsedBaseUrl = new URL(opts.baseUrl)
  // The library client's provider: its agent's chat calls and its runner go there, never to the door.
  const library = opts.arm === 'playbook' && clientName === 'library'
  if (library && (opts.providerUrl === undefined || opts.providerKey === undefined || opts.small === null)) {
    throw new Error('the library client needs a provider URL, a provider key and a small model')
  }
  const parsedProviderUrl = library && opts.providerUrl !== undefined ? new URL(opts.providerUrl) : null
  // The path is appended before any query, so a base URL like .../v1?api-version=x still reaches its endpoint.
  const urlUnder = (base: URL, path: string): string => {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`
    return url.toString()
  }
  const urlOf = (path: string): string => urlUnder(parsedBaseUrl, path)
  const largePrice = priceOf(opts.prices, opts.large)
  const smallPrice = opts.small === null ? null : priceOf(opts.prices, opts.small)

  /** POSTs a JSON body to a path under the base URL: a 429 or a 5xx is retried, and a 2xx must be a JSON object. */
  const postTo = async (
    base: URL,
    key: string,
    path: string,
    payload: unknown,
    extra: Record<string, string> = {},
  ): Promise<Answer> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...extra,
    }
    const body = JSON.stringify(payload)
    const endpoint = urlUnder(base, path)
    for (let retries = 0; ; retries++) {
      const started = performance.now()
      let failure: string
      let retryable: boolean
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
        })
        const text = await res.text()
        const latencyMs = Math.round(performance.now() - started)
        if (res.ok) {
          try {
            const parsed = asObject(JSON.parse(text))
            if (parsed !== undefined) {
              return {
                ok: true,
                body: parsed,
                spent: spentFrom(res.headers.get('x-reactor-spent')),
                latencyMs,
                retries,
              }
            }
          } catch {
            // Falls through to the refusal below.
          }
          return { ok: false, error: 'a 2xx response that is not a JSON object', latencyMs, retries }
        }
        failure = `status ${res.status}`
        retryable = res.status === 429 || res.status >= 500
      } catch (err) {
        failure = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error'
        retryable = true
      }
      const latencyMs = Math.round(performance.now() - started)
      const wait = BACKOFF_MS[retries]
      if (!retryable || wait === undefined) {
        return { ok: false, error: failure, latencyMs, retries }
      }
      await sleep(wait)
    }
  }

  const post = (path: string, payload: unknown, extra: Record<string, string> = {}): Promise<Answer> =>
    postTo(parsedBaseUrl, opts.key, path, payload, extra)

  if (existsSync(join(opts.out, 'steps.jsonl')) || existsSync(join(opts.out, 'tasks.jsonl'))) {
    throw new Error(`${opts.out} already holds a run; give each run its own --out`)
  }
  const startedAt = new Date().toISOString()
  // The playbook arm runs on a Reactor key too, so its key is checked and filed as the reactor arm's is.
  const checked = opts.arm !== 'plain' && opts.ledger !== undefined
  if (opts.arm !== 'plain' && opts.ledger === undefined && opts.freshKeyRequired === true) {
    throw new Error('--fresh-key-required needs a key ledger to check the key against')
  }
  const refusal = (use: KeyUse): Error =>
    new Error(`the Reactor key was used by run ${use.run_id} before this run; --fresh-key-required refuses it`)
  // Looked up before anything is written, so a refused run leaves nothing behind.
  let earlier: KeyUse | null =
    opts.arm !== 'plain' && opts.ledger !== undefined ? earlierUse(opts.ledger, opts.baseUrl, opts.key) : null
  if (earlier !== null && opts.freshKeyRequired === true) {
    throw refusal(earlier)
  }
  if (opts.arm === 'playbook') {
    // Asked before anything is written: a door started with the playbook off answers its paths as never served.
    const probe = await post('playbooks', {})
    if (!probe.ok && probe.error === 'status 404') {
      throw new Error(
        `the door answered 404 at ${new URL(urlOf('playbooks')).pathname}: start it with REACTOR_PLAYBOOK_DOOR=on to run the playbook arm`,
      )
    }
  }
  mkdirSync(opts.out, { recursive: true })
  const instances = opts.domain.instances(opts.seed, opts.days, words)
  const record: RunRecord = {
    benchmark: 'repeat-bill',
    version: '0.1',
    run_id: opts.runId,
    arm: opts.arm,
    domain: opts.domain.name,
    days: opts.days,
    tasks_per_day: opts.domain.templates.length,
    seed: opts.seed,
    words,
    large_model: opts.large,
    small_model: opts.small,
    base_url: publicUrl(opts.baseUrl),
    max_steps: maxSteps,
    timeout_seconds: timeoutSeconds,
    settle_seconds: settleSeconds,
    ...(opts.arm === 'playbook' ? { client: clientName, allow_model: allowModel, reply: askReply ? 'on' : 'off' } : {}),
    prices: {
      [opts.large]: { in_per_mtok: largePrice.in_per_mtok, out_per_mtok: largePrice.out_per_mtok },
      ...(opts.small === null || smallPrice === null
        ? {}
        : { [opts.small]: { in_per_mtok: smallPrice.in_per_mtok, out_per_mtok: smallPrice.out_per_mtok } }),
    },
    harness_commit: opts.harnessCommit,
    node: process.version,
    started_at: startedAt,
    finished_at: null,
    key_seen_before: checked ? earlier !== null : null,
    key_earlier_run_id: earlier?.run_id ?? null,
  }
  const writeRecord = (): void => writeFileSync(join(opts.out, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
  writeRecord()
  if (opts.arm !== 'plain' && opts.ledger !== undefined && earlier === null) {
    // Filed once the run is set up and before its first request: a run that stops after this still used the key.
    earlier = useKey(opts.ledger, opts.baseUrl, opts.key, {
      run_id: opts.runId,
      domain: opts.domain.name,
      at: startedAt,
    })
    // Another run filed this key since the lookup.
    if (earlier !== null) {
      if (opts.freshKeyRequired === true) {
        throw refusal(earlier)
      }
      record.key_seen_before = true
      record.key_earlier_run_id = earlier.run_id
      writeRecord()
    }
  }
  if (checked) {
    log(
      earlier === null
        ? 'the key ledger had not seen this Reactor key'
        : `the Reactor key was used by run ${earlier.run_id} before this run: day 1 is not cold`,
    )
  }
  const writeLine = (file: string, line: object): void =>
    appendFileSync(join(opts.out, file), `${JSON.stringify(line)}\n`)

  /** One chat request, with the run header the arm names; a 2xx that carries no message is refused. */
  const chatAnswer = async (messages: readonly Message[], run: string | null): Promise<Answer> => {
    const payload = { model: opts.large, messages, tools: opts.domain.tools, parallel_tool_calls: false }
    const answer =
      parsedProviderUrl === null
        ? await post('chat/completions', payload, run === null ? {} : { 'x-reactor-run': run })
        : await postTo(parsedProviderUrl, opts.providerKey ?? '', 'chat/completions', payload)
    return answer.ok && messageOf(answer.body) === undefined
      ? { ok: false, error: 'a 2xx response with no message', latencyMs: answer.latencyMs, retries: answer.retries }
      : answer
  }

  const ask = (inst: Instance, messages: Message[]): Promise<Answer> =>
    // One reactor run per task: a run is never served from what it taught itself.
    chatAnswer(messages, opts.arm === 'reactor' ? `${opts.runId}.${inst.id}` : null)

  /** Which model answered a response, what it reported using, and its price at that model. */
  const pricedResponse = (body: Record<string, unknown>) => {
    const model = typeof body.model === 'string' ? body.model : null
    const by = servedBy(model, opts.large, opts.small)
    const usage = asObject(body.usage)
    const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null
    const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null
    const reported = promptTokens !== null && completionTokens !== null
    // A step is priced at the model that answered it; one that names neither model is priced as the large one.
    const price = by === 'small' ? smallPrice : largePrice
    const cost = reported && price !== null ? costOf(price, promptTokens, completionTokens) : 0
    return { model, by, promptTokens, completionTokens, reported, cost }
  }

  // The engine's calls under the step, each at its own model: priced where the book has a line, else $0 and
  // counted, so a day's cost says what it leaves out.
  const overheadOf = (spent: readonly SpentCall[]): { overhead: number; overheadUnpriced: number } => {
    let overhead = 0
    let overheadUnpriced = 0
    for (const call of spent) {
      if (Object.hasOwn(opts.prices.models, call.model)) {
        overhead += costOf(priceOf(opts.prices, call.model), call.tokens_in, call.tokens_out)
      } else {
        overheadUnpriced += 1
      }
    }
    return { overhead, overheadUnpriced }
  }

  /**
   * The plain path: the large model asks, the task's tools answer, until it replies in words or the cap. Its lines are
   * numbered after `before` lines already written, and carry `route` when it is given (the playbook arm's lines do).
   */
  const chatLoop = async (
    inst: Instance,
    session: ReturnType<Instance['open']>,
    base: LineBase,
    before: number,
    startedAt: number,
    route?: 'chat/completions',
  ) => {
    const messages: Message[] = [
      { role: 'system', content: opts.domain.system },
      { role: 'user', content: inst.ask },
    ]
    const routed = route === undefined ? {} : { route }
    let reply: string | null = null
    let error: string | null = null
    let steps = 0
    let toolSteps = 0
    while (reply === null && error === null && steps < maxSteps) {
      const answer = await ask(inst, messages)
      steps += 1
      if (!answer.ok) {
        error = answer.error
        writeLine('steps.jsonl', {
          ...base,
          step: before + steps,
          kind: 'error',
          tool: null,
          tool_calls: 0,
          served_by: null,
          response_model: null,
          prompt_tokens: null,
          completion_tokens: null,
          usage_reported: false,
          latency_ms: answer.latencyMs,
          retries: answer.retries,
          cost_usd: 0,
          ...routed,
          at_ms: Math.round(performance.now() - startedAt),
          error,
        } satisfies StepLine)
        break
      }
      const message = messageOf(answer.body) ?? {}
      const calls = toolCallsIn(message)
      const { model, by, promptTokens, completionTokens, reported, cost } = pricedResponse(answer.body)
      const { overhead, overheadUnpriced } = overheadOf(answer.spent)
      const kind = calls.length > 0 ? 'tool' : 'talk'
      // Each call is made before its line is written, so the line can count the ones the tool itself refused.
      const results = calls.map((c) => session.call(c.name, parseArguments(c.arguments)))
      writeLine('steps.jsonl', {
        ...base,
        step: before + steps,
        kind,
        tool: calls.length > 0 ? calls.map((c) => c.name).join(',') : null,
        tool_calls: calls.length,
        served_by: by,
        response_model: model,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        usage_reported: reported,
        latency_ms: answer.latencyMs,
        retries: answer.retries,
        cost_usd: cost,
        overhead_usd: overhead,
        overhead_unpriced: overheadUnpriced,
        tool_failures: results.filter(toolFailed).length,
        ...routed,
        at_ms: Math.round(performance.now() - startedAt),
        error: null,
      } satisfies StepLine)
      if (kind === 'talk') {
        reply = typeof message.content === 'string' ? message.content : ''
        break
      }
      toolSteps += 1
      messages.push({
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : '{}' },
        })),
      })
      for (const [i, c] of calls.entries()) {
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(results[i]) })
      }
    }
    const capped = reply === null && error === null
    const check = error === null ? session.check(reply ?? '') : { pass: false, reason: error }
    return {
      // A task that never answered fails, whatever state it left behind.
      passed: !capped && check.pass,
      reason: capped ? `no reply within ${maxSteps} steps${check.pass ? '' : `; ${check.reason}`}` : check.reason,
      steps,
      tool_steps: toolSteps,
      capped,
    }
  }

  const runTask = async (inst: Instance): Promise<TaskLine> => {
    const session = inst.open()
    const started = performance.now()
    const base = {
      run_id: opts.runId,
      arm: opts.arm,
      domain: opts.domain.name,
      day: inst.day,
      instance: inst.id,
      template: inst.template,
    }
    const played = await chatLoop(inst, session, base, 0, started)
    return {
      ...base,
      form: inst.form,
      ...played,
      seconds: Math.round(performance.now() - started) / 1000,
    }
  }

  const overheadOfLine = (spent: readonly SpentCall[]): { overhead_usd: number; overhead_unpriced: number } => {
    const { overhead, overheadUnpriced } = overheadOf(spent)
    return { overhead_usd: overhead, overhead_unpriced: overheadUnpriced }
  }

  /** A line for one thing the playbook client did: a door answer, a tool call, or the reply call. */
  const playbookLine = (base: LineBase, step: number, event: Event): StepLine => {
    const blank = {
      ...base,
      step,
      tool: null,
      tool_calls: 0,
      served_by: null,
      response_model: null,
      prompt_tokens: null,
      completion_tokens: null,
      usage_reported: false,
    }
    if (event.kind === 'tool') {
      return {
        ...blank,
        kind: 'tool',
        tool: event.tool,
        tool_calls: 1,
        served_by: filledOn(event),
        latency_ms: 0,
        retries: 0,
        cost_usd: 0,
        overhead_usd: 0,
        overhead_unpriced: 0,
        tool_failures: event.shape === 'failed' ? 1 : 0,
        filled_by: event.filled_by,
        ...(event.refused === undefined ? {} : { refused: event.refused }),
        error: null,
      } satisfies StepLine
    }
    const answer = event.kind === 'door' ? event.answer : event.reply.answer
    const route =
      event.kind === 'door' ? event.route : event.reply.viaPass === true ? 'playbooks/pass' : 'chat/completions'
    if (!answer.ok) {
      return {
        ...blank,
        kind: 'error',
        latency_ms: answer.latencyMs,
        retries: answer.retries,
        cost_usd: 0,
        route,
        error: answer.error,
      } satisfies StepLine
    }
    if (event.kind === 'door') {
      const spent = doorSpent(answer)
      // The route whose verdict this line carries: its own, or the one a round of the library's settled.
      const verdictOf = event.settles ?? event.route
      // A fill the door's model made is costed here: whom it names, and whether every call it spent is priced.
      const filler = verdictOf === 'playbooks/fill' && event.said === 'filled' ? answer.body.filled_by : undefined
      const reason = verdictOf === 'playbooks/fill' || verdictOf === 'playbooks/reply' ? answer.body.reason : undefined
      const ran = event.ran
      // A round the runner ran: priced at the model it ran on, from the count the library posted with the words.
      const ranPrice = ran === undefined ? null : ran.model === 'small' ? smallPrice : largePrice
      // A pass that served the agent's call names who wrote it; the model's cost is on the rounds' lines.
      const passServed = event.route === 'playbooks/pass' && answer.body.kind === 'served'
      return {
        ...blank,
        kind: 'door',
        served_by:
          ran !== undefined
            ? ran.model
            : passServed
              ? answer.body.filled_by === 'small'
                ? 'small'
                : null
              : filler === 'small' || filler === 'large'
                ? filler
                : filler === null
                  ? 'other'
                  : null,
        usage_reported:
          ran !== undefined
            ? ran.usage !== null
            : passServed || (spent.length > 0 && overheadOf(spent).overheadUnpriced === 0),
        latency_ms: answer.latencyMs,
        retries: answer.retries,
        cost_usd:
          ran?.usage != null && ranPrice !== null ? costOf(ranPrice, ran.usage.tokens_in, ran.usage.tokens_out) : 0,
        ...overheadOfLine(spent),
        tool_failures: 0,
        route,
        said: event.said,
        ...(event.settles === undefined ? {} : { settles: event.settles }),
        ...(typeof reason === 'string' ? { reason } : {}),
        error: null,
      } satisfies StepLine
    }
    const asked = event.reply.kind === 'tools' ? event.reply.tools : []
    if (event.reply.kind !== 'error' && event.reply.served !== undefined) {
      // The door's pass served this call: its line was written for the pass, and the step is the door's.
      return {
        ...blank,
        kind: asked.length > 0 ? 'tool' : 'talk',
        tool: asked.length > 0 ? asked.join(',') : null,
        tool_calls: asked.length,
        served_by: event.reply.served === 'small' ? 'small' : null,
        usage_reported: true,
        latency_ms: 0,
        retries: 0,
        cost_usd: 0,
        overhead_usd: 0,
        overhead_unpriced: 0,
        tool_failures: event.failures ?? 0,
        route,
        error: null,
      } satisfies StepLine
    }
    const priced = pricedResponse(answer.body)
    return {
      ...blank,
      // The agent's call: a tool step when it made tool calls, which the task's tools answered; talk when it replied.
      kind: asked.length > 0 ? 'tool' : 'talk',
      tool: asked.length > 0 ? asked.join(',') : null,
      tool_calls: asked.length,
      served_by: priced.by,
      response_model: priced.model,
      prompt_tokens: priced.promptTokens,
      completion_tokens: priced.completionTokens,
      usage_reported: priced.reported,
      latency_ms: answer.latencyMs,
      retries: answer.retries,
      cost_usd: priced.cost,
      ...overheadOfLine(answer.spent),
      tool_failures: event.failures ?? 0,
      route,
      error: null,
    } satisfies StepLine
  }

  const runJob = async (inst: Instance): Promise<TaskLine> => {
    const session = inst.open()
    const started = performance.now()
    const base: LineBase = {
      run_id: opts.runId,
      arm: opts.arm,
      domain: opts.domain.name,
      day: inst.day,
      instance: inst.id,
      template: inst.template,
    }
    // One job per task, named as the reactor arm names one run per task.
    const jobId = `${opts.runId}.${inst.id}`
    const trace = await CLIENTS[clientName](
      {
        ask: inst.ask,
        tools: opts.domain.tools,
        jobId,
        allowModel,
        reply: askReply,
        messages: [
          { role: 'system', content: opts.domain.system },
          { role: 'user', content: inst.ask },
        ],
        maxSteps,
      },
      {
        post: (route, payload, extra) => post(route, payload, extra),
        ...(library && opts.providerUrl !== undefined && opts.providerKey !== undefined && opts.small !== null
          ? {
              runner: createOpenAIRunner({
                baseUrl: opts.providerUrl,
                key: opts.providerKey,
                small: opts.small,
                large: opts.large,
              }),
              providerKey: opts.providerKey,
              large: opts.large,
            }
          : {}),
        chat: async (messages): Promise<Reply> => {
          const answer = await chatAnswer(messages, jobId)
          if (!answer.ok) {
            return { kind: 'error', error: answer.error, answer }
          }
          const message = messageOf(answer.body) ?? {}
          const asked = toolCallsIn(message)
          const by = pricedResponse(answer.body).by
          return asked.length > 0
            ? {
                kind: 'tools',
                tools: asked.map((c) => c.name),
                calls: asked.map((c) => ({
                  id: c.id,
                  name: c.name,
                  arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
                })),
                by,
                answer,
              }
            : { kind: 'words', words: typeof message.content === 'string' ? message.content : '', by, answer }
        },
        call: (tool, args) => session.call(tool, args),
        failed: toolFailed,
        nonce: () => randomUUID().slice(0, 8),
        now: () => new Date().toISOString(),
      },
    )
    for (const [i, event] of trace.events.entries()) {
      const at = stampOf(event)
      writeLine('steps.jsonl', {
        ...playbookLine(base, i + 1, event),
        ...(at === undefined ? {} : { at_ms: Math.max(0, Math.round(at - started)) }),
      })
    }
    if (trace.ended === 'plain') {
      // A job the door could not plan runs as the plain arm runs it, under no run: the large model's, with no saving.
      const played = await chatLoop(inst, session, base, trace.events.length, started, 'chat/completions')
      return {
        ...base,
        form: inst.form,
        ...played,
        steps: trace.events.length + played.steps,
        seconds: Math.round(performance.now() - started) / 1000,
        step_line: stepLineOf(trace),
        ended: 'plain',
        reported: false,
      }
    }
    const check = trace.reply === null ? null : session.check(trace.reply)
    return {
      ...base,
      form: inst.form,
      // A job that ended with no reply in words fails, as a chat task that never answered does.
      passed: check !== null && !trace.capped && check.pass,
      reason: check === null ? `${trace.ended}: ${trace.why ?? 'no reason given'}` : check.reason,
      steps: trace.events.length,
      tool_steps: trace.events.filter((e) => e.kind === 'tool').length,
      capped: trace.capped,
      seconds: Math.round(performance.now() - started) / 1000,
      step_line: stepLineOf(trace),
      ended: trace.ended,
      reported: trace.reported,
    }
  }

  for (let day = 1; day <= opts.days; day++) {
    if (day > 1 && settleSeconds > 0) {
      log(`waiting ${settleSeconds} s so day ${day - 1} is learned before day ${day}`)
      await sleep(settleSeconds * 1000)
    }
    for (const inst of instances.filter((i) => i.day === day)) {
      const task = opts.arm === 'playbook' ? await runJob(inst) : await runTask(inst)
      writeLine('tasks.jsonl', task)
      log(`day ${day} ${inst.template}: ${task.passed ? 'pass' : 'fail'} in ${task.steps} steps`)
    }
  }
  record.finished_at = new Date().toISOString()
  writeRecord()
  return record
}
