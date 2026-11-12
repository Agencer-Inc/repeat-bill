/**
 * The bare playbook client: a test-grade stand-in for the customer's playbook library, never published and never
 * imported by src/. The seam: a client is a function of `playJob`'s shape, listed by name in CLIENTS in run.ts and
 * picked with --client; the library plugs in there under a name of its own, returning the same Trace.
 */
import type { ModelRunner } from '@agencer/reactor'
import type { Answer } from './run.ts'

/** Who filled a step: the ask, an earlier result, the small model or the large one; null for nobody named. */
export type FilledBy = 'ask' | 'result' | 'small' | 'large' | null

/** The door's records, copied from its seam records by hand: bench/ imports nothing from src/. */
export interface Blank {
  name: string
  value: string | null
  local: boolean
  filled_by: 'ask' | 'result' | 'model' | null
  from?: { step_no: number; path: string }
}

export interface Step {
  step_no: number
  tool: string
  blanks: Blank[]
}

export type FillKind = 'filled' | 'needs_model' | 'stop' | 'done'

export type Ended = 'done' | 'stopped' | 'abandoned'

/** Why a job the door could not plan (needs_model, no steps) went to the plain path. */
export const UNPLANNED = 'the door could not plan the job'

export type Shape = 'ok' | 'empty' | 'failed'

export type Model = 'none' | 'small' | 'large'

export type Route =
  | 'playbooks'
  | 'playbooks/fill'
  | 'playbooks/report'
  | 'playbooks/reply'
  | 'playbooks/pass'
  | 'playbooks/answer'
  | 'playbooks/check'

/** The reply route's path: the job's id, encoded, between. */
export const replyPath = (jobId: string): JobPath => `playbooks/${encodeURIComponent(jobId)}/reply`

/** A path under a job's id, as the library posts it: the reply, answer and pass routes. */
export type JobPath = `playbooks/${string}/${'reply' | 'answer' | 'pass'}`

/** A message of the transcript, OpenAI-shaped, as the chat arm sends it. */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** A tool call a chat answer asked for, its arguments as the JSON text the model wrote. */
export interface AskedCall {
  id: string
  name: string
  arguments: string
}

/**
 * What a chat call came back with: words, tool calls, or why it failed; `by` is the model it named. `served` is set
 * when the door's pass route wrote it, and names who did: the small model, or none (a result the door already had).
 */
export type Reply = (
  | { kind: 'words'; words: string; by: string; answer: Answer; served?: 'small' | 'none' }
  | { kind: 'tools'; tools: string[]; calls: AskedCall[]; by: string; answer: Answer; served?: 'small' | 'none' }
  | { kind: 'error'; error: string; answer: Answer }
) & {
  /** Set when a pass line preceded this call, served or handed back; its line is then on the pass route. */
  viaPass?: true
}

export interface Deps {
  /** Sends a body to a route under the base URL, with the harness's own retries; a reply's path names its job. */
  post: (
    route: Extract<Route, 'playbooks' | 'playbooks/fill' | 'playbooks/report' | 'playbooks/check'> | JobPath,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<Answer>
  /** One chat call of the customer's agent with the transcript so far: words, or the tool calls it makes next. */
  chat: (messages: readonly Message[]) => Promise<Reply>
  /**
   * On the library client: runs a prompt the door asked run, on the customer's provider (`createOpenAIRunner`). The
   * provider key is only its fingerprint on the library's posts (`providerKey`); `large` is the model the agent names.
   */
  runner?: ModelRunner
  providerKey?: string
  large?: string
  call: (tool: string, args: Record<string, string>) => unknown
  /** Whether a result is the tool's own refusal. */
  failed: (result: unknown) => boolean
  nonce: () => string
  now: () => string
}

export interface Job {
  ask: string
  tools: readonly unknown[]
  /** Sent as x-reactor-run, so the job is the run the door names it. */
  jobId: string
  allowModel: boolean
  /** The transcript so far, the system message and the ask; each step called is appended to it. */
  messages: Message[]
  maxSteps: number
  /** Whether the job asks the door for its final reply once its playbook ran to its end (2026-10-28); off unless set. */
  reply?: boolean
}

/**
 * When each event happened, by `performance.now()`, kept beside the events rather than in them so a trace still
 * compares as it did. `clockedEvents` stamps an event as it is pushed; `stampOf` reads it (2026-11-09).
 */
const STAMPS = new WeakMap<object, number>()

export const stampOf = (event: Event): number | undefined => STAMPS.get(event)

/** Stamps `next` with the moment `was` was stamped: an event filled in later keeps the time it happened. */
export const restamp = <T extends Event>(was: Event | undefined, next: T): T => {
  const at = was === undefined ? undefined : STAMPS.get(was)
  STAMPS.set(next, at ?? performance.now())
  return next
}

/** An event list whose `push` stamps each event, once, with the moment it was pushed. */
export const clockedEvents = (): Event[] => {
  const list: Event[] = []
  const push = list.push.bind(list)
  list.push = (...items: Event[]): number => {
    const now = performance.now()
    for (const item of items) {
      if (!STAMPS.has(item)) {
        STAMPS.set(item, now)
      }
    }
    return push(...items)
  }
  return list
}

export type Event =
  | {
      kind: 'door'
      route: Route
      step_no: number | null
      tool: string | null
      answer: Answer
      said: string | null
      /** On an answer route's line: the model the runner ran the round on, and the count it gave, if it gave one. */
      ran?: { model: 'small' | 'large'; usage: { tokens_in: number; tokens_out: number } | null }
      /** On a round's line that settled a route's answer: that route, whose verdict `said` then is (2026-11-04). */
      settles?: Route
    }
  | {
      kind: 'tool'
      step_no: number
      tool: string
      by: 'client' | 'door'
      filled_by: FilledBy
      model: Model
      shape: Shape
      /** On a failed shape: the call as it was sent and the tool's words refusing it, so a record can say what was wrong. */
      refused?: { call: Record<string, string>; error: string }
    }
  /** A chat call of the agent's; for tool calls, how many of them the tools refused. */
  | { kind: 'reply'; reply: Reply; failures?: number }

export interface ReportStep {
  step_no: number
  tool: string
  filled_by: FilledBy
  result_shape: Shape
  verified: boolean
  model: Model
  /** The arguments the tool was called with, or the first CALL_BYTES of their JSON when it is longer. */
  call?: Record<string, string> | string
  call_truncated?: boolean
  /** The result as it came back, or the first RESULT_BYTES of its JSON when it is longer. */
  result?: unknown
  truncated?: boolean
  /** On the job's reply, last, its words: it carries no call, and its tool is ''. */
  reply?: string
}

/** How a job ended, with what the door needs to count each step as the plain agent would have sent it. */
export interface Report {
  job_id: string
  pass_id: string
  ended: Ended
  reported_at: string
  ask: string
  ask_truncated: boolean
  /** The transcript's system message; absent when the job had none. */
  system?: string
  system_truncated?: boolean
  /** The tools as the job declared them; left out, and flagged, when their JSON is over TOOLS_BYTES. */
  tools?: unknown
  tools_truncated: boolean
  /** The first REPORT_STEPS steps the client called. */
  steps: ReportStep[]
  steps_truncated: boolean
}

export interface Trace {
  job_id: string
  events: Event[]
  /** How the job ended, or plain when the door could not plan it and the arm runs it on the plain path. */
  ended: Ended | 'plain'
  /** Why the job stopped, was abandoned or went plain; null when it ended done. */
  why: string | null
  reply: string | null
  capped: boolean
  /** The report sent; null for a job handed to the plain path, which runs no step to report. */
  report: Report | null
  reported: boolean
}

/** The most of each field a report carries, in bytes (of the text, or of the JSON), and the most steps; the door refuses more. */
export const RESULT_BYTES = 8192
export const CALL_BYTES = 4096
export const ASK_BYTES = 16_384
export const SYSTEM_BYTES = 16_384
export const TOOLS_BYTES = 65_536
export const REPORT_STEPS = 64
export const REPLY_BYTES = 16_384

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const BLANK_FILLERS: readonly unknown[] = ['ask', 'result', 'model', null]
const FILLED_BY: readonly unknown[] = ['ask', 'result', 'small', 'large', null]
const KINDS: readonly unknown[] = ['filled', 'needs_model', 'stop', 'done']

const readBlank = (value: unknown): Blank | null => {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.local !== 'boolean') {
    return null
  }
  if ((value.value !== null && typeof value.value !== 'string') || !BLANK_FILLERS.includes(value.filled_by)) {
    return null
  }
  const from = value.from
  if (from !== undefined && !(isRecord(from) && Number.isInteger(from.step_no) && typeof from.path === 'string')) {
    return null
  }
  return {
    name: value.name,
    value: value.value,
    local: value.local,
    filled_by: value.filled_by as Blank['filled_by'],
    ...(from === undefined ? {} : { from: { step_no: from.step_no as number, path: from.path as string } }),
  }
}

const readStep = (value: unknown): Step | null => {
  if (!isRecord(value) || !Number.isInteger(value.step_no) || typeof value.tool !== 'string') {
    return null
  }
  const blanks = Array.isArray(value.blanks) ? value.blanks.map(readBlank) : [null]
  return blanks.every((b): b is Blank => b !== null)
    ? { step_no: value.step_no as number, tool: value.tool, blanks }
    : null
}

/** A playbook answer's job id, whether it needs a model, and its steps, or null for an answer that does not read as one. */
const readPlaybook = (
  body: Record<string, unknown>,
): { job_id: string; needs_model: boolean; source: string; steps: Step[] } | null => {
  const steps = Array.isArray(body.steps) ? body.steps.map(readStep) : [null]
  return typeof body.job_id === 'string' && steps.every((s): s is Step => s !== null)
    ? {
        job_id: body.job_id,
        needs_model: body.needs_model === true,
        source: typeof body.source === 'string' ? body.source : 'none',
        steps,
      }
    : null
}

/** A fill answer's kind, its step when filled, and who filled it; null for an answer that does not read as one. */
/** A reply answer: words with their text, or a model needed; null for one that reads as neither. */
export const readReply = (
  body: Record<string, unknown>,
): { kind: 'words'; text: string } | { kind: 'needs_model' } | null =>
  body.kind === 'words' && typeof body.text === 'string'
    ? { kind: 'words', text: body.text }
    : body.kind === 'needs_model'
      ? { kind: 'needs_model' }
      : null

const readFill = (body: Record<string, unknown>): { kind: FillKind; step: Step | null; filled_by: FilledBy } | null => {
  if (!KINDS.includes(body.kind) || !FILLED_BY.includes(body.filled_by)) {
    return null
  }
  const step = body.kind === 'filled' ? readStep(body.step) : null
  return body.kind === 'filled' && step === null
    ? null
    : { kind: body.kind as FillKind, step, filled_by: body.filled_by as FilledBy }
}

interface Called {
  step_no: number
  tool: string
  result: unknown
  /** The arguments that produced the result, so the fill entrance can check a fill against what was called. */
  call: Record<string, string>
}

/**
 * A local blank's value by the two rules, or null: its ask value already in place, or a string read at its key from
 * the result of an earlier step whose tool has been called exactly once in this job.
 */
const localValue = (blank: Blank, called: readonly Called[]): { value: string; by: 'ask' | 'result' } | null => {
  if (!blank.local) {
    return null
  }
  if (blank.filled_by === 'ask' && typeof blank.value === 'string' && blank.value.trim() !== '') {
    return { value: blank.value, by: 'ask' }
  }
  const from = blank.from
  if (blank.value !== null || from === undefined) {
    return null
  }
  const source = called.find((c) => c.step_no === from.step_no)
  if (source === undefined || called.filter((c) => c.tool === source.tool).length !== 1) {
    return null
  }
  const held = isRecord(source.result) && Object.hasOwn(source.result, from.path) ? source.result[from.path] : undefined
  return typeof held === 'string' && held.trim() !== '' ? { value: held, by: 'result' } : null
}

/** The step with every blank the two rules fill filled, and whether that was all of them. */
const fillLocally = (step: Step, called: readonly Called[]): { step: Step; whole: boolean; by: FilledBy } => {
  let whole = true
  let by: FilledBy = null
  const blanks = step.blanks.map((blank) => {
    const local = localValue(blank, called)
    if (local === null) {
      whole = false
      return blank
    }
    by = by === 'result' ? by : local.by
    return { ...blank, value: local.value, filled_by: local.by }
  })
  return { step: { ...step, blanks }, whole, by }
}

/** Whether a filled step is the act the playbook named: its tool and number, with every blank given a value. */
const names = (step: Step, filled: Step): boolean =>
  filled.tool === step.tool &&
  filled.step_no === step.step_no &&
  filled.blanks.every((b) => typeof b.value === 'string')

const emptyResult = (result: unknown): boolean =>
  result === null ||
  result === undefined ||
  result === '' ||
  (Array.isArray(result) && result.length === 0) ||
  (isRecord(result) && Object.keys(result).length === 0)

/** What a byte cut leaves when it splits a character: U+FFFD, once or more, at the end. */
const SPLIT = new RegExp(`${String.fromCharCode(0xfffd)}+$`)

/** Text as a report carries it: whole, or its first `bytes` bytes with a character the cut split dropped. */
const cutText = (text: string, bytes: number): { text: string; truncated: boolean } =>
  Buffer.byteLength(text) <= bytes
    ? { text, truncated: false }
    : { text: Buffer.from(text).subarray(0, bytes).toString('utf8').replace(SPLIT, ''), truncated: true }

/** A value as a report carries it: whole, or its JSON cut as cutText cuts text. */
/**
 * A value whole when its JSON text fits `bytes`; else the first bytes of that text, as a string whose own JSON text,
 * quotes and escapes counted, still fits, since the door measures what it receives. As the library cuts.
 */
const cutJson = (value: unknown, bytes: number): { value: unknown; truncated: boolean } => {
  const json = cutText(JSON.stringify(value) ?? 'null', bytes)
  if (!json.truncated) {
    return { value, truncated: false }
  }
  let text = json.text
  for (;;) {
    const raw = Buffer.byteLength(text)
    const over = Buffer.byteLength(JSON.stringify(text)) - bytes
    if (over <= 0) {
      return { value: text, truncated: true }
    }
    text = cutText(text, raw - Math.max(1, Math.floor((over * raw) / (raw + over)))).text
  }
}

/** The most a tool's name may be in a report, in characters: the door refuses a longer one. */
const TOOL_CHARACTERS = 256

/** Runs one job through the playbook door: the playbook, each step filled locally or by the door, the reply, the report. */
export const playJob = async (job: Job, deps: Deps): Promise<Trace> => {
  const events = clockedEvents()
  const called: Called[] = []
  const steps: ReportStep[] = []
  let jobId = job.jobId
  let reply: string | null = null
  let capped = false
  // Whether the door handed a step back as needs_model: the agent makes it, and its own reply follows.
  let handedBack = false
  // Read before any step is appended: the transcript starts with the system message and the ask.
  const system = job.messages.find((m) => m.role === 'system')?.content ?? null

  const end = async (ended: Ended, why: string | null): Promise<Trace> => {
    const ask = cutText(job.ask, ASK_BYTES)
    const cutSystem = system === null ? null : cutText(system, SYSTEM_BYTES)
    const tools = cutJson(job.tools, TOOLS_BYTES)
    // Built once, so a retry of the post sends the same pass_id.
    const report: Report = {
      job_id: jobId,
      pass_id: `${jobId}.${deps.nonce()}`,
      ended,
      reported_at: deps.now(),
      ask: ask.text,
      ask_truncated: ask.truncated,
      ...(cutSystem === null ? {} : { system: cutSystem.text, system_truncated: cutSystem.truncated }),
      ...(tools.truncated ? {} : { tools: tools.value }),
      tools_truncated: tools.truncated,
      // The first REPORT_STEPS, the job's reply kept last when the cut would drop it, as the library cuts them.
      steps:
        steps.length > REPORT_STEPS && steps.at(-1)?.reply !== undefined
          ? [...steps.slice(0, REPORT_STEPS - 1), ...steps.slice(-1)]
          : steps.slice(0, REPORT_STEPS),
      steps_truncated: steps.length > REPORT_STEPS,
    }
    const answer = await deps.post('playbooks/report', report)
    events.push({ kind: 'door', route: 'playbooks/report', step_no: null, tool: null, answer, said: null })
    return { job_id: jobId, events, ended, why, reply, capped, report, reported: answer.ok }
  }

  const asked = await deps.post('playbooks', { ask: job.ask, tools: job.tools }, { 'x-reactor-run': job.jobId })
  const playbook = asked.ok ? readPlaybook(asked.body) : null
  // What the playbook route said: the playbook's source (template, plan, cold or none), for the table's split.
  events.push({
    kind: 'door',
    route: 'playbooks',
    step_no: null,
    tool: null,
    answer: asked,
    said: playbook?.source ?? null,
  })
  if (!asked.ok) {
    return end('abandoned', asked.error)
  }
  if (playbook === null) {
    return end('abandoned', 'an answer that is not a playbook')
  }
  jobId = playbook.job_id
  if (playbook.needs_model && playbook.steps.length === 0) {
    // The door could not plan the job: the arm runs it on the plain path, and with no step run there is nothing to report.
    return {
      job_id: jobId,
      events,
      ended: 'plain',
      why: UNPLANNED,
      reply: null,
      capped: false,
      report: null,
      reported: false,
    }
  }

  for (const step of playbook.steps) {
    if (called.length >= job.maxSteps) {
      capped = true
      return end('stopped', 'the step cap')
    }
    const local = fillLocally(step, called)
    let act = local.step
    let by: 'client' | 'door' = 'client'
    let filledBy = local.by
    if (!local.whole) {
      const body = {
        job_id: jobId,
        step_no: step.step_no,
        step: local.step,
        results: called,
        ask: job.ask,
        allow_model: job.allowModel,
      }
      const answer = await deps.post('playbooks/fill', body)
      const fill = answer.ok ? readFill(answer.body) : null
      events.push({
        kind: 'door',
        route: 'playbooks/fill',
        step_no: step.step_no,
        tool: step.tool,
        answer,
        said: fill?.kind ?? null,
      })
      if (!answer.ok) {
        return end('abandoned', answer.error)
      }
      if (fill === null) {
        return end('abandoned', 'an answer that is not a fill answer')
      }
      if (fill.kind === 'stop') {
        return end('stopped', 'the door said stop')
      }
      if (fill.kind !== 'filled' || fill.step === null) {
        // needs_model and done: the reply in words, after the agent makes the step the door handed back.
        handedBack = fill.kind === 'needs_model'
        break
      }
      if (!names(step, fill.step)) {
        return end('stopped', 'an act the playbook did not name')
      }
      act = fill.step
      by = 'door'
      filledBy = fill.filled_by
    }
    const args = Object.fromEntries(act.blanks.map((b) => [b.name, b.value ?? '']))
    const result = deps.call(act.tool, args)
    called.push({ step_no: act.step_no, tool: act.tool, result, call: args })
    const shape: Shape = deps.failed(result) ? 'failed' : emptyResult(result) ? 'empty' : 'ok'
    const model: Model = filledBy === 'small' || filledBy === 'large' ? filledBy : 'none'
    events.push({
      kind: 'tool',
      step_no: act.step_no,
      tool: act.tool,
      by,
      filled_by: filledBy,
      model,
      shape,
      ...(shape === 'failed' ? { refused: { call: args, error: (result as { error: string }).error } } : {}),
    })
    const reportedCall = cutJson(args, CALL_BYTES)
    const reportedResult = cutJson(result, RESULT_BYTES)
    steps.push({
      step_no: act.step_no,
      tool: act.tool.slice(0, TOOL_CHARACTERS),
      filled_by: filledBy,
      result_shape: shape,
      verified: shape === 'ok',
      model,
      ...(reportedCall.truncated ? {} : { call: reportedCall.value as Record<string, string> }),
      call_truncated: reportedCall.truncated,
      result: reportedResult.value,
      truncated: reportedResult.truncated,
    })
    const id = `call_${act.step_no}`
    job.messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: act.tool, arguments: JSON.stringify(args) } }],
      },
      { role: 'tool', tool_call_id: id, content: JSON.stringify(result) },
    )
    if (shape !== 'ok') {
      return end('stopped', shape === 'failed' ? 'a failed result' : 'an empty result')
    }
  }

  // The agent's calls go in the report as the large model's, numbered on from the playbook's.
  const recordAgent = (tool: string, args: Record<string, unknown>, result: unknown): void => {
    const shape: Shape = deps.failed(result) ? 'failed' : emptyResult(result) ? 'empty' : 'ok'
    const reportedCall = cutJson(args, CALL_BYTES)
    const reportedResult = cutJson(result, RESULT_BYTES)
    steps.push({
      step_no: (steps.at(-1)?.step_no ?? 0) + 1,
      tool: tool.slice(0, TOOL_CHARACTERS),
      filled_by: 'large',
      result_shape: shape,
      verified: shape === 'ok',
      model: 'large',
      ...(reportedCall.truncated ? {} : { call: reportedCall.value as Record<string, string> }),
      call_truncated: reportedCall.truncated,
      result: reportedResult.value,
      truncated: reportedResult.truncated,
    })
  }
  // A playbook that ran to its end asks the door for the reply; words end the job, anything else is the agent's turn.
  if (job.reply === true && !handedBack) {
    const asked = await deps.post(replyPath(jobId), {
      ask: cutText(job.ask, ASK_BYTES).text,
      steps: steps.slice(0, REPORT_STEPS),
    })
    const read = asked.ok ? readReply(asked.body) : null
    events.push({
      kind: 'door',
      route: 'playbooks/reply',
      step_no: null,
      tool: null,
      answer: asked,
      said: read?.kind ?? null,
    })
    if (read?.kind === 'words') {
      steps.push({
        step_no: (steps.at(-1)?.step_no ?? 0) + 1,
        tool: '',
        filled_by: 'small',
        result_shape: 'ok',
        verified: true,
        model: 'small',
        reply: cutText(read.text, REPLY_BYTES).text,
      })
      reply = read.text
      return end('done', null)
    }
  }
  const turn = await agentTurns(job, deps, events, called.length, recordAgent)
  capped = turn.kind === 'capped'
  if (turn.kind === 'words') {
    reply = turn.words
    return end('done', null)
  }
  return turn.kind === 'error' ? end('abandoned', turn.error) : end('stopped', 'the step cap')
}

/** A model's arguments as the tool takes them: its JSON object, or nothing for text that is not one. */
const argumentsOf = (text: string): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * The customer's agent, once the playbook has handed the job back: after its last step, or a step the door said needs a
 * model. It goes on from the transcript so far as an agent does, making the tool calls it asks for, until it answers in
 * words, fails, or meets the step cap, counted with the steps the playbook already made. Each call it makes is handed to
 * `record`, so the report carries the job whole and the door learns the agent's steps too.
 */
export const agentTurns = async (
  job: Job,
  deps: Deps,
  events: Event[],
  made: number,
  record: (tool: string, args: Record<string, unknown>, result: unknown) => void,
): Promise<{ kind: 'words'; words: string } | { kind: 'error'; error: string } | { kind: 'capped' }> => {
  for (let steps = made; steps < job.maxSteps; steps++) {
    const answered = await deps.chat(job.messages)
    if (answered.kind !== 'tools') {
      events.push({ kind: 'reply', reply: answered })
      return answered.kind === 'words' ? answered : { kind: 'error', error: answered.error }
    }
    const results = answered.calls.map((c) => {
      const args = argumentsOf(c.arguments)
      const result = deps.call(c.name, args)
      record(c.name, args, result)
      return result
    })
    events.push({ kind: 'reply', reply: answered, failures: results.filter((r) => deps.failed(r)).length })
    job.messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: answered.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      },
      ...answered.calls.map((c, i) => ({
        role: 'tool' as const,
        tool_call_id: c.id,
        content: JSON.stringify(results[i]),
      })),
    )
  }
  return { kind: 'capped' }
}

/** One line per job: each step, who filled it and its shape; a fill answer that filled nothing; then how it ended. */
export const stepLineOf = (trace: Trace): string => {
  const parts = trace.events.flatMap((e): string[] => {
    if (e.kind === 'tool') {
      return [`${e.step_no} ${e.tool} ${e.filled_by ?? (e.by === 'door' ? 'door' : 'none')} ${e.shape}`]
    }
    if (e.kind === 'reply') {
      const by = e.reply.kind === 'error' ? '' : e.reply.by
      return e.reply.kind === 'words'
        ? [`reply ${e.reply.by}`]
        : e.reply.kind === 'tools'
          ? e.reply.tools.map((tool) => `agent ${by} ${tool}`)
          : []
    }
    if (e.route === 'playbooks/reply') {
      return [`reply ${e.said === 'words' ? 'small' : (e.said ?? 'error')}`]
    }
    return e.route === 'playbooks/fill' && e.said !== null && e.said !== 'filled'
      ? [`${e.step_no} ${e.tool} ${e.said}`]
      : []
  })
  return [...parts, ...(trace.ended === 'done' ? [] : [`${trace.ended}: ${trace.why ?? 'no reason given'}`])].join(', ')
}
