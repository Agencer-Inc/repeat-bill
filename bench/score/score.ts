import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FilledBy } from '../harness/playbook-client.ts'
import type { ServedBy } from '../harness/prices.ts'
import type { Arm, RunRecord, StepLine, TaskLine } from '../harness/run.ts'
import { DOMAINS } from '../tasks/domains.ts'

export interface DayResult {
  day: number
  tasks: number
  passed: number
  tool_steps: number
  talk_steps: number
  small_model_tool_steps: number
  /** On the playbook arm only: tool steps filled with no model, by the client or by the door from the ask or a result. */
  no_model_tool_steps?: number
  /** Reactor tasks failed where the plain arm passed the same task; null when not measured. */
  wrong_tool_calls: number | null
  /** Tool calls the tool itself refused, on tasks that still passed (2026-10-23); never among the wrong calls. */
  failed_calls_on_passed: number
  cost_usd: number
  /** cost_usd / passed; null exactly when passed is 0. */
  cost_per_solved_usd: number | null
  median_task_seconds: number
  /**
   * The wall time of a tool step, in ms, by who filled it (2026-11-09): from the step before it in the job,
   * or the job's start, to its own end, so the door's rounds and any model run between the two are in it. Only on a
   * day whose lines carry their time (`at_ms`, since 2026-11-09); a job with a line that does not is left out.
   */
  step_ms?: Partial<Record<StepGear, StepTime>>
}

/**
 * Who filled a tool step, for its time: the plain arm's large model; on the playbook arm, no model (the ask or a
 * result, as a plan or a learned job set it), the small model, the large model writing it at the door, or the agent's own
 * large model after the door handed the step back.
 */
export type StepGear = 'plain' | 'no_model' | 'small' | 'large' | 'handed_back'
export interface StepTime {
  steps: number
  median_ms: number
  p90_ms: number
}
const GEARS: readonly StepGear[] = ['plain', 'no_model', 'small', 'large', 'handed_back']
const GEAR_NAMES: Record<StepGear, string> = {
  plain: 'plain',
  no_model: 'no model',
  small: 'small model',
  large: 'large model, at the door',
  handed_back: 'handed back to the agent',
}

/** One arm of one run. Every field name here is a contract the publication kit validates. */
export interface Results {
  benchmark: 'repeat-bill'
  version: '0.1'
  arm: Arm
  large_model: string
  small_model: string | null
  domain: string
  run_id: string
  harness_commit: string
  prices: Record<string, { in_per_mtok: number; out_per_mtok: number }>
  days: DayResult[]
  /** On the playbook arm only: each task's step line, who filled each step and how its job ended. */
  step_lines?: { day: number; job: string; line: string }[]
  notes: string
}

export interface RunData {
  dir: string
  run: RunRecord
  steps: StepLine[]
  tasks: TaskLine[]
}

/** What two arms of one run must agree on, or they are not a pair. */
const SAME = [
  'large_model',
  'domain',
  'harness_commit',
  'days',
  'tasks_per_day',
  'seed',
  'words',
  'max_steps',
  'timeout_seconds',
] as const

/** A run id and a domain become part of an output path, so they are held to the names the CLI accepts. */
const NAME = /^[A-Za-z0-9._-]{1,64}$/

/** Leads both arms' notes of a run asked with --words same; results.json has no other field to carry it. */
export const SAME_WORDS_NOTE =
  'This run asked each job in the same words every day, its day-1 phrasing, with new data each day (--words same).'

/**
 * Whether a step line is a model's answer: every line but an error on plain and reactor; on the playbook arm the reply
 * calls, and the tool steps the agent's own chat calls asked for: through the pass route, or on the plain path.
 */
const answered = (arm: Arm, s: StepLine): boolean =>
  arm === 'playbook'
    ? s.kind === 'talk' || (s.kind === 'tool' && (s.route === 'playbooks/pass' || s.route === 'chat/completions'))
    : s.kind !== 'error'

/** On the playbook arm, a fill the door's model made: its usage is whether its answer named a spend, every call priced. */
const modelFill = (arm: Arm, s: StepLine): boolean => arm === 'playbook' && s.kind === 'door' && s.served_by !== null

const round6 = (x: number): number => Math.round(x * 1_000_000) / 1_000_000

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  return Math.round((value ?? 0) * 1000) / 1000
}

const jsonl = <T>(file: string): T[] => {
  const text = readFileSync(file, 'utf8').trim()
  return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line) as T)
}

export const readRun = (dir: string): RunData => {
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunRecord
  if (run.benchmark !== 'repeat-bill' || run.version !== '0.1') {
    throw new Error(`${dir}: not a repeat-bill 0.1 run`)
  }
  if (!NAME.test(String(run.run_id)) || !NAME.test(String(run.domain))) {
    throw new Error(`${dir}: run_id and domain must be 1 to 64 letters, digits, dots, dashes or underscores`)
  }
  if (run.arm !== 'plain' && run.arm !== 'reactor' && run.arm !== 'playbook') {
    throw new Error(`${dir}: arm must be plain, reactor or playbook`)
  }
  // A run.json written before the words setting has no such field, and every such run asked in new words.
  const words: unknown = Object.hasOwn(run, 'words') ? run.words : 'new'
  if (words !== 'new' && words !== 'same') {
    throw new Error(`${dir}: words must be new or same`)
  }
  // A run.json written before the key ledger has neither field: its key was not checked.
  const seen: unknown = Object.hasOwn(run, 'key_seen_before') ? run.key_seen_before : null
  const earlier: unknown = Object.hasOwn(run, 'key_earlier_run_id') ? run.key_earlier_run_id : null
  if (seen !== true && seen !== false && seen !== null) {
    throw new Error(`${dir}: key_seen_before must be true, false or null`)
  }
  const named = typeof earlier === 'string' && NAME.test(earlier)
  if (seen === true ? !named : earlier !== null) {
    throw new Error(`${dir}: key_earlier_run_id must name the earlier run exactly when key_seen_before is true`)
  }
  const steps = jsonl<StepLine>(join(dir, 'steps.jsonl'))
  const tasks = jsonl<TaskLine>(join(dir, 'tasks.jsonl'))
  const want = run.days * run.tasks_per_day
  if (run.finished_at === null || tasks.length !== want) {
    throw new Error(`${dir}: the run is not finished (${tasks.length} of ${want} tasks)`)
  }
  // Only a step the small model answered may come back without usage; any other is a cost nobody can know.
  const unknown = steps.filter(
    (s) => (answered(run.arm, s) || modelFill(run.arm, s)) && s.served_by !== 'small' && !s.usage_reported,
  ).length
  if (unknown > 0) {
    throw new Error(
      `${dir}: ${unknown} steps answered as the large model or by neither model reported no usage, so their cost is unknown`,
    )
  }
  if (run.arm === 'playbook' && tasks.some((t) => typeof t.step_line !== 'string' || t.step_line.trim() === '')) {
    throw new Error(`${dir}: every task of the playbook arm carries its step line`)
  }
  return {
    dir,
    run: { ...run, words, key_seen_before: seen, key_earlier_run_id: named ? earlier : null },
    steps,
    tasks,
  }
}

const keyOf = (data: RunData): string => `${data.run.run_id}|${data.run.domain}`

/** Both arms of a run share run_id; a domain is scored on its own. */
export const pairRuns = (runs: readonly RunData[]): { plain?: RunData; reactor?: RunData; playbook?: RunData }[] => {
  const groups = new Map<string, { plain?: RunData; reactor?: RunData; playbook?: RunData }>()
  for (const data of runs) {
    const group = groups.get(keyOf(data)) ?? {}
    if (group[data.run.arm] !== undefined) {
      throw new Error(`two ${data.run.arm} arms for run ${data.run.run_id} on ${data.run.domain}`)
    }
    group[data.run.arm] = data
    groups.set(keyOf(data), group)
  }
  // The reactor arm and the playbook arm are each measured against the plain arm, so each must pair with it.
  for (const { plain, reactor, playbook } of groups.values()) {
    for (const other of [reactor, playbook]) {
      if (plain === undefined || other === undefined) {
        continue
      }
      const differs = SAME.find((field) => plain.run[field] !== other.run[field])
      if (differs !== undefined) {
        throw new Error(
          `run ${plain.run.run_id}: the arms differ on ${differs} (plain ${plain.run[differs]}, ${other.run.arm} ${other.run[differs]})`,
        )
      }
      // A saving read across two price books is the price change, not the arms.
      const large = plain.run.large_model
      const [p, r] = [plain.run.prices[large], other.run.prices[large]]
      if (p?.in_per_mtok !== r?.in_per_mtok || p?.out_per_mtok !== r?.out_per_mtok) {
        throw new Error(`run ${plain.run.run_id}: the arms were costed at different prices for ${large}`)
      }
    }
  }
  return [...groups.values()]
}

/**
 * Reactor tasks among `tasks` failed where the plain arm passed the same task, read from `plainTasks` picked the
 * same way; null on the plain arm, and on a reactor arm with no plain arm.
 */
const wrongOf = (data: RunData, tasks: readonly TaskLine[], plainTasks: readonly TaskLine[] | null): number | null => {
  if (data.run.arm === 'plain' || plainTasks === null) {
    return null
  }
  const plainPassed = new Set(plainTasks.filter((t) => t.passed).map((t) => t.instance))
  // A job the door could not plan ran on the plain path: its failure is the plain path's, not a wrong tool call.
  return tasks.filter((t) => !t.passed && t.ended !== 'plain' && plainPassed.has(t.instance)).length
}

/** The tool calls the tool itself refused on tasks that passed: a wrong turn the task recovered from. */
const failedOnPassed = (steps: readonly StepLine[], tasks: readonly TaskLine[]): number => {
  const passed = new Set(tasks.filter((t) => t.passed).map((t) => t.instance))
  return steps.filter((s) => passed.has(s.instance)).reduce((n, s) => n + (s.tool_failures ?? 0), 0)
}

/**
 * The door's own spend on a line, as its answer named it. On a `playbooks/answer` line the named spend is the round
 * the library itself just ran, already the line's `cost_usd`: under Door 2 the door and the shell call no model, so
 * what the answer names back is never a call of their own. Counted twice, the 2026-11-04 rerun charged every round
 * of the library's twice.
 */
const overheadOf = (s: StepLine): number => (s.route === 'playbooks/answer' ? 0 : (s.overhead_usd ?? 0))

const gearOf = (s: StepLine): StepGear =>
  s.arm !== 'playbook'
    ? 'plain'
    : s.served_by === null
      ? 'no_model'
      : s.filled_by === 'large'
        ? 'large'
        : s.served_by === 'small'
          ? 'small'
          : 'handed_back'

/** Each tool step's time, by gear, over the day's jobs whose every line carries its time; none on the reactor arm. */
const stepTimesOf = (steps: readonly StepLine[]): Map<StepGear, number[]> => {
  const times = new Map<StepGear, number[]>()
  const jobs = new Map<string, StepLine[]>()
  for (const s of steps) {
    jobs.set(s.instance, [...(jobs.get(s.instance) ?? []), s])
  }
  for (const lines of jobs.values()) {
    if (lines.some((s) => s.at_ms === undefined || s.arm === 'reactor')) {
      continue
    }
    let before = 0
    for (const s of [...lines].sort((a, b) => a.step - b.step)) {
      if (s.kind === 'tool') {
        const gear = gearOf(s)
        times.set(gear, [...(times.get(gear) ?? []), (s.at_ms ?? 0) - before])
        before = s.at_ms ?? 0
      }
    }
  }
  return times
}

const stepMsOf = (steps: readonly StepLine[]): Partial<Record<StepGear, StepTime>> | null => {
  const times = stepTimesOf(steps)
  if (times.size === 0) {
    return null
  }
  return Object.fromEntries(
    GEARS.flatMap((gear) => {
      const xs = times.get(gear)
      return xs === undefined
        ? []
        : [[gear, { steps: xs.length, median_ms: Math.round(median(xs)), p90_ms: Math.round(p90(xs)) }]]
    }),
  )
}

const dayOf = (data: RunData, day: number, plain: RunData | undefined): DayResult => {
  const tasks = data.tasks.filter((t) => t.day === day)
  const steps = data.steps.filter((s) => s.day === day)
  const tools = steps.filter((s) => s.kind === 'tool')
  const passed = tasks.filter((t) => t.passed).length
  const cost = round6(steps.reduce((sum, s) => sum + s.cost_usd + overheadOf(s), 0))
  const wrong = wrongOf(data, tasks, plain?.tasks.filter((t) => t.day === day) ?? null)
  const stepMs = stepMsOf(steps)
  return {
    day,
    tasks: tasks.length,
    passed,
    tool_steps: tools.length,
    talk_steps: steps.filter((s) => s.kind === 'talk').length,
    small_model_tool_steps: tools.filter((s) => s.served_by === 'small').length,
    ...(data.run.arm === 'playbook' ? { no_model_tool_steps: tools.filter((s) => s.served_by === null).length } : {}),
    wrong_tool_calls: wrong,
    failed_calls_on_passed: failedOnPassed(steps, tasks),
    cost_usd: cost,
    cost_per_solved_usd: passed === 0 ? null : round6(cost / passed),
    median_task_seconds: median(tasks.map((t) => t.seconds)),
    ...(stepMs === null ? {} : { step_ms: stepMs }),
  }
}

/** Whether the reactor arm's day 1 was cold, from what the key ledger saw when the arm started. */
const coldNote = (run: RunRecord): string => {
  if (run.key_seen_before === true) {
    return `The Reactor key was used by run ${run.key_earlier_run_id} before this run: day 1 is not cold.`
  }
  if (run.key_seen_before === false) {
    return "Day 1 is cold only if the reactor key's account had never run this benchmark. The harness's key ledger on the machine that ran it had not seen this key at this base URL; it sees keys, not accounts, so a new key on an account that ran this benchmark before would not show there, nor would a key used through another base URL, on another machine or before the ledger existed."
  }
  return 'Day 1 is cold only if the reactor key had never run this benchmark; whoever ran it declares that, and nothing here checks it.'
}

const notesOf = (data: RunData, paired: boolean): string => {
  const { run, steps, tasks } = data
  const notes: string[] = []
  if (run.words === 'same') {
    notes.push(SAME_WORDS_NOTE)
  }
  if (run.arm === 'reactor') {
    notes.push(
      "The reactor arm's cost is a floor, so its saving is a ceiling: a step the small model answered costs $0 here when its response reports no usage, and what the small model spends deciding a step is billed to the small model's key and never reaches a response.",
    )
  }
  if (run.arm === 'playbook') {
    notes.push(
      `The playbook arm ran the ${run.client ?? 'bare'} client, the harness's stand-in for the customer's playbook library, with fills that ${run.allow_model === false ? 'did not let' : 'let'} the door call a model.`,
      "The playbook arm's cost is a floor, so its saving is a ceiling: it counts what the door's answers name as spent and what its reply calls report, and a step filled with no model costs $0.",
      "On the playbook arm a failed or an empty result of a step the playbook made stops the job, so that task never passes; a call the customer's agent makes after the playbook may fail and the job goes on.",
    )
  }
  notes.push('Prices are list prices, with no batch or prompt-prefix discount, on both arms.')
  const unreported = steps.filter((s) => (answered(run.arm, s) || modelFill(run.arm, s)) && !s.usage_reported).length
  if (unreported > 0) {
    notes.push(`${unreported} steps reported no usage and are counted at $0.`)
  }
  const other = steps.filter((s) => answered(run.arm, s) && s.served_by === 'other').length
  if (other > 0) {
    notes.push(`${other} steps named neither model and are priced as the large model.`)
  }
  if (run.arm === 'playbook') {
    const abandoned = tasks.filter((t) => t.ended === 'abandoned').length
    if (abandoned > 0) {
      notes.push(`${abandoned} jobs were abandoned on an error from the door, and count as failed.`)
    }
    const plain = tasks.filter((t) => t.ended === 'plain').length
    if (plain > 0) {
      notes.push(
        `${plain} jobs the door could not plan ran on the plain path, served by the large model with no saving; a task among them that failed is not counted as a wrong tool call.`,
      )
    }
  } else {
    const errors = steps.filter((s) => s.kind === 'error').length
    if (errors > 0) {
      notes.push(`${errors} tasks ended on an error from the endpoint, and count as failed.`)
    }
  }
  const capped = tasks.filter((t) => t.capped).length
  if (capped > 0) {
    notes.push(`${capped} tasks stopped at the ${run.max_steps}-step cap.`)
  }
  if (run.arm === 'plain') {
    notes.push('wrong_tool_calls is null on the plain arm: it is the reference the reactor arm is measured against.')
  } else if (!paired) {
    notes.push('wrong_tool_calls is null: no plain arm of this run was scored with it.')
  }
  if (run.arm !== 'plain') {
    notes.push(coldNote(run))
  }
  if (run.harness_commit.endsWith('-dirty')) {
    notes.push('The harness had uncommitted changes in bench/ when it ran.')
  }
  return notes.join(' ')
}

const resultsOf = (data: RunData, plain: RunData | undefined): Results => {
  const { run } = data
  return {
    benchmark: 'repeat-bill',
    version: '0.1',
    arm: run.arm,
    large_model: run.large_model,
    small_model: run.arm === 'plain' ? null : run.small_model,
    domain: run.domain,
    run_id: run.run_id,
    harness_commit: run.harness_commit,
    prices: run.prices,
    days: Array.from({ length: run.days }, (_, i) => dayOf(data, i + 1, plain)),
    ...(run.arm === 'playbook'
      ? { step_lines: data.tasks.map((t) => ({ day: t.day, job: t.template, line: t.step_line ?? '' })) }
      : {}),
    notes: notesOf(data, plain !== undefined),
  }
}

export const scoreRuns = (runs: readonly RunData[]): Results[] =>
  pairRuns(runs).flatMap(({ plain, reactor, playbook }) => [
    ...(plain === undefined ? [] : [resultsOf(plain, undefined)]),
    ...(reactor === undefined ? [] : [resultsOf(reactor, plain)]),
    ...(playbook === undefined ? [] : [resultsOf(playbook, plain)]),
  ])

/** Where a result goes: one folder per run and domain, one per arm inside it. */
export const resultsPath = (out: string, r: Results): string =>
  join(out, `${r.run_id}-${r.domain}`, r.arm, 'results.json')

export const writeResults = (out: string, results: readonly Results[]): string[] =>
  results.map((r) => {
    const file = resultsPath(out, r)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`)
    return file
  })

/** 1 - reactor / plain on $ per solved task; null when either is missing or plain is 0. */
export const saving = (reactor: number | null, plain: number | null): number | null =>
  reactor === null || plain === null || plain === 0 ? null : 1 - reactor / plain

const percent = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
const dollars = (x: number | null): string => (x === null ? 'n/a' : `$${x.toFixed(4)}`)

/** $ per solved task over a span of days, from the sums, not an average of the daily figures. */
const perSolved = (days: readonly DayResult[]): number | null => {
  const passed = days.reduce((n, d) => n + d.passed, 0)
  return passed === 0 ? null : days.reduce((n, d) => n + d.cost_usd, 0) / passed
}

export const tableOf = (results: readonly Results[]): string => {
  const groups = new Map<string, { plain?: Results; reactor?: Results; playbook?: Results }>()
  for (const r of results) {
    const key = `${r.run_id}|${r.domain}`
    groups.set(key, { ...groups.get(key), [r.arm]: r })
  }
  const sections = [...groups.values()].map(({ plain, reactor, playbook }) => {
    const any = plain ?? reactor ?? playbook
    if (any === undefined) {
      return ''
    }
    const rows: string[] = []
    for (const [index, day] of any.days.entries()) {
      for (const arm of [plain, reactor, playbook]) {
        const d = arm?.days[index]
        if (arm === undefined || d === undefined) {
          continue
        }
        const vsPlain =
          arm.arm !== 'plain' && plain !== undefined && day.day > 1
            ? percent(saving(d.cost_per_solved_usd, plain.days[index]?.cost_per_solved_usd ?? null))
            : ''
        rows.push(
          `| ${d.day} | ${arm.arm} | ${percent(d.passed / d.tasks)} (${d.passed}/${d.tasks}) | ${d.tool_steps} | ${
            d.tool_steps === 0 ? 'n/a' : percent(d.small_model_tool_steps / d.tool_steps)
          } | ${dollars(d.cost_per_solved_usd)} | ${d.wrong_tool_calls ?? 'n/a'} | ${d.failed_calls_on_passed} | ${vsPlain} |`,
        )
      }
    }
    const sameWords = any.notes.startsWith(SAME_WORDS_NOTE)
    const lines = [
      `## ${any.domain}, run ${any.run_id}${sameWords ? ', the same words every round' : ''}`,
      '',
      `Large model ${any.large_model}${reactor?.small_model ? `; small model on the reactor arm ${reactor.small_model}` : ''}${playbook?.small_model ? `; small model on the playbook arm ${playbook.small_model}` : ''}. Harness ${any.harness_commit}.`,
      '',
      '| Day | Arm | Pass rate | Tool steps | Tool steps the small model answered | $ per solved task | Wrong tool calls | Failed calls on passed tasks | Saving vs plain |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
    ]
    for (const other of [reactor, playbook]) {
      if (plain !== undefined && other !== undefined && any.days.length > 1) {
        const later = (r: Results): DayResult[] => r.days.filter((d) => d.day > 1)
        const wrong = later(other).reduce((n, d) => n + (d.wrong_tool_calls ?? 0), 0)
        const failed = later(other).reduce((n, d) => n + d.failed_calls_on_passed, 0)
        lines.push(
          '',
          `Days 2 to ${any.days.length} together: saving ${percent(saving(perSolved(later(other)), perSolved(later(plain))))}, with ${wrong} wrong tool calls and ${failed} failed calls on passed tasks on the ${other.arm} arm.`,
        )
      }
    }
    if (reactor !== undefined) {
      lines.push(
        '',
        "The reactor arm's cost is a floor, so its saving is a ceiling: some of the small model's spend never reaches a response. Wrong tool calls are counted on their own and never folded into the saving.",
      )
    }
    if (playbook !== undefined) {
      lines.push(
        '',
        "The playbook arm's cost is a floor, so its saving is a ceiling: spend the door's answers do not name is not counted. Wrong tool calls are counted on their own and never folded into the saving.",
        '',
        '### Who filled each step on the playbook arm',
        '',
        ...(playbook.step_lines ?? []).map((s) => `- Day ${s.day}, ${s.job}: ${s.line}`),
      )
    }
    return lines.join('\n')
  })
  return `# repeat-bill results\n\n${sections.join('\n\n')}\n`
}

/** One arm on one day, for one job or, when `job` is null, for all of them: a row of the job table. */
const jobRow = (data: RunData, day: number, job: string | null, plain: RunData | undefined): string | null => {
  const picked = <T extends { day: number; template: string }>(lines: readonly T[]): T[] =>
    lines.filter((line) => line.day === day && (job === null || line.template === job))
  const tasks = picked(data.tasks)
  if (tasks.length === 0) {
    return null
  }
  const steps = picked(data.steps)
  const tools = steps.filter((s) => s.kind === 'tool')
  const by = (model: ServedBy): number => tools.filter((s) => s.served_by === model).length
  const passed = tasks.filter((t) => t.passed).length
  const wrong = wrongOf(data, tasks, plain === undefined ? null : picked(plain.tasks))
  const cost = round6(steps.reduce((sum, s) => sum + s.cost_usd + overheadOf(s), 0))
  return `| ${day} | ${job ?? 'all jobs'} | ${data.run.arm} | ${percent(passed / tasks.length)} (${passed}/${tasks.length}) | ${
    tools.length
  } | ${by('large')} | ${by('small')} | ${by('other')} | ${wrong ?? 'n/a'} | ${failedOnPassed(steps, tasks)} | ${dollars(cost)} |`
}

/** The plain and reactor arms' tool steps by the model that answered them, per day and per job. */
const modelSection = (plain: RunData | undefined, reactor: RunData | undefined): string => {
  const any = plain ?? reactor
  if (any === undefined) {
    return ''
  }
  const rows: string[] = []
  for (let day = 1; day <= any.run.days; day++) {
    const jobs = [...new Set(any.tasks.filter((t) => t.day === day).map((t) => t.template))]
    for (const job of [...jobs, null]) {
      for (const arm of [plain, reactor]) {
        const row = arm === undefined ? null : jobRow(arm, day, job, plain)
        if (row !== null) {
          rows.push(row)
        }
      }
    }
  }
  return [
    `## ${any.run.domain}, run ${any.run.run_id}: tool steps by the model that answered, per job`,
    '',
    'Each tool step is counted under the model its response named: the large model, the small model, or neither, which is priced as the large model. An error is not a tool step. Cost is every step of that job on that day.',
    '',
    '| Day | Job | Arm | Pass rate | Tool steps | Large model | Small model | Neither | Wrong tool calls | Failed calls on passed tasks | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/** One arm on one day, for one job or for all of them: a row of the playbook arm's table of who filled each step. */
const fillRow = (data: RunData, day: number, job: string | null, plain: RunData | undefined): string | null => {
  const picked = <T extends { day: number; template: string }>(lines: readonly T[]): T[] =>
    lines.filter((line) => line.day === day && (job === null || line.template === job))
  const tasks = picked(data.tasks)
  if (tasks.length === 0) {
    return null
  }
  const steps = picked(data.steps)
  const tools = steps.filter((s) => s.kind === 'tool')
  const by = (who: FilledBy): number => tools.filter((s) => (s.filled_by ?? null) === who).length
  const passed = tasks.filter((t) => t.passed).length
  const wrong = wrongOf(data, tasks, plain === undefined ? null : picked(plain.tasks))
  const cost = round6(steps.reduce((sum, s) => sum + s.cost_usd + overheadOf(s), 0))
  return `| ${day} | ${job ?? 'all jobs'} | ${percent(passed / tasks.length)} (${passed}/${tasks.length}) | ${tools.length} | ${by(
    'ask',
  )} | ${by('result')} | ${by('small')} | ${by('large')} | ${by(null)} | ${wrong ?? 'n/a'} | ${failedOnPassed(steps, tasks)} | ${dollars(cost)} |`
}

/** The playbook arm's tool steps by who filled them, per day and per job, read from its step records. */
const fillSection = (playbook: RunData, plain: RunData | undefined): string => {
  const rows: string[] = []
  for (let day = 1; day <= playbook.run.days; day++) {
    const jobs = [...new Set(playbook.tasks.filter((t) => t.day === day).map((t) => t.template))]
    for (const job of [...jobs, null]) {
      const row = fillRow(playbook, day, job, plain)
      if (row !== null) {
        rows.push(row)
      }
    }
  }
  return [
    `## ${playbook.run.domain}, run ${playbook.run.run_id}: who filled each tool step on the playbook arm, per job`,
    '',
    "Each tool step is counted under who filled it: the ask, an earlier step's result, the door's small model or its large model, or nobody named. Cost is every door answer and reply of that job on that day.",
    '',
    '| Day | Job | Pass rate | Tool steps | Ask | Result | Small model | Large model | Nobody named | Wrong tool calls | Failed calls on passed tasks | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/** What the door's refusal of a reply says before the kind of value it could not hold. */
const UNHELD_REPLY = 'a value the reply wrote is not in the ask or the results: '

/** What the door's refusal of a reply says before the stem of an act the words claimed that no step made. */
const CLAIMED_REPLY = 'the reply names an act no step made: '

/** Why the shell hands a reply back when the small model says a step is still to be made; copied from src/ by hand. */
const HELD_BACK_REPLY = 'the small model says a step is still to be made'

/**
 * The route whose verdict a door line carries, or undefined for a line that carries none: a route's own line, unless
 * it only said the door asked a round, and a round's line that settled a route's answer (2026-11-04). Under Door 2 the
 * playbook, fill and reply routes answer run_model first, and the verdict comes on the settling round's line.
 */
const verdictOf = (s: StepLine): string | undefined =>
  s.kind !== 'door' || s.said === 'run_model' ? undefined : (s.settles ?? s.route)

/**
 * The playbook arm's final replies per day (2026-10-28): written by the door's small model, or by the agent's large
 * model after the door said a model is needed, with each refusal's kind of value; and what a solved task would cost
 * were every tool step free, the final replies and the door's overhead alone, beside plain: the design's ceiling.
 */
const replySection = (playbook: RunData, plain: RunData | undefined): string => {
  // Each job's playbook source, as the playbook route said it: a small reply on a template run is one the large
  // model finished whole once; on a planner's, a cold or no playbook it is not (2026-10-29).
  const sourceOf = new Map<string, string>()
  for (const s of playbook.steps) {
    if (verdictOf(s) === 'playbooks' && typeof s.said === 'string') {
      sourceOf.set(s.instance, s.said)
    }
  }
  const rows: string[] = []
  for (let day = 1; day <= playbook.run.days; day++) {
    const steps = playbook.steps.filter((s) => s.day === day)
    const replies = steps.filter((s) => verdictOf(s) === 'playbooks/reply')
    const small = replies.filter((s) => s.said === 'words')
    const onTemplate = small.filter((s) => sourceOf.get(s.instance) === 'template').length
    const heldBack = replies.filter((s) => s.said !== 'words' && s.reason === HELD_BACK_REPLY).length
    const refused = new Map<string, number>()
    for (const s of replies) {
      const kind =
        s.said === 'words'
          ? undefined
          : s.reason?.startsWith(UNHELD_REPLY) === true
            ? s.reason.slice(UNHELD_REPLY.length)
            : s.reason?.startsWith(CLAIMED_REPLY) === true
              ? `act ${s.reason.slice(CLAIMED_REPLY.length)}`
              : undefined
      if (kind !== undefined) {
        refused.set(kind, (refused.get(kind) ?? 0) + 1)
      }
    }
    const passed = playbook.tasks.filter((t) => t.day === day && t.passed).length
    const free = steps.reduce((sum, s) => sum + (s.kind === 'talk' ? s.cost_usd : 0) + overheadOf(s), 0)
    const freePerSolved = passed === 0 ? null : free / passed
    const plainDay = plain === undefined ? undefined : dayOf(plain, day, undefined)
    rows.push(
      `| ${day} | ${onTemplate} | ${small.length - onTemplate} | ${replies.length - small.length} | ${heldBack} | ${
        refused.size === 0 ? '-' : [...refused].map(([kind, n]) => `${kind} ${n}`).join(', ')
      } | ${dollars(freePerSolved)} | ${dollars(plainDay?.cost_per_solved_usd ?? null)} | ${percent(
        saving(freePerSolved, plainDay?.cost_per_solved_usd ?? null),
      )} |`,
    )
  }
  return [
    `## ${playbook.run.domain}, run ${playbook.run.run_id}: the final reply on the playbook arm, per day`,
    '',
    `A reply the door was asked for is written by its small model, on a run whose playbook was a stored template or on a planner's, a cold or no playbook, or by the agent's large model after the door said a model is needed, among them those the small model held back, which said a step was still to be made, so the agent finished the job; a refusal names the kind of value the words held that the ask and the results did not, or \`act\` and the stem of an act the words claimed that no step made. With every tool step free, a solved task costs its final replies and the door's overhead alone: the saving beside it is the ceiling of the design.${
      playbook.run.domain === 'support-ops'
        ? ' talk-order-total passes when the total is anywhere in the reply, not first (2026-10-29).'
        : ''
    }`,
    '',
    '| Day | Written small: template | Written small: planner or cold | Written large after needs_model | Held back by the small model | Refused by kind | $ per solved task, tool steps free | $ per solved task, plain | Ceiling saving vs plain |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/** The 90th percentile, as the nearest-rank value; 0 of nothing. */
const p90 = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted.length === 0 ? 0 : (sorted[Math.ceil(sorted.length * 0.9) - 1] ?? 0)
}

/** The tools a job's step records called, the playbook's steps and the agent's alike. */
const toolsOf = (steps: readonly StepLine[], instance: string): Set<string> =>
  new Set(steps.flatMap((s) => (s.instance === instance && s.kind === 'tool' && s.tool !== null ? [s.tool] : [])))

/**
 * The rerun's measures (2026-10-30), per day on the playbook arm: the steps a job the small model closed skipped,
 * the replies the claim check refused, the wrong calls by cause, and the door's round trip on a fill and a report.
 * A skipped step is an acting tool the plain arm called on the same task, which it passed, that no step of the job
 * called. A cause is read from the records alone, so it names the shape of the failure, not the value that was wrong.
 */
const measuresSection = (playbook: RunData, plain: RunData | undefined): string => {
  const acting = DOMAINS.find((d) => d.name === playbook.run.domain)?.acting ?? new Set<string>()
  const rows: string[] = []
  const wrongLines: string[] = []
  for (let day = 1; day <= playbook.run.days; day++) {
    const steps = playbook.steps.filter((s) => s.day === day)
    const replies = steps.filter((s) => verdictOf(s) === 'playbooks/reply')
    const closedSmall = new Set(replies.filter((s) => s.said === 'words').map((s) => s.instance))
    const claimRefused = replies.filter(
      (s) => s.said !== 'words' && s.reason?.startsWith(CLAIMED_REPLY) === true,
    ).length
    const plainPassed = new Set(plain?.tasks.filter((t) => t.day === day && t.passed).map((t) => t.instance) ?? [])
    const plainSteps = plain?.steps.filter((s) => s.day === day) ?? []
    let skipped = 0
    const causes = new Map<string, number>()
    // The wrong calls, picked as wrongOf picks them: failed where the plain arm passed, and not run on the plain path.
    for (const t of playbook.tasks.filter((t) => t.day === day)) {
      if (t.passed || t.ended === 'plain' || !plainPassed.has(t.instance)) {
        continue
      }
      const closed = closedSmall.has(t.instance) ? 'small' : 'large'
      const called = toolsOf(steps, t.instance)
      const missing = [...toolsOf(plainSteps, t.instance)].filter((tool) => acting.has(tool) && !called.has(tool))
      const refusedStep = steps
        .filter((s) => s.instance === t.instance && s.kind === 'tool' && (s.tool_failures ?? 0) > 0)
        .at(-1)
      const refusedBy = refusedStep?.filled_by ?? null
      // What was sent and what the tool said, on a record written since 2026-10-30; an older one has the cause alone.
      const refusedCall =
        refusedStep?.refused === undefined
          ? ''
          : `: ${refusedStep.tool ?? ''} ${JSON.stringify(refusedStep.refused.call)}, ${refusedStep.refused.error}`
      const cause =
        t.ended === 'abandoned'
          ? 'abandoned on a door error'
          : t.capped
            ? 'the step cap'
            : t.ended === 'stopped'
              ? `a fill the tool refused, filled by ${refusedBy ?? 'nobody named'}`
              : missing.length > 0
                ? `skipped step, closed ${closed}`
                : `wrong value or reply, closed ${closed}`
      causes.set(cause, (causes.get(cause) ?? 0) + 1)
      if (missing.length > 0 && closed === 'small') {
        skipped += missing.length
      }
      wrongLines.push(
        `- Day ${day}, ${t.template}: ${
          missing.length > 0 && !t.capped && t.ended === 'done'
            ? `skipped ${missing.join(', ')}, closed ${closed}`
            : `${cause}${t.ended === 'stopped' ? refusedCall : ''}`
        }`,
      )
    }
    const fills = steps.filter((s) => s.kind === 'door' && s.route === 'playbooks/fill').map((s) => s.latency_ms)
    const reports = steps.filter((s) => s.kind === 'door' && s.route === 'playbooks/report').map((s) => s.latency_ms)
    rows.push(
      `| ${day} | ${skipped} | ${claimRefused} | ${
        causes.size === 0 ? '-' : [...causes].map(([cause, n]) => `${cause} ${n}`).join(', ')
      } | ${fills.length === 0 ? '-' : `${Math.round(median(fills))} (${Math.round(p90(fills))})`} | ${
        reports.length === 0 ? '-' : Math.round(median(reports))
      } |`,
    )
  }
  return [
    `## ${playbook.run.domain}, run ${playbook.run.run_id}: the rerun's measures on the playbook arm, per day`,
    '',
    "A skipped step is an acting tool the plain arm called on a task it passed that no step of the job, the playbook's or the agent's, called, counted on a job the small model closed that then failed (2026-10-30: the bar is zero). The claim check refuses a reply that names an act no step made. A wrong call's cause is read from the records alone: a fill the tool refused, by who filled it; a skipped step; or a wrong value or reply, by who closed the job; the step cap; a door error. Round trip is the door's time to answer a fill, median and p90, and a report, median, in ms, as the client measured it.",
    '',
    '| Day | Skipped steps | Replies refused by the claim check | Wrong calls by cause | Fill round trip ms, median (p90) | Report ms, median |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    ...(wrongLines.length === 0 ? [] : ['', '### Each wrong call on the playbook arm, by cause', '', ...wrongLines]),
  ].join('\n')
}

/** A difference in ms with its sign, for what a gear's step adds to a plain one. */
const signed = (ms: number): string => (ms > 0 ? `+${String(ms)}` : String(ms))

/**
 * The time a tool step took on the playbook arm, per day and by who filled it, beside the plain arm's step and what it
 * adds to it (2026-11-09). Empty of rows for days whose lines carry no time.
 */
const stepTimeSection = (playbook: RunData, plain: RunData | undefined): string => {
  const rows: string[] = []
  for (let day = 1; day <= playbook.run.days; day++) {
    const base = plain === undefined ? null : (stepMsOf(plain.steps.filter((s) => s.day === day)) ?? {}).plain
    const mine = stepMsOf(playbook.steps.filter((s) => s.day === day)) ?? {}
    if (base !== undefined && base !== null) {
      rows.push(`| ${day} | ${GEAR_NAMES.plain} | ${base.steps} | ${base.median_ms} | ${base.p90_ms} | - | - |`)
    }
    for (const gear of GEARS) {
      const t = mine[gear]
      if (gear === 'plain' || t === undefined) {
        continue
      }
      const added =
        base === undefined || base === null
          ? '- | -'
          : `${signed(t.median_ms - base.median_ms)} | ${signed(t.p90_ms - base.p90_ms)}`
      rows.push(`| ${day} | ${GEAR_NAMES[gear]} | ${t.steps} | ${t.median_ms} | ${t.p90_ms} | ${added} |`)
    }
  }
  return [
    `## ${playbook.run.domain}, run ${playbook.run.run_id}: time per tool step, in ms`,
    '',
    "From the step before it in the job, or the job's start, to the step's own end, so the door's rounds and any model run between the two are in it; the plan's round is in a job's first step. By who filled the step: no model (the ask or a result), the small model, the large model writing it at the door, or the agent's own large model after the door handed it back. Over plain is the median and the p90 less the plain arm's on the same day. Only jobs whose every line carries its time are counted (since 2026-11-09).",
    '',
    '| Day | Filled by | Steps | Median | p90 | Median over plain | p90 over plain |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...(rows.length === 0 ? ['| - | no line of this run carries its time | - | - | - | - | - |'] : rows),
  ].join('\n')
}

/**
 * Each run's tool steps by the model that answered them, per day and per job, beside its passes, wrong tool calls
 * and cost. Read from the step records, so it is in table.md only and never in results.json.
 */
export const jobTableOf = (runs: readonly RunData[]): string => {
  const sections = pairRuns(runs).flatMap(({ plain, reactor, playbook }) => [
    ...(plain === undefined && reactor === undefined ? [] : [modelSection(plain, reactor)]),
    ...(playbook === undefined
      ? []
      : [
          fillSection(playbook, plain),
          replySection(playbook, plain),
          measuresSection(playbook, plain),
          stepTimeSection(playbook, plain),
        ]),
  ])
  return `${sections.join('\n\n')}\n`
}
