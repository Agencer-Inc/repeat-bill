/**
 * The playbook library as a bench client: `@agencer/reactor`'s own loop, run over the harness's posts and tools, and
 * its steps written as the bare client writes them, so the two run the same arm and score the same way. The library
 * is what a customer installs; this file only lends it the harness's seams (the posts with their retries and their
 * `spent`, the domain's tools, the reply call) and reads its run back into a Trace.
 */
import {
  createClient,
  fingerprintOf,
  readFill,
  readPass,
  readPlaybook,
  readReply,
  readRunModel,
  runPlaybook,
} from '@agencer/reactor'
import { settleRounds } from '@agencer/reactor'
import type { Answer as LibraryAnswer, Client, ReportBody, Route } from '@agencer/reactor'
import type { Answer } from './run.ts'
import { agentTurns, clockedEvents, restamp, UNPLANNED } from './playbook-client.ts'
import type { Deps, Job, Reply, Report, Route as LineRoute, Trace } from './playbook-client.ts'

/** The library's answer from the harness's own: the body, or the error the harness named. */
const asLibrary = (answer: Answer): LibraryAnswer =>
  answer.ok ? { ok: true, status: 200, body: answer.body } : { ok: false, error: answer.error }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The route a library path is recorded under: its name, with no job id in it. */
const routeOf = (path: Route): LineRoute =>
  path === 'playbooks' || path === 'playbooks/fill' || path === 'playbooks/report' || path === 'playbooks/check'
    ? path
    : path.endsWith('/answer')
      ? 'playbooks/answer'
      : path.endsWith('/pass')
        ? 'playbooks/pass'
        : 'playbooks/reply'

/** The agent's reply as a chat completion the door served reads: words, or the tool calls it asks for. */
const replyOf = (completion: Record<string, unknown>, served: 'small' | 'none', answer: Answer): Reply => {
  const choice: unknown = Array.isArray(completion.choices) ? completion.choices[0] : undefined
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {}
  const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap((c: unknown) => {
    const fn = isRecord(c) && isRecord(c.function) ? c.function : undefined
    return isRecord(c) && fn !== undefined && typeof fn.name === 'string'
      ? [
          {
            id: String(c.id ?? ''),
            name: fn.name,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          },
        ]
      : []
  })
  return calls.length > 0
    ? { kind: 'tools', tools: calls.map((c) => c.name), calls, by: served, answer, served }
    : { kind: 'words', words: typeof message.content === 'string' ? message.content : '', by: served, answer, served }
}

export const playJobWithLibrary = async (job: Job, deps: Deps): Promise<Trace> => {
  const events = clockedEvents()
  let report: Report | null = null
  let reported = false

  // The one thing of the provider key the door sees: its fingerprint, on every post, as the library's own client sends it.
  const fingerprint: Record<string, string> =
    deps.providerKey === undefined ? {} : { 'x-reactor-provider-fingerprint': fingerprintOf(deps.providerKey) }
  // The model each token's round was asked on, so the answer's line is priced at the model the runner used.
  const askedOn = new Map<string, 'small' | 'large'>()
  // The route and step each token's round was asked for, so the round that settles it is recorded as that route's
  // verdict: the first post says only run_model, and the 2026-11-04 rerun's table read null on both lines.
  const parkedFor = new Map<string, { route: LineRoute; step_no: number | null; tool: string | null }>()
  // The door's last answer, whole, for the agent's step a pass served.
  const last: { door: Answer | null } = { door: null }

  /** What a route's answer said: a fill's or a reply's kind, a playbook's source, a pass's verdict. */
  const saidBy = (route: LineRoute, body: Record<string, unknown>): string | null =>
    route === 'playbooks/fill'
      ? (readFill(body)?.kind ?? null)
      : route === 'playbooks/reply'
        ? (readReply(body)?.kind ?? null)
        : route === 'playbooks'
          ? (readPlaybook(body)?.source ?? null)
          : route === 'playbooks/pass'
            ? typeof body.kind === 'string'
              ? body.kind
              : null
            : null

  const post = async (path: Route, body: unknown, headers?: Record<string, string>): Promise<LibraryAnswer> => {
    const answer = await deps.post(path, body, { ...fingerprint, ...headers })
    last.door = answer
    const route = routeOf(path)
    const asked = answer.ok ? readRunModel(answer.body) : null
    const round = route === 'playbooks/answer' ? (body as { token?: unknown; usage?: unknown }) : null
    const step = route === 'playbooks/fill' ? (body as { step_no: number; step: { tool: string } }) : null
    const parked = round === null ? undefined : parkedFor.get(String(round.token))
    const owner = parked ?? { route, step_no: step?.step_no ?? null, tool: step?.step.tool ?? null }
    if (asked !== null) {
      askedOn.set(asked.token, asked.model)
      parkedFor.set(asked.token, owner)
    }
    const usage = isRecord(round?.usage) ? round.usage : null
    const ran =
      round === null
        ? undefined
        : {
            model: askedOn.get(String(round.token)) ?? ('large' as const),
            usage:
              usage !== null && typeof usage.tokens_in === 'number' && typeof usage.tokens_out === 'number'
                ? { tokens_in: usage.tokens_in, tokens_out: usage.tokens_out }
                : null,
          }
    // A round that settled the route it was asked for carries that route's verdict, under its step.
    const settled = answer.ok && asked === null ? parked : undefined
    const said = !answer.ok ? null : asked !== null ? 'run_model' : saidBy(settled?.route ?? route, answer.body)
    events.push({
      kind: 'door',
      route,
      step_no: settled?.step_no ?? step?.step_no ?? null,
      tool: settled?.tool ?? step?.step.tool ?? null,
      answer,
      said,
      ...(ran === undefined ? {} : { ran }),
      ...(settled === undefined ? {} : { settles: settled.route }),
    })
    if (route === 'playbooks/report') {
      report = body as Report
      reported = answer.ok
    }
    return asLibrary(answer)
  }
  const client: Client = {
    ...createClient({ baseUrl: 'http://unused.invalid/v1', key: 'unused' }),
    playbook: ({ ask, tools, jobId }) =>
      post('playbooks', { ask, tools }, jobId === undefined ? {} : { 'x-reactor-run': jobId }),
    fill: (request) => post('playbooks/fill', request),
    report: (body: ReportBody) => post('playbooks/report', body),
    reply: (jobId, request) => post(`playbooks/${encodeURIComponent(jobId)}/reply`, request),
    answer: (jobId, answered) => post(`playbooks/${encodeURIComponent(jobId)}/answer`, answered),
    pass: (jobId, request) => post(`playbooks/${encodeURIComponent(jobId)}/pass`, request),
    check: () => post('playbooks/check', {}),
  }

  // Each call's event is placed when the call is made and read back from the run once it ends, so the trace keeps the
  // order the bare client writes: a step's fill, then its call.
  const placed: number[] = []
  // What each call sent and got, kept so a refused call's line can say what was sent, as the bare client's does.
  const made: { args: Record<string, string>; result: unknown }[] = []
  const run = await runPlaybook({
    client,
    ask: job.ask,
    tools: job.tools,
    call: (tool, args) => {
      placed.push(events.length)
      events.push({ kind: 'tool', step_no: 0, tool, by: 'client', filled_by: null, model: 'none', shape: 'ok' })
      const result = deps.call(tool, args)
      made.push({ args, result })
      return result
    },
    failed: deps.failed,
    allowModel: job.allowModel,
    maxSteps: job.maxSteps,
    jobId: job.jobId,
    ...(job.messages[0]?.role === 'system' && typeof job.messages[0].content === 'string'
      ? { system: job.messages[0].content }
      : {}),
    ...(deps.runner === undefined ? {} : { model: deps.runner }),
    nonce: deps.nonce,
    now: deps.now,
  })
  for (const [i, at] of placed.entries()) {
    const step = run.steps[i]
    if (step === undefined) {
      continue
    }
    const filledByDoor = events.some(
      (e, j) =>
        j < at &&
        e.kind === 'door' &&
        e.route === 'playbooks/fill' &&
        e.step_no === step.step_no &&
        e.said === 'filled',
    )
    events[at] = restamp(events[at], {
      kind: 'tool',
      step_no: step.step_no,
      tool: step.tool,
      by: filledByDoor ? 'door' : 'client',
      filled_by: step.filled_by,
      model: step.model,
      shape: step.result_shape,
      ...(step.result_shape === 'failed' && made[i] !== undefined
        ? { refused: { call: made[i].args, error: String((made[i].result as { error?: unknown }).error) } }
        : {}),
    })
  }
  job.messages.push(...(run.messages as Job['messages']))

  const trace = (ended: Trace['ended'], why: string | null, reply: string | null): Trace => ({
    job_id: run.job_id ?? job.jobId,
    events,
    ended,
    why,
    reply,
    capped: run.capped,
    report,
    reported,
  })
  if (run.status !== 'ready') {
    return trace(run.status, run.why, null)
  }
  // The door could not plan the job: as the bare client does, hand it to the plain path, its run left unreported.
  const asked = events.find((e) => e.kind === 'door' && e.route === 'playbooks')
  const playbook = asked?.kind === 'door' && asked.answer.ok ? readPlaybook(asked.answer.body) : null
  if (playbook !== null && playbook.needs_model && playbook.steps.length === 0) {
    return trace('plain', UNPLANNED, null)
  }
  // A playbook that ran to its end asks the door for the reply; words end the job, anything else is the agent's turn.
  if (job.reply === true && run.next === null) {
    const replied = await run.reply()
    if (replied.kind === 'words') {
      await run.report('done')
      return trace('done', null, replied.text)
    }
  }
  // The job is the agent's now, as the library hands a ready run back: it goes on as the bare client's agent does.
  // The agent's own calls go through pass first: the door's completion when it served one, else the agent's chat.
  const jobIdOf = (): string => run.job_id ?? job.jobId
  const passed: Deps = {
    ...deps,
    chat: async (messages) => {
      const first = await client.pass(jobIdOf(), {
        messages: messages as unknown as Record<string, unknown>[],
        tools: job.tools as Record<string, unknown>[],
        model: deps.large ?? 'large',
      })
      const stepNo = first.ok && Number.isInteger(first.body.step_no) ? (first.body.step_no as number) : 0
      const settled = await settleRounds(client, first, { jobOf: jobIdOf, stepNo, model: deps.runner })
      const read = settled.handedBack === null && settled.answer.ok ? readPass(settled.answer.body) : null
      if (read?.kind === 'served' && last.door !== null && last.door.ok) {
        return { ...replyOf(read.answer, read.filled_by === 'small' ? 'small' : 'none', last.door), viaPass: true }
      }
      return { ...(await deps.chat(messages)), viaPass: true }
    },
  }
  const turn = await agentTurns(job, passed, events, run.steps.length, run.record)
  if (turn.kind === 'error') {
    await run.report('abandoned')
    return trace('abandoned', turn.error, null)
  }
  if (turn.kind === 'capped') {
    await run.report('stopped')
    return { ...trace('stopped', 'the step cap', null), capped: true }
  }
  await run.report('done')
  return trace('done', null, turn.words)
}
