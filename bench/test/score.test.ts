import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { loadPrices } from '../harness/prices.ts'
import type { Arm, RunRecord, StepLine, TaskLine } from '../harness/run.ts'
import { estimateTable } from '../score/estimate.ts'
import type { Results } from '../score/score.ts'
import {
  SAME_WORDS_NOTE,
  jobTableOf,
  readRun,
  resultsPath,
  saving,
  scoreRuns,
  tableOf,
  writeResults,
} from '../score/score.ts'
import { DOMAINS, domainNamed } from '../tasks/domains.ts'
import type { Words } from '../tasks/shared.ts'
import { startFake } from './fake-model.ts'

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'repeat-bill-score-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface StepSpec {
  kind: 'tool' | 'talk' | 'error' | 'door'
  by?: 'large' | 'small' | 'other' | 'none'
  cost: number
  /** A step whose response carried no usage; a small-model step never reports it. */
  unreported?: boolean
  /** What the engine's calls under the step cost; left off the line when absent, as files before 2026-10-20 are. */
  overhead?: number
  /** The step's tool calls the tool itself refused; left off the line when absent, as files before 2026-10-23 are. */
  failures?: number
  /** The door route the line went through; left off when absent, as the plain arm's lines are. */
  route?: string
  /** On a door line: what the door said, and the route whose verdict a round's line settled (2026-11-04). */
  said?: string | null
  settles?: string
  /** When the step ended, in ms since its job started; left off when absent, as lines before 2026-11-09 are. */
  at?: number
  /** On a playbook tool line: who filled the step; `by: 'none'` is a step no model filled. */
  filled?: 'ask' | 'result' | 'small' | 'large' | null
}

interface TaskSpec {
  template: string
  passed: boolean
  steps: StepSpec[]
  seconds: number
}

const large = (cost: number, kind: 'tool' | 'talk' = 'tool'): StepSpec => ({ kind, by: 'large', cost })
const served: StepSpec = { kind: 'tool', by: 'small', cost: 0 }
const task = (template: string, passed: boolean, steps: StepSpec[], seconds = 2): TaskSpec => ({
  template,
  passed,
  steps,
  seconds,
})

/** The plain arm: every task two tool steps at $0.01 and a reply at $0.02; day 2 fails task c. */
const PLAIN_DAYS: TaskSpec[][] = [
  ['a', 'b', 'c'].map((t) => task(t, true, [large(0.01), large(0.01), large(0.02, 'talk')])),
  [
    task('a', true, [large(0.01), large(0.01), large(0.02, 'talk')], 1),
    task('b', true, [large(0.01), large(0.01), large(0.02, 'talk')], 3),
    task('c', false, [large(0.01), large(0.01), large(0.02, 'talk')], 5),
  ],
]

const writeRun = (arm: Arm, days: TaskSpec[][], over: Partial<RunRecord> = {}): string => {
  const dir = scratch()
  const run: RunRecord = {
    benchmark: 'repeat-bill',
    version: '0.1',
    run_id: 'fixture-1',
    arm,
    domain: 'support-ops',
    days: days.length,
    tasks_per_day: 3,
    seed: 1,
    words: 'new',
    large_model: 'big-model',
    small_model: arm === 'reactor' ? 'small-model' : null,
    base_url: 'http://127.0.0.1/v1',
    max_steps: 25,
    timeout_seconds: 120,
    settle_seconds: arm === 'reactor' ? 65 : 0,
    prices: {
      'big-model': { in_per_mtok: 10, out_per_mtok: 30 },
      ...(arm === 'reactor' ? { 'small-model': { in_per_mtok: 1, out_per_mtok: 2 } } : {}),
    },
    harness_commit: COMMIT,
    node: 'v24.0.0',
    started_at: '2026-10-14T00:00:00.000Z',
    finished_at: '2026-10-14T01:00:00.000Z',
    key_seen_before: null,
    key_earlier_run_id: null,
    ...over,
  }
  const steps: StepLine[] = []
  const tasks: TaskLine[] = []
  days.forEach((list, d) => {
    for (const spec of list) {
      const instance = `${run.domain}.d${d + 1}.${spec.template}`
      const base = { run_id: run.run_id, arm, domain: run.domain, day: d + 1, instance, template: spec.template }
      spec.steps.forEach((s, i) => {
        const reported = s.unreported !== true && s.by !== 'small' && s.kind !== 'error' && s.kind !== 'door'
        steps.push({
          ...base,
          step: i + 1,
          kind: s.kind,
          tool: s.kind === 'tool' ? 'get_order' : null,
          tool_calls: s.kind === 'tool' ? 1 : 0,
          served_by: s.kind === 'error' || s.kind === 'door' || s.by === 'none' ? null : (s.by ?? 'large'),
          response_model: s.kind === 'door' ? null : s.by === 'small' ? 'small-model' : 'big-model',
          prompt_tokens: reported ? 100 : null,
          completion_tokens: reported ? 10 : null,
          usage_reported: reported,
          latency_ms: 10,
          retries: 0,
          cost_usd: s.cost,
          ...(s.overhead === undefined ? {} : { overhead_usd: s.overhead }),
          ...(s.failures === undefined ? {} : { tool_failures: s.failures }),
          ...(s.route === undefined ? {} : { route: s.route }),
          ...(s.said === undefined ? {} : { said: s.said }),
          ...(s.settles === undefined ? {} : { settles: s.settles }),
          ...(s.at === undefined ? {} : { at_ms: s.at }),
          ...(s.filled === undefined ? {} : { filled_by: s.filled }),
          error: s.kind === 'error' ? 'status 500' : null,
        })
      })
      tasks.push({
        ...base,
        form: 0,
        passed: spec.passed,
        reason: spec.passed ? 'ok' : 'scripted',
        steps: spec.steps.length,
        tool_steps: spec.steps.filter((s) => s.kind === 'tool').length,
        capped: false,
        seconds: spec.seconds,
        ...(arm === 'playbook' ? { step_line: '1 get_order result ok' } : {}),
      })
    }
  })
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run))
  writeFileSync(join(dir, 'steps.jsonl'), `${steps.map((s) => JSON.stringify(s)).join('\n')}\n`)
  writeFileSync(join(dir, 'tasks.jsonl'), `${tasks.map((t) => JSON.stringify(t)).join('\n')}\n`)
  return dir
}

const score = (...dirsIn: string[]): { plain?: Results; reactor?: Results } =>
  Object.fromEntries(scoreRuns(dirsIn.map(readRun)).map((r) => [r.arm, r]))

/** Both arms of the fixture run, asked in the given words, scored together. */
const scoredPair = (words: Words): Results[] =>
  scoreRuns((['plain', 'reactor'] as const).map((arm) => readRun(writeRun(arm, PLAIN_DAYS, { words }))))

const CONTRACT = [
  'arm',
  'benchmark',
  'days',
  'domain',
  'harness_commit',
  'large_model',
  'notes',
  'prices',
  'run_id',
  'small_model',
  'version',
]
const DAY_CONTRACT = [
  'cost_per_solved_usd',
  'cost_usd',
  'day',
  'failed_calls_on_passed',
  'median_task_seconds',
  'passed',
  'small_model_tool_steps',
  'talk_steps',
  'tasks',
  'tool_steps',
  'wrong_tool_calls',
]

describe('the scorer', () => {
  it('reads a saving of 0 when the reactor arm did exactly what the plain arm did', () => {
    const { plain, reactor } = score(writeRun('plain', PLAIN_DAYS), writeRun('reactor', PLAIN_DAYS))
    expect(plain?.days[1]?.cost_per_solved_usd).toBe(0.06)
    expect(reactor?.days[1]?.cost_per_solved_usd).toBe(0.06)
    expect(saving(reactor?.days[1]?.cost_per_solved_usd ?? null, plain?.days[1]?.cost_per_solved_usd ?? null)).toBe(0)
    expect(reactor?.days.map((d) => d.wrong_tool_calls)).toEqual([0, 0])
    const table = tableOf([plain, reactor].filter((r): r is Results => r !== undefined))
    expect(table).toContain(
      '| Day | Arm | Pass rate | Tool steps | Tool steps the small model answered | $ per solved task | Wrong tool calls | Failed calls on passed tasks | Saving vs plain |',
    )
    expect(table).toContain('| 2 | reactor | 66.7% (2/3) | 6 | 0.0% | $0.0600 | 0 | 0 | 0.0% |')
    expect(table).toContain(
      'Days 2 to 2 together: saving 0.0%, with 0 wrong tool calls and 0 failed calls on passed tasks on the reactor arm.',
    )
  })

  it('reads a known saving: tool steps answered by the small model at $0 halve the cost per solved task', () => {
    const halved = PLAIN_DAYS.map((day, d) =>
      d === 0 ? day : day.map((t) => ({ ...t, steps: [served, served, large(0.02, 'talk')] })),
    )
    const { plain, reactor } = score(writeRun('plain', PLAIN_DAYS), writeRun('reactor', halved))
    expect(reactor?.days[1]).toMatchObject({ cost_usd: 0.06, cost_per_solved_usd: 0.03, small_model_tool_steps: 6 })
    expect(
      saving(reactor?.days[1]?.cost_per_solved_usd ?? null, plain?.days[1]?.cost_per_solved_usd ?? null),
    ).toBeCloseTo(0.5, 12)
    const table = tableOf([plain, reactor].filter((r): r is Results => r !== undefined))
    expect(table).toContain('| 2 | reactor | 66.7% (2/3) | 6 | 100.0% | $0.0300 | 0 | 0 | 50.0% |')
    expect(table).toContain('| 2 | plain | 66.7% (2/3) | 6 | 0.0% | $0.0600 | n/a | 0 |  |')
  })

  it("adds each step's overhead_usd to the day's cost, and reads a line without it as 0", () => {
    // Two days: the fixture leaves overhead_usd off a line with no `overhead`, as every file written before it.
    const days = [
      ['a', 'b', 'c'].map((t) => task(t, true, [large(0.01)])),
      ['a', 'b', 'c'].map((t) =>
        task(t, true, [{ kind: 'tool', by: 'small', cost: 0, overhead: 0.004 }, large(0.02, 'talk')]),
      ),
    ]
    const { reactor } = score(writeRun('plain', days), writeRun('reactor', days))
    expect(reactor?.days.map((d) => d.cost_usd)).toEqual([0.03, 0.072])
  })

  it("does not add the spend the door names back on a library round to the round's own cost", () => {
    // Under Door 2 a `playbooks/answer` line is a round the library ran on its own key: its usage is the line's cost,
    // and the door's answer names that same spend back, which the harness writes as the line's overhead. Counting
    // both charged the 2026-11-04 rerun every round twice. Overhead on any other line is still the door's own spend.
    const days = [
      ['a', 'b', 'c'].map((t) =>
        task(t, true, [
          { kind: 'tool', by: 'small', cost: 0.001, overhead: 0.001, route: 'playbooks/answer' },
          { kind: 'tool', by: 'small', cost: 0, overhead: 0.004, route: 'playbooks/fill' },
          large(0.02, 'talk'),
        ]),
      ),
    ]
    const { reactor } = score(writeRun('plain', days), writeRun('reactor', days))
    expect(reactor?.days.map((d) => d.cost_usd)).toEqual([0.075])
  })

  it('counts a wrong tool call only where the reactor arm failed a task the plain arm passed', () => {
    // Day 2: plain passed a and b; the reactor arm fails a (wrong) and c (which plain failed too).
    const flipped = PLAIN_DAYS.map((day, d) => (d === 0 ? day : day.map((t) => ({ ...t, passed: t.template === 'b' }))))
    const { plain, reactor } = score(writeRun('plain', PLAIN_DAYS), writeRun('reactor', flipped))
    expect(reactor?.days.map((d) => d.wrong_tool_calls)).toEqual([0, 1])
    expect(plain?.days.map((d) => d.wrong_tool_calls)).toEqual([null, null])
    expect(reactor?.days[1]?.passed).toBe(1)
  })

  it('counts a failed tool call on a task that still passed in its own column, never among the wrong calls', () => {
    // 2026-10-23: the scorer's wrong-call rule stays; a tool's own refusal on a task that passed is its own count.
    const refused: StepSpec = { kind: 'tool', by: 'small', cost: 0, failures: 1 }
    // Day 2: a passed with a refused call (counted); b failed with one, where plain passed (a wrong call, not counted).
    const day2 = PLAIN_DAYS[1]!.map((t) =>
      t.template === 'a'
        ? { ...t, steps: [refused, ...t.steps] }
        : t.template === 'b'
          ? { ...t, passed: false, steps: [refused, ...t.steps] }
          : t,
    )
    const { plain, reactor } = score(writeRun('plain', PLAIN_DAYS), writeRun('reactor', [PLAIN_DAYS[0]!, day2]))
    expect(reactor?.days.map((d) => d.failed_calls_on_passed)).toEqual([0, 1])
    expect(reactor?.days.map((d) => d.wrong_tool_calls)).toEqual([0, 1])
    expect(plain?.days.map((d) => d.failed_calls_on_passed)).toEqual([0, 0])
    const table = tableOf([plain!, reactor!])
    expect(table).toContain('| Wrong tool calls | Failed calls on passed tasks |')
    expect(table).toContain('with 1 wrong tool calls and 1 failed calls on passed tasks on the reactor arm')
  })

  it('writes every field of the results.json contract and nothing else', () => {
    const failed = [PLAIN_DAYS[0] ?? [], (PLAIN_DAYS[1] ?? []).map((t) => ({ ...t, passed: false }))]
    const results = scoreRuns([readRun(writeRun('plain', PLAIN_DAYS)), readRun(writeRun('reactor', failed))])
    const out = scratch()
    const files = writeResults(out, results)
    expect(files.map((f) => f.slice(out.length + 1)).sort()).toEqual([
      'fixture-1-support-ops/plain/results.json',
      'fixture-1-support-ops/reactor/results.json',
    ])
    for (const file of files) {
      const r = JSON.parse(readFileSync(file, 'utf8')) as Results
      expect(Object.keys(r).sort()).toEqual(CONTRACT)
      expect({ benchmark: r.benchmark, version: r.version, harness_commit: r.harness_commit }).toEqual({
        benchmark: 'repeat-bill',
        version: '0.1',
        harness_commit: COMMIT,
      })
      expect(typeof r.notes).toBe('string')
      for (const day of r.days) {
        expect(Object.keys(day).sort()).toEqual(DAY_CONTRACT)
      }
    }
    const [plain, reactor] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Results)
    expect(plain).toMatchObject({ arm: 'plain', small_model: null, prices: { 'big-model': { in_per_mtok: 10 } } })
    expect(reactor).toMatchObject({ arm: 'reactor', small_model: 'small-model' })
    expect(reactor?.days[1]).toMatchObject({ passed: 0, cost_per_solved_usd: null, wrong_tool_calls: 2 })
    expect(plain?.days[0]).toMatchObject({ tasks: 3, passed: 3, tool_steps: 6, talk_steps: 3, cost_usd: 0.12 })
    expect(plain?.days[1]?.median_task_seconds).toBe(3)
    expect(reactor?.notes).toContain("The reactor arm's cost is a floor, so its saving is a ceiling")
    expect(plain?.notes).toContain('wrong_tool_calls is null on the plain arm')
  })

  it('leaves wrong_tool_calls null on a reactor arm scored without its plain arm, and says why', () => {
    const { reactor } = score(writeRun('reactor', PLAIN_DAYS))
    expect(reactor?.days.map((d) => d.wrong_tool_calls)).toEqual([null, null])
    expect(reactor?.notes).toContain('no plain arm of this run was scored with it')
  })

  it('refuses two arms that differ on the large model, and a run that did not finish', () => {
    expect(() =>
      scoreRuns([
        readRun(writeRun('plain', PLAIN_DAYS)),
        readRun(writeRun('reactor', PLAIN_DAYS, { large_model: 'other-model' })),
      ]),
    ).toThrow(/differ on large_model/)
    expect(() => readRun(writeRun('plain', PLAIN_DAYS, { finished_at: null }))).toThrow(/not finished/)
    expect(() => readRun(writeRun('plain', PLAIN_DAYS, { tasks_per_day: 4 }))).toThrow(/6 of 8 tasks/)
  })

  it('refuses two arms costed at different prices for the large model', () => {
    const dearer = {
      'big-model': { in_per_mtok: 20, out_per_mtok: 30 },
      'small-model': { in_per_mtok: 1, out_per_mtok: 2 },
    }
    expect(() =>
      scoreRuns([readRun(writeRun('plain', PLAIN_DAYS)), readRun(writeRun('reactor', PLAIN_DAYS, { prices: dearer }))]),
    ).toThrow(/costed at different prices for big-model/)
  })

  it('refuses two arms run with different request timeouts', () => {
    expect(() =>
      scoreRuns([
        readRun(writeRun('plain', PLAIN_DAYS)),
        readRun(writeRun('reactor', PLAIN_DAYS, { timeout_seconds: 10 })),
      ]),
    ).toThrow(/differ on timeout_seconds/)
  })

  it('refuses two arms asked in different words, and reads a run.json with no words as asked in new words', () => {
    const sameReactor = readRun(writeRun('reactor', PLAIN_DAYS, { words: 'same' }))
    expect(() => scoreRuns([readRun(writeRun('plain', PLAIN_DAYS)), sameReactor])).toThrow(
      /^run fixture-1: the arms differ on words \(plain new, reactor same\)$/,
    )
    // JSON drops an undefined field, so this is a run.json written before the setting existed.
    const older = writeRun('plain', PLAIN_DAYS, { words: undefined })
    expect(readFileSync(join(older, 'run.json'), 'utf8')).not.toContain('words')
    expect(readRun(older).run.words).toBe('new')
    expect(score(older, writeRun('reactor', PLAIN_DAYS)).reactor?.days.map((d) => d.wrong_tool_calls)).toEqual([0, 0])
    expect(() => scoreRuns([readRun(older), sameReactor])).toThrow(/differ on words \(plain new, reactor same\)/)
  })

  it('refuses a run.json whose words are neither new nor same', () => {
    for (const words of ['Same', 'reused', null]) {
      const dir = writeRun('plain', PLAIN_DAYS, { words: words as Words })
      expect(() => readRun(dir)).toThrow(/words must be new or same/)
    }
  })

  it('scores two arms asked in the same words every round, and says so in the notes and the heading only then', () => {
    expect(SAME_WORDS_NOTE).toContain('--words same')
    const same = scoredPair('same')
    expect(same.map((r) => r.arm)).toEqual(['plain', 'reactor'])
    for (const r of same) {
      expect(Object.keys(r).sort()).toEqual(CONTRACT)
      expect(r.notes.startsWith(`${SAME_WORDS_NOTE} `)).toBe(true)
    }
    expect(tableOf(same)).toContain('## support-ops, run fixture-1, the same words every round\n')
    const fresh = scoredPair('new')
    expect(fresh.filter((r) => r.notes.includes(SAME_WORDS_NOTE))).toEqual([])
    expect(tableOf(fresh)).toContain('## support-ops, run fixture-1\n')
  })

  it('says day 1 is not cold, naming the earlier run, on a reactor arm whose key the ledger had seen', () => {
    const { plain, reactor } = score(
      writeRun('plain', PLAIN_DAYS),
      writeRun('reactor', PLAIN_DAYS, { key_seen_before: true, key_earlier_run_id: 'fg1' }),
    )
    expect(reactor?.notes).toContain('The Reactor key was used by run fg1 before this run: day 1 is not cold.')
    expect(reactor?.notes).not.toContain('Day 1 is cold only if')
    expect(Object.keys(reactor ?? {}).sort()).toEqual(CONTRACT)
    expect(plain?.notes).not.toMatch(/Reactor key|reactor key/)
  })

  it('says what the ledger saw of a key it had not seen, and keeps the old sentence for a run it did not check', () => {
    const fresh = score(writeRun('reactor', PLAIN_DAYS, { key_seen_before: false })).reactor
    expect(fresh?.notes).toContain(
      "Day 1 is cold only if the reactor key's account had never run this benchmark. The harness's key ledger on the machine that ran it had not seen this key at this base URL; it sees keys, not accounts, so a new key on an account that ran this benchmark before would not show there, nor would a key used through another base URL, on another machine or before the ledger existed.",
    )
    expect(fresh?.notes).not.toContain('nothing here checks it')
    // JSON drops an undefined field, so this is a run.json written before the key ledger existed.
    const older = writeRun('reactor', PLAIN_DAYS, { key_seen_before: undefined, key_earlier_run_id: undefined })
    expect(readFileSync(join(older, 'run.json'), 'utf8')).not.toMatch(/key_seen_before|key_earlier_run_id/)
    expect(readRun(older).run).toMatchObject({ key_seen_before: null, key_earlier_run_id: null })
    expect(score(older).reactor?.notes).toContain(
      'Day 1 is cold only if the reactor key had never run this benchmark; whoever ran it declares that, and nothing here checks it.',
    )
  })

  it('refuses a run.json whose key fields the harness could not have written', () => {
    const dir = writeRun('reactor', PLAIN_DAYS, { key_seen_before: 'yes' as unknown as boolean })
    expect(() => readRun(dir)).toThrow(/key_seen_before must be true, false or null/)
    for (const over of [
      { key_seen_before: true, key_earlier_run_id: null },
      { key_seen_before: true, key_earlier_run_id: '../escape' },
      { key_seen_before: false, key_earlier_run_id: 'fg1' },
      { key_seen_before: null, key_earlier_run_id: 'fg1' },
    ]) {
      expect(() => readRun(writeRun('reactor', PLAIN_DAYS, over)), JSON.stringify(over)).toThrow(
        /key_earlier_run_id must name the earlier run exactly when key_seen_before is true/,
      )
    }
  })

  it('refuses a run in which a step answered as the large model, or by neither model, reported no usage', () => {
    for (const by of ['large', 'other'] as const) {
      const days = PLAIN_DAYS.map((day, d) =>
        d === 0
          ? day
          : day.map((t, i) =>
              i === 0 ? { ...t, steps: [{ kind: 'tool' as const, by, cost: 0, unreported: true }] } : t,
            ),
      )
      expect(() => readRun(writeRun('reactor', days))).toThrow(/1 steps .* reported no usage, so their cost is unknown/)
    }
  })

  it('refuses a run folder whose run.json names a run, a domain or an arm it could not have written', () => {
    expect(() => readRun(writeRun('plain', PLAIN_DAYS, { run_id: '../escape' }))).toThrow(/run_id/)
    expect(() => readRun(writeRun('plain', PLAIN_DAYS, { domain: '../escape' }))).toThrow(/domain/)
    expect(() => readRun(writeRun('plain', PLAIN_DAYS, { arm: 'other' as Arm }))).toThrow(/arm/)
  })

  it('says nothing about a reactor floor in a table with no reactor arm', () => {
    expect(tableOf(scoreRuns([readRun(writeRun('plain', PLAIN_DAYS))]))).not.toContain(
      "The reactor arm's cost is a floor",
    )
  })

  it('reads the saving over days 2 to 3 from summed cost and summed passes, not an average of days', () => {
    const t = (name: string, passed: boolean, cost: number): TaskSpec => task(name, passed, [large(cost, 'talk')])
    const day3 = [t('a', true, 0.08), t('b', false, 0.08), t('c', false, 0.08)]
    const plainDays = [['a', 'b', 'c'].map((n) => t(n, true, 0.04)), ['a', 'b', 'c'].map((n) => t(n, true, 0.04)), day3]
    const reactorDays = [plainDays[0] ?? [], ['a', 'b', 'c'].map((n) => t(n, true, 0.02)), day3]
    const { plain, reactor } = score(writeRun('plain', plainDays), writeRun('reactor', reactorDays))
    const table = tableOf([plain, reactor].filter((r): r is Results => r !== undefined))
    // Summed: 1 - (0.30 / 4) / (0.36 / 4) = 16.7%; a mean of the daily savings would read 25.0%.
    expect(table).toContain(
      'Days 2 to 3 together: saving 16.7%, with 0 wrong tool calls and 0 failed calls on passed tasks on the reactor arm.',
    )
  })

  it('takes the mean of the middle two task times on a day with an even number of tasks', () => {
    const day = [1, 2, 10, 20].map((s, i) => task(`t${i}`, true, [large(0.01, 'talk')], s))
    const { plain } = score(writeRun('plain', [day], { tasks_per_day: 4 }))
    expect(plain?.days[0]?.median_task_seconds).toBe(6)
  })

  it('names the gaps it counted in notes: unreported usage, a model it did not expect, errors', () => {
    const odd = [
      PLAIN_DAYS[0] ?? [],
      [
        task('a', true, [served, { kind: 'tool', by: 'other', cost: 0.01 }, large(0.02, 'talk')]),
        task('b', false, [{ kind: 'error', cost: 0 }]),
        task('c', true, [large(0.01), large(0.02, 'talk')]),
      ],
    ]
    const { reactor } = score(writeRun('reactor', odd))
    expect(reactor?.notes).toContain('1 steps reported no usage and are counted at $0.')
    expect(reactor?.notes).toContain('1 steps named neither model and are priced as the large model.')
    expect(reactor?.notes).toContain('1 tasks ended on an error from the endpoint, and count as failed.')
  })

  const render = join(BENCH, 'publish', 'render.mjs')
  it.skipIf(!existsSync(render))('writes files the publication kit renders without refusal', async () => {
    const out = scratch()
    writeResults(out, scoreRuns([readRun(writeRun('plain', PLAIN_DAYS)), readRun(writeRun('reactor', PLAIN_DAYS))]))
    const page = join(scratch(), 'index.html')
    const result = await node([render, '--in', out, '--out', page])
    expect(result).toMatchObject({ code: 0 })
  })

  it.skipIf(!existsSync(render))('renders a same-words pair through the kit, its note on the page', async () => {
    const out = scratch()
    writeResults(out, scoredPair('same'))
    const page = join(scratch(), 'index.html')
    const result = await node([render, '--in', out, '--out', page])
    expect(result).toMatchObject({ code: 0 })
    const html = readFileSync(page, 'utf8')
    expect(html).toContain(SAME_WORDS_NOTE)
    expect(html).toContain('<p class="fine" data-words="same">same words:')
  })
})

const node = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })

describe('the time a step takes', () => {
  // 2026-11-09: wall time per tool step, by who filled it, beside a plain step's.
  const timed = (at: number, spec: Partial<StepSpec> = {}): StepSpec => ({
    kind: 'tool',
    by: 'large',
    cost: 0,
    at,
    ...spec,
  })
  const plainDays: TaskSpec[][] = [
    [
      task('a', true, [timed(1000), timed(2500), { ...large(0, 'talk'), at: 3000 }]),
      task('b', true, [timed(2000), timed(4000), { ...large(0, 'talk'), at: 4500 }]),
      task('c', true, [large(0), large(0), large(0, 'talk')]),
    ],
  ]
  const playbookDays: TaskSpec[][] = [
    [
      task('a', true, [
        { kind: 'door', cost: 0, route: 'playbooks', said: 'plan', at: 300 },
        timed(800, { by: 'none', filled: 'ask' }),
        timed(2800, { by: 'large', filled: 'large' }),
        timed(3300, { by: 'small', filled: 'small' }),
        timed(5300, { by: 'large', route: 'playbooks/pass' }),
        { ...large(0, 'talk'), at: 6000, route: 'playbooks/pass' },
      ]),
      task('b', true, [timed(400, { by: 'none', filled: 'result' }), { ...large(0, 'talk'), at: 900 }]),
      task('c', true, [large(0), large(0, 'talk')]),
    ],
  ]
  const both = () => {
    const results = scoreRuns([readRun(writeRun('plain', plainDays)), readRun(writeRun('playbook', playbookDays))])
    return { plain: results.find((r) => r.arm === 'plain'), playbook: results.find((r) => r.arm === 'playbook') }
  }

  it('times each tool step from the step before it, by who filled it, leaving out a job with no clock', () => {
    const { plain, playbook } = both()
    expect(plain?.days[0]?.step_ms).toEqual({ plain: { steps: 4, median_ms: 1750, p90_ms: 2000 } })
    expect(playbook?.days[0]?.step_ms).toEqual({
      no_model: { steps: 2, median_ms: 600, p90_ms: 800 },
      large: { steps: 1, median_ms: 2000, p90_ms: 2000 },
      small: { steps: 1, median_ms: 500, p90_ms: 500 },
      handed_back: { steps: 1, median_ms: 2000, p90_ms: 2000 },
    })
  })

  it('writes no step times for a day whose lines carry no clock, as runs before 2026-11-09', () => {
    const { plain } = score(writeRun('plain', PLAIN_DAYS), writeRun('reactor', PLAIN_DAYS))
    expect(plain?.days[0]).not.toHaveProperty('step_ms')
  })

  it("puts each gear's step time in the table beside the plain step's, and what it adds to it", () => {
    const table = jobTableOf([readRun(writeRun('plain', plainDays)), readRun(writeRun('playbook', playbookDays))])
    expect(table).toContain('time per tool step')
    expect(table).toContain('| 1 | plain | 4 | 1750 | 2000 | - | - |')
    expect(table).toContain('| 1 | no model | 2 | 600 | 800 | -1150 | -1200 |')
    expect(table).toContain('| 1 | small model | 1 | 500 | 500 | -1250 | -1500 |')
    expect(table).toContain('| 1 | large model, at the door | 1 | 2000 | 2000 | +250 | 0 |')
    expect(table).toContain('| 1 | handed back to the agent | 1 | 2000 | 2000 | +250 | 0 |')
  })
})

describe('end to end, through the command line', () => {
  it('runs both arms against a fake endpoint and scores them into results.json and a table', async () => {
    const domain = domainNamed('support-ops')
    const provider = await startFake({ domain, seed: 4, days: 2 })
    const door = await startFake({
      domain,
      seed: 4,
      days: 2,
      small: { name: 'small-model', when: (inst, step) => inst.day === 2 && step === 0 },
    })
    const root = scratch()
    const prices = join(root, 'prices.json')
    writeFileSync(
      prices,
      JSON.stringify({
        unit: 'test',
        models: {
          'big-model': { in_per_mtok: 10, out_per_mtok: 30, source: 'test', date: 'test' },
          'small-model': { in_per_mtok: 1, out_per_mtok: 2, source: 'test', date: 'test' },
        },
      }),
    )
    const cli = join(BENCH, 'cli.ts')
    const common = ['--domain', 'support-ops', '--run-id', 'e2e', '--key', 'E2E_KEY']
    const tail = ['--large', 'big-model', '--days', '2', '--seed', '4', '--prices', prices]
    try {
      const plain = await node(
        [cli, 'run', '--arm', 'plain', '--base-url', provider.url, ...common, ...tail, '--out', join(root, 'plain')],
        { E2E_KEY: 'k' },
      )
      expect(plain).toMatchObject({ code: 0 })
      const reactor = await node(
        [
          cli,
          'run',
          '--arm',
          'reactor',
          '--base-url',
          door.url,
          ...common,
          ...tail,
          '--small',
          'small-model',
          '--settle-seconds',
          '0',
          '--ledger',
          join(root, 'keys.json'),
          '--out',
          join(root, 'reactor'),
        ],
        { E2E_KEY: 'k' },
      )
      expect(reactor).toMatchObject({ code: 0 })
    } finally {
      await provider.close()
      await door.close()
    }
    const out = join(root, 'scored')
    const scored = await node([cli, 'score', '--in', join(root, 'plain'), '--in', join(root, 'reactor'), '--out', out])
    expect(scored).toMatchObject({ code: 0 })
    const read = (arm: Arm): Results =>
      JSON.parse(
        readFileSync(resultsPath(out, { run_id: 'e2e', domain: 'support-ops', arm } as Results), 'utf8'),
      ) as Results
    const [plain, reactor] = [read('plain'), read('reactor')]
    expect(plain.days.map((d) => [d.tasks, d.passed, d.small_model_tool_steps])).toEqual([
      [20, 20, 0],
      [20, 20, 0],
    ])
    expect(reactor.days.map((d) => [d.tasks, d.passed, d.small_model_tool_steps, d.wrong_tool_calls])).toEqual([
      [20, 20, 0, 0],
      [20, 20, 20, 0],
    ])
    expect(reactor.harness_commit).toBe(plain.harness_commit)
    expect(reactor.notes).toContain("The harness's key ledger on the machine that ran it had not seen this key")
    const saved = saving(reactor.days[1]?.cost_per_solved_usd ?? null, plain.days[1]?.cost_per_solved_usd ?? null)
    expect(saved).toBeGreaterThan(0)
    const table = readFileSync(join(out, 'table.md'), 'utf8')
    expect(table).toContain('## support-ops, run e2e')
    expect(table).toContain('Days 2 to 2 together: saving')
  }, 60_000)
})

describe('the README', () => {
  it('shows the estimate the estimate command prints today, from prices.json', () => {
    const readme = readFileSync(join(BENCH, 'README.md'), 'utf8')
    expect(readme).toContain(estimateTable(DOMAINS, loadPrices(), 1))
  })

  it('documents every results.json field', () => {
    const readme = readFileSync(join(BENCH, 'README.md'), 'utf8')
    for (const field of [...CONTRACT, ...DAY_CONTRACT]) {
      expect(readme).toContain(`\`${field}\``)
    }
  })
})

describe('the score command', { timeout: 60_000 }, () => {
  it('writes the table where --table says', async () => {
    const out = scratch()
    const table = join(scratch(), 'nested', 'table.md')
    mkdirSync(dirname(table), { recursive: true })
    const result = await node([
      join(BENCH, 'cli.ts'),
      'score',
      '--in',
      writeRun('plain', PLAIN_DAYS),
      '--out',
      out,
      '--table',
      table,
    ])
    expect(result).toMatchObject({ code: 0 })
    expect(readFileSync(table, 'utf8')).toContain('| 1 | plain | 100.0% (3/3) | 6 | 0.0% | $0.0400 | n/a | 0 |  |')
  })

  it("counts each day's and each job's tool steps by the model that answered them, beside passes, wrong tool calls and cost", async () => {
    // Day 2 on the reactor arm: a fails with both tool steps on the small model, b ends on an error, and c passes
    // with one tool step on the small model and one that named neither model.
    const mixed = [
      PLAIN_DAYS[0] ?? [],
      [
        task('a', false, [served, served, large(0.02, 'talk')]),
        task('b', false, [{ kind: 'error', cost: 0 }]),
        task('c', true, [served, { kind: 'tool', by: 'other', cost: 0.01 }, large(0.02, 'talk')]),
      ],
    ]
    const out = scratch()
    const result = await node([
      join(BENCH, 'cli.ts'),
      'score',
      '--in',
      writeRun('plain', PLAIN_DAYS),
      '--in',
      writeRun('reactor', mixed),
      '--out',
      out,
    ])
    expect(result).toMatchObject({ code: 0 })
    const table = readFileSync(join(out, 'table.md'), 'utf8')
    expect(table).toContain('## support-ops, run fixture-1: tool steps by the model that answered, per job')
    expect(table).toContain(
      '| Day | Job | Arm | Pass rate | Tool steps | Large model | Small model | Neither | Wrong tool calls | Failed calls on passed tasks | Cost |',
    )
    for (const row of [
      '| 1 | a | reactor | 100.0% (1/1) | 2 | 2 | 0 | 0 | 0 | 0 | $0.0400 |',
      '| 2 | a | plain | 100.0% (1/1) | 2 | 2 | 0 | 0 | n/a | 0 | $0.0400 |',
      '| 2 | a | reactor | 0.0% (0/1) | 2 | 0 | 2 | 0 | 1 | 0 | $0.0200 |',
      '| 2 | b | reactor | 0.0% (0/1) | 0 | 0 | 0 | 0 | 1 | 0 | $0.0000 |',
      '| 2 | c | plain | 0.0% (0/1) | 2 | 2 | 0 | 0 | n/a | 0 | $0.0400 |',
      '| 2 | c | reactor | 100.0% (1/1) | 2 | 0 | 1 | 1 | 0 | 0 | $0.0300 |',
      '| 2 | all jobs | plain | 66.7% (2/3) | 6 | 6 | 0 | 0 | n/a | 0 | $0.1200 |',
      '| 2 | all jobs | reactor | 33.3% (1/3) | 4 | 0 | 3 | 1 | 2 | 0 | $0.0500 |',
    ]) {
      expect(table).toContain(row)
    }
  })
})

describe('the job table', () => {
  it("reads a verdict the library's rounds settled on from the round's line, as the route's own, once", () => {
    // Under Door 2 the playbook and reply routes answer run_model first, and the verdict comes on the settling round's
    // line; the 2026-11-04 rerun's table read null on both and counted no small reply and no template. One reply here,
    // written small on a template run: column one, and nothing in the others.
    const door = (route: string, said: string, settles?: string): StepSpec => ({
      kind: 'door',
      cost: 0,
      route,
      said,
      ...(settles === undefined ? {} : { settles }),
    })
    const days = [
      [
        task('a', true, [
          door('playbooks', 'run_model'),
          door('playbooks/answer', 'template', 'playbooks'),
          served,
          door('playbooks/reply', 'run_model'),
          door('playbooks/answer', 'words', 'playbooks/reply'),
        ]),
        task('b', true, [served]),
        task('c', true, [served]),
      ],
    ]
    const table = jobTableOf([readRun(writeRun('playbook', days))])
    expect(table).toContain('| 1 | 1 | 0 | 0 | 0 | - |')
  })

  it('writes n/a for wrong tool calls on a reactor arm scored without its plain arm', () => {
    const table = jobTableOf([readRun(writeRun('reactor', PLAIN_DAYS))])
    expect(table).toContain('| 1 | a | reactor | 100.0% (1/1) | 2 | 2 | 0 | 0 | n/a | 0 | $0.0400 |')
    expect(table).toContain('| 2 | all jobs | reactor | 66.7% (2/3) | 6 | 6 | 0 | 0 | n/a | 0 | $0.1200 |')
  })

  it('writes no row for a job an arm did not run that day', () => {
    // readRun refuses a run missing a task, so this arm is cut after it is read: the table writes no 0/0 row for it.
    const full = readRun(writeRun('reactor', PLAIN_DAYS))
    const ran = <T extends { day: number; template: string }>(line: T): boolean =>
      !(line.day === 2 && line.template === 'c')
    const cut = { ...full, tasks: full.tasks.filter(ran), steps: full.steps.filter(ran) }
    const table = jobTableOf([readRun(writeRun('plain', PLAIN_DAYS)), cut])
    expect(table).toContain('| 2 | c | plain | 0.0% (0/1) | 2 | 2 | 0 | 0 | n/a | 0 | $0.0400 |')
    expect(table).not.toContain('| 2 | c | reactor |')
    expect(table).toContain('| 2 | all jobs | reactor | 100.0% (2/2) | 4 | 4 | 0 | 0 | 0 | 0 | $0.0800 |')
  })
})
