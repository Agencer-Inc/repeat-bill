import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { KeyUse } from '../harness/ledger.ts'
import { useKey } from '../harness/ledger.ts'
import type { PriceBook } from '../harness/prices.ts'
import { servedBy } from '../harness/prices.ts'
import type { Deps, Job, Trace } from '../harness/playbook-client.ts'
import {
  ASK_BYTES,
  CALL_BYTES,
  REPORT_STEPS,
  RESULT_BYTES,
  SYSTEM_BYTES,
  TOOLS_BYTES,
  playJob,
  stepLineOf,
} from '../harness/playbook-client.ts'
import type { Answer, RunOptions, RunRecord, StepLine, TaskLine } from '../harness/run.ts'
import { capOf, harnessCommit, runArm, toolFailed } from '../harness/run.ts'
import { jobTableOf, readRun, scoreRuns, tableOf } from '../score/score.ts'
import { DOMAINS, domainNamed } from '../tasks/domains.ts'
import type { Domain, Effect, Instance, Session, Words } from '../tasks/shared.ts'
import { need } from '../tasks/shared.ts'
import type { Door, DoorOptions, DoorStep, Planned } from './fake-playbook-door.ts'
import { plannedOf, startDoor } from './fake-playbook-door.ts'
import type { Fake, FakeOptions } from './fake-model.ts'
import { startFake, usageAt } from './fake-model.ts'

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..')

const PRICES: PriceBook = {
  unit: 'test prices',
  models: {
    'big-model': { in_per_mtok: 10, out_per_mtok: 30, source: 'test', date: 'test' },
    'small-model': { in_per_mtok: 1, out_per_mtok: 2, source: 'test', date: 'test' },
  },
}

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'repeat-bill-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const lines = <T>(file: string): T[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as T)

interface Ran {
  fake: Fake
  out: string
  sleeps: number[]
  record: RunRecord
  steps: StepLine[]
  tasks: TaskLine[]
}

const ran = async (fakeOpts: FakeOptions, run: Partial<RunOptions> & Pick<RunOptions, 'arm'>): Promise<Ran> => {
  const fake = await startFake(fakeOpts)
  const out = scratch()
  const sleeps: number[] = []
  try {
    const record = await runArm({
      domain: fakeOpts.domain,
      days: fakeOpts.days,
      seed: fakeOpts.seed,
      baseUrl: fake.url,
      key: 'test-key',
      large: 'big-model',
      small: null,
      runId: 'run-1',
      out,
      prices: PRICES,
      harnessCommit: 'abc123',
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      ...run,
    })
    return {
      fake,
      out,
      sleeps,
      record,
      steps: lines(join(out, 'steps.jsonl')),
      tasks: lines(join(out, 'tasks.jsonl')),
    }
  } finally {
    await fake.close()
  }
}

const bigCost = (step: number): number => {
  const u = usageAt(step)
  return (u.prompt_tokens * 10 + u.completion_tokens * 30) / 1_000_000
}

describe('servedBy reads which model answered from the name the response gives', () => {
  it.each([
    ['gpt-4.1', 'large'],
    ['gpt-4.1-2025-04-14', 'large'],
    ['gpt-4.1-20250414', 'large'],
    ['gpt-4.1-mini', 'small'],
    ['gpt-4.1-mini-2025-04-14', 'small'],
    ['gpt-4.1-nano', 'other'],
    ['gpt-4.10', 'other'],
    ['gpt-4.1-preview', 'other'],
    ['gpt-4.1-2025-04', 'other'],
    [undefined, 'other'],
  ])('%s with large gpt-4.1 and small gpt-4.1-mini is %s', (model, by) => {
    expect(servedBy(model, 'gpt-4.1', 'gpt-4.1-mini')).toBe(by)
  })

  it('takes nothing as the small model on the plain arm', () => {
    expect(servedBy('gpt-4.1-mini', 'gpt-4.1', null)).toBe('other')
    expect(servedBy('claude-sonnet-5-5-20260929', 'claude-sonnet-5-5', null)).toBe('large')
  })
})

describe("a tool's own refusal, counted on the step", () => {
  // 2026-10-23: a failed tool call on a task that still passed is its own column in the scorer.
  it("reads the bench tools' refusal shape and nothing else as a failed call", () => {
    expect(toolFailed({ error: 'order O-1 not found' })).toBe(true)
    expect(toolFailed({ error: 'arguments must be a JSON object' })).toBe(true)
    expect(toolFailed({ order_id: 'O-1', total: 42 })).toBe(false)
    expect(toolFailed({ error: null })).toBe(false)
    expect(toolFailed([{ error: 'x' }])).toBe(false)
    expect(toolFailed('error')).toBe(false)
  })
})

/** Each job's lines carry the ms since the job started, whole, from 0 to its own seconds and never going back. */
const expectClocked = (steps: readonly StepLine[], tasks: readonly TaskLine[]): void => {
  expect(steps.length).toBeGreaterThan(0)
  for (const t of tasks) {
    const ats = steps.filter((s) => s.instance === t.instance).map((s) => s.at_ms)
    expect(ats.length, t.instance).toBeGreaterThan(0)
    for (const at of ats) {
      expect(Number.isInteger(at), t.instance).toBe(true)
      expect(at!, t.instance).toBeGreaterThanOrEqual(0)
      expect(at!, t.instance).toBeLessThanOrEqual(Math.ceil(t.seconds * 1000) + 1)
    }
    expect(
      [...ats].sort((a, b) => a! - b!),
      t.instance,
    ).toEqual(ats)
  }
}

describe('the plain arm', () => {
  const domain = domainNamed('support-ops')
  let r: Ran
  beforeAll(async () => {
    r = await ran({ domain, seed: 5, days: 1 }, { arm: 'plain' })
  })

  it('runs every task to a pass against a model that plays the reference solutions', () => {
    expect(r.tasks).toHaveLength(20)
    expect(r.tasks.filter((t) => !t.passed)).toEqual([])
  })

  it('stamps each step line with when it ended, in ms since its job started (2026-11-09)', () => {
    expectClocked(r.steps, r.tasks)
  })

  it('writes one step line per model response, tool steps then one talk step, priced to the cent', () => {
    const instances = domain.instances(5, 1)
    expect(r.steps).toHaveLength(instances.reduce((n, i) => n + i.solve().calls.length + 1, 0))
    for (const inst of instances) {
      const mine = r.steps.filter((s) => s.instance === inst.id)
      const calls = inst.solve().calls
      expect(mine.map((s) => s.kind)).toEqual([...calls.map(() => 'tool'), 'talk'])
      expect(mine.map((s) => s.tool)).toEqual([...calls.map((c) => c.tool), null])
      mine.forEach((s, i) => {
        expect(s).toMatchObject({
          run_id: 'run-1',
          arm: 'plain',
          domain: 'support-ops',
          day: 1,
          template: inst.template,
          step: i + 1,
          served_by: 'large',
          response_model: 'big-model',
          prompt_tokens: usageAt(i).prompt_tokens,
          completion_tokens: usageAt(i).completion_tokens,
          usage_reported: true,
          retries: 0,
          error: null,
        })
        expect(s.cost_usd).toBe(bigCost(i))
      })
    }
    const total = r.steps.reduce((sum, s) => sum + s.cost_usd, 0)
    const expected = instances.reduce(
      (sum, inst) => sum + [...inst.solve().calls, null].reduce((acc, _, i) => acc + bigCost(i), 0),
      0,
    )
    expect(Math.round(total * 100)).toBe(Math.round(expected * 100))
    expect(total).toBeGreaterThan(0.5)
  })

  it('records the run with no small model and no wait between days', () => {
    expect(JSON.parse(readFileSync(join(r.out, 'run.json'), 'utf8'))).toMatchObject({
      benchmark: 'repeat-bill',
      version: '0.1',
      run_id: 'run-1',
      arm: 'plain',
      domain: 'support-ops',
      days: 1,
      tasks_per_day: 20,
      seed: 5,
      words: 'new',
      large_model: 'big-model',
      small_model: null,
      max_steps: 25,
      timeout_seconds: 120,
      settle_seconds: 0,
      prices: { 'big-model': { in_per_mtok: 10, out_per_mtok: 30 } },
      harness_commit: 'abc123',
    })
    expect(r.record.finished_at).not.toBeNull()
    expect(r.sleeps).toEqual([])
  })

  it('sends what an OpenAI client sends: buffered, one tool call a turn, no reactor header', () => {
    expect(r.fake.seen.length).toBe(r.steps.length)
    for (const { headers, body } of r.fake.seen) {
      expect(headers.authorization).toBe('Bearer test-key')
      expect(headers['x-reactor-run']).toBeUndefined()
      expect(body.stream).toBeUndefined()
      expect(body.stream_options).toBeUndefined()
      expect(body.parallel_tool_calls).toBe(false)
      expect(body.model).toBe('big-model')
      expect(body.tools).toEqual(domain.tools)
      const messages = body.messages as { role: string; content: unknown; tool_calls?: { id: string }[] }[]
      expect(messages[0]).toEqual({ role: 'system', content: domain.system })
      messages.forEach((m, i) => {
        for (const [j, call] of (m.tool_calls ?? []).entries()) {
          expect(messages[i + 1 + j]).toMatchObject({ role: 'tool', tool_call_id: call.id })
        }
      })
    }
  })

  it('refuses to write another run into the same folder', async () => {
    const fake = await startFake({ domain, seed: 5, days: 1 })
    try {
      await expect(
        runArm({
          arm: 'plain',
          domain,
          days: 1,
          seed: 5,
          baseUrl: fake.url,
          key: 'test-key',
          large: 'big-model',
          small: null,
          runId: 'run-1',
          out: r.out,
          prices: PRICES,
          harnessCommit: 'abc123',
        }),
      ).rejects.toThrow(/already holds a run/)
    } finally {
      await fake.close()
    }
  })

  it('refuses a base URL it cannot read before anything is written, on the plain and reactor arms', async () => {
    const seen: Record<string, { made: boolean; used: string }> = {}
    for (const arm of ['plain', 'reactor'] as const) {
      const opts = {
        arm,
        domain,
        days: 1,
        seed: 5,
        baseUrl: 'http://',
        key: 'test-key',
        large: 'big-model',
        small: arm === 'plain' ? null : 'small-model',
        runId: 'run-bad-url',
        prices: PRICES,
        harnessCommit: 'abc123',
      }
      const out = join(scratch(), 'run')
      await expect(runArm({ ...opts, out })).rejects.toThrow(/^Invalid URL$/)
      // A folder that already holds a run is refused for its URL first.
      const used = await runArm({ ...opts, out: r.out }).then(
        () => 'ran',
        (err: Error) => err.message,
      )
      seen[arm] = { made: existsSync(out), used }
    }
    expect(seen).toEqual({
      plain: { made: false, used: 'Invalid URL' },
      reactor: { made: false, used: 'Invalid URL' },
    })
  })
})

describe('the reactor arm', () => {
  const domain = domainNamed('files-ops')
  let r: Ran
  beforeAll(async () => {
    r = await ran(
      {
        domain,
        seed: 9,
        days: 2,
        small: { name: 'small-model', when: (inst, step) => inst.day === 2 && step === 0 },
      },
      { arm: 'reactor', small: 'small-model', runId: 'run-2' },
    )
  })

  it('reads a step the small model answered with no usage as $0, with its tokens unknown', () => {
    const served = r.steps.filter((s) => s.served_by === 'small')
    expect(served).toHaveLength(20)
    for (const s of served) {
      expect(s).toMatchObject({
        day: 2,
        step: 1,
        kind: 'tool',
        response_model: 'small-model',
        prompt_tokens: null,
        completion_tokens: null,
        usage_reported: false,
        cost_usd: 0,
      })
    }
    const large = r.steps.filter((s) => s.served_by === 'large')
    expect(large.length + served.length).toBe(r.steps.length)
    expect(large.every((s) => s.usage_reported && s.cost_usd > 0)).toBe(true)
    expect(r.tasks.filter((t) => !t.passed)).toEqual([])
  })

  it('sends each task as its own reactor run, named by the run id and the task', () => {
    const idOf = new Map(domain.instances(9, 2).map((i) => [i.ask, i.id]))
    const names = r.fake.seen.map(({ headers, body }) => {
      const ask = (body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')?.content
      expect(headers['x-reactor-run']).toBe(`run-2.${idOf.get(ask ?? '')}`)
      return headers['x-reactor-run']
    })
    expect(new Set(names).size).toBe(40)
  })

  it('waits the settle time once between days, and records it', () => {
    expect(r.sleeps).toEqual([65_000])
    expect(r.record).toMatchObject({ arm: 'reactor', small_model: 'small-model', settle_seconds: 65, days: 2 })
    expect(r.record.prices).toEqual({
      'big-model': { in_per_mtok: 10, out_per_mtok: 30 },
      'small-model': { in_per_mtok: 1, out_per_mtok: 2 },
    })
  })
})

describe('a task that goes wrong', () => {
  const domain = domainNamed('support-ops')

  it('fails on a wrong acting call, stops at 25 steps, and reads dated model names as the large model', async () => {
    const r = await ran(
      {
        domain,
        seed: 6,
        days: 1,
        wrong: new Set(['support-ops.d1.refund-full']),
        endless: new Set(['support-ops.d1.talk-postcode']),
        largeAs: (asked) => `${asked}-2026-08-06`,
      },
      { arm: 'plain' },
    )
    const byTemplate = new Map(r.tasks.map((t) => [t.template, t]))
    expect(byTemplate.get('refund-full')).toMatchObject({ passed: false, capped: false })
    expect(byTemplate.get('talk-postcode')).toMatchObject({ passed: false, capped: true, steps: 25 })
    expect(byTemplate.get('talk-postcode')?.reason).toMatch(/no reply within 25 steps/)
    expect(r.tasks.filter((t) => !t.passed).map((t) => t.template)).toEqual(['refund-full', 'talk-postcode'])
    expect(r.steps.every((s) => s.served_by === 'large' && s.response_model === 'big-model-2026-08-06')).toBe(true)
  })

  it('fails a task that hits the step cap, even when its end state is right', async () => {
    const r = await ran(
      { domain, seed: 6, days: 1, endless: new Set(['support-ops.d1.escalate-named']) },
      { arm: 'plain' },
    )
    expect(r.tasks.find((t) => t.template === 'escalate-named')).toMatchObject({ capped: true, passed: false })
  })

  it('reaches an endpoint whose base URL carries a query, and records the URL without it', async () => {
    const fake = await startFake({ domain, seed: 12, days: 1 })
    const out = scratch()
    try {
      const record = await runArm({
        arm: 'plain',
        domain,
        days: 1,
        seed: 12,
        baseUrl: `${fake.url}?api-version=QUERYVALUE`,
        key: 'test-key',
        large: 'big-model',
        small: null,
        runId: 'run-q',
        out,
        prices: PRICES,
        harnessCommit: 'abc123',
      })
      expect(record.base_url).toBe(fake.url)
      expect(readFileSync(join(out, 'run.json'), 'utf8')).not.toContain('QUERYVALUE')
      expect(fake.seen[0]?.url).toBe('/v1/chat/completions?api-version=QUERYVALUE')
      expect(lines<TaskLine>(join(out, 'tasks.jsonl')).every((t) => t.passed)).toBe(true)
    } finally {
      await fake.close()
    }
  })

  it('retries a 429 and a 5xx after 1 s then 4 s, and counts the retries on the step', async () => {
    const r = await ran({ domain, seed: 7, days: 1, statuses: [429, 503] }, { arm: 'plain' })
    expect(r.sleeps).toEqual([1000, 4000])
    expect(r.steps[0]).toMatchObject({ step: 1, retries: 2, kind: 'tool' })
    expect(r.steps.slice(1).every((s) => s.retries === 0)).toBe(true)
    expect(r.tasks.every((t) => t.passed)).toBe(true)
  })

  it('ends a task on a third 5xx with an error line carrying the status only, and goes on', async () => {
    const r = await ran({ domain, seed: 8, days: 1, statuses: [500, 500, 500] }, { arm: 'plain' })
    expect(r.steps[0]).toMatchObject({ kind: 'error', error: 'status 500', retries: 2, cost_usd: 0, served_by: null })
    expect(r.tasks[0]).toMatchObject({ passed: false, reason: 'status 500', steps: 1 })
    expect(r.tasks.slice(1).every((t) => t.passed)).toBe(true)
  })

  it('ends a task on a 2xx that carries no message, as an error', async () => {
    const r = await ran({ domain, seed: 8, days: 1, statuses: [200] }, { arm: 'plain' })
    expect(r.steps[0]).toMatchObject({ kind: 'error', error: 'a 2xx response with no message', retries: 0 })
    expect(r.tasks[0]).toMatchObject({ passed: false, reason: 'a 2xx response with no message', steps: 1 })
    expect(r.tasks.slice(1).every((t) => t.passed)).toBe(true)
  })

  it('does not retry any other refusal', async () => {
    const r = await ran({ domain, seed: 8, days: 1, statuses: [400] }, { arm: 'plain' })
    expect(r.sleeps).toEqual([])
    expect(r.steps[0]).toMatchObject({ kind: 'error', error: 'status 400', retries: 0 })
    expect(r.tasks[0]?.passed).toBe(false)
  })
})

describe('the step cap', () => {
  const domain = domainNamed('long-jobs')

  it("is the domain's own: 25 on support-ops and files-ops, 40 on long-jobs", () => {
    expect(DOMAINS.map((d) => [d.name, capOf(d)])).toEqual([
      ['support-ops', 25],
      ['files-ops', 25],
      ['long-jobs', 40],
    ])
  })

  it('holds every long-jobs task with its reply, records 40, and stops a task that never replies at 40 steps', async () => {
    const r = await ran(
      { domain, seed: 3, days: 1, endless: new Set(['long-jobs.d1.raise-tell-vendors']) },
      { arm: 'plain' },
    )
    expect(JSON.parse(readFileSync(join(r.out, 'run.json'), 'utf8'))).toMatchObject({
      domain: 'long-jobs',
      max_steps: 40,
    })
    const endless = r.tasks.find((t) => t.template === 'raise-tell-vendors')
    expect(endless).toMatchObject({ passed: false, capped: true, steps: 40 })
    expect(endless?.reason).toMatch(/no reply within 40 steps/)
    const others = r.tasks.filter((t) => t !== endless)
    expect(others.filter((t) => !t.passed)).toEqual([])
    for (const t of others) {
      const inst = need(
        domain.instances(3, 1).find((i) => i.id === t.instance),
        t.instance,
      )
      expect({ task: t.instance, steps: t.steps }).toEqual({ task: t.instance, steps: inst.solve().calls.length + 1 })
    }
  })

  it("takes a cap the run gives over the domain's own, and records it", async () => {
    const r = await ran(
      { domain, seed: 3, days: 1, endless: new Set(['long-jobs.d1.raise-tell-vendors']) },
      { arm: 'plain', maxSteps: 45 },
    )
    expect(JSON.parse(readFileSync(join(r.out, 'run.json'), 'utf8'))).toMatchObject({ max_steps: 45 })
    expect(r.tasks.find((t) => t.template === 'raise-tell-vendors')).toMatchObject({ capped: true, steps: 45 })
  })
})

/** Each template's phrasing on each day, as the tasks a run wrote record it. */
const formsByDay = (tasks: readonly TaskLine[], days: number): number[][] =>
  Array.from({ length: days }, (_, d) => tasks.filter((t) => t.day === d + 1).map((t) => t.form))

describe('a run asked in the same words every round', () => {
  const domain = domainNamed('support-ops')

  it('asks each job in its day-1 phrasing every day, with new data, and records the setting', async () => {
    const r = await ran({ domain, seed: 5, days: 2, words: 'same' }, { arm: 'plain', words: 'same' })
    expect(r.tasks).toHaveLength(40)
    expect(r.tasks.filter((t) => !t.passed)).toEqual([])
    const [day1, day2] = formsByDay(r.tasks, 2)
    expect(day2).toEqual(day1)
    expect(r.record.words).toBe('same')
    expect(JSON.parse(readFileSync(join(r.out, 'run.json'), 'utf8'))).toMatchObject({ seed: 5, words: 'same' })
  })
})

/** sha256 of a key, its first 12 hex characters, worked out here rather than by the module under test. */
const printOf = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 12)

const modeOf = (path: string): number => statSync(path).mode & 0o777

/** Runs work under umask 022: a stricter umask makes every new file 0600 by itself, and the mode checks moot. */
const underUmask022 = async <T>(work: () => Promise<T>): Promise<T> => {
  const was = process.umask(0o022)
  try {
    return await work()
  } finally {
    process.umask(was)
  }
}

describe('the key ledger', () => {
  const domain = domainNamed('files-ops')
  const KEY = 'reactor-test-key-LEDGERSECRET'
  let fake: Fake
  beforeAll(async () => {
    fake = await startFake({ domain, seed: 21, days: 1 })
  })
  afterAll(async () => {
    await fake.close()
  })
  const reactor = (over: Partial<RunOptions>): Promise<RunRecord> =>
    runArm({
      arm: 'reactor',
      domain,
      days: 1,
      seed: 21,
      baseUrl: fake.url,
      key: KEY,
      large: 'big-model',
      small: 'small-model',
      runId: 'ledger-a',
      out: join(scratch(), 'run'),
      prices: PRICES,
      harnessCommit: 'abc123',
      sleep: async () => undefined,
      ...over,
    })
  const use = (run_id: string): KeyUse => ({ run_id, domain: 'files-ops', at: '2026-10-15T00:00:00.000Z' })

  it('files a key it has not seen as not seen, keeping its fingerprint and never the key, in a 0600 file', async () => {
    const ledger = join(scratch(), 'state', 'keys.json')
    const out = join(scratch(), 'run')
    const said: string[] = []
    const record = await underUmask022(() => reactor({ ledger, out, log: (line) => said.push(line) }))
    expect(record).toMatchObject({ key_seen_before: false, key_earlier_run_id: null })
    expect(JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))).toMatchObject({
      key_seen_before: false,
      key_earlier_run_id: null,
    })
    expect(said).toContain('the key ledger had not seen this Reactor key')
    const text = readFileSync(ledger, 'utf8')
    expect(text).not.toContain('LEDGERSECRET')
    expect(JSON.parse(text)).toEqual({
      benchmark: 'repeat-bill',
      keys: { [fake.url]: { [printOf(KEY)]: { run_id: 'ledger-a', domain: 'files-ops', at: record.started_at } } },
    })
    expect(modeOf(ledger)).toBe(0o600)
    expect(modeOf(dirname(ledger))).toBe(0o700)
  })

  it('reads a key it has seen at the same base URL as seen, naming the earlier run, and leaves the entry as it was', async () => {
    const ledger = join(scratch(), 'keys.json')
    await reactor({ ledger, runId: 'ledger-a' })
    const before = readFileSync(ledger, 'utf8')
    const out = join(scratch(), 'run')
    const said: string[] = []
    const record = await reactor({ ledger, runId: 'ledger-b', baseUrl: `${fake.url}/`, out, log: (l) => said.push(l) })
    expect(record).toMatchObject({ key_seen_before: true, key_earlier_run_id: 'ledger-a' })
    expect(JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))).toMatchObject({
      key_seen_before: true,
      key_earlier_run_id: 'ledger-a',
    })
    expect(said).toContain('the Reactor key was used by run ledger-a before this run: day 1 is not cold')
    expect(readFileSync(ledger, 'utf8')).toBe(before)
  })

  it('files a key under its base URL without query, credentials or trailing slash, and tells keys apart', () => {
    const ledger = join(scratch(), 'keys.json')
    expect(useKey(ledger, 'https://reactor.example/v1', 'key-one', use('r1'))).toBeNull()
    expect(useKey(ledger, 'https://reactor.example/v1/', 'key-one', use('r2'))).toEqual(use('r1'))
    expect(useKey(ledger, 'https://reactor.example/v1?api-version=2', 'key-one', use('r3'))).toEqual(use('r1'))
    expect(useKey(ledger, 'https://who:PASSWORD9@reactor.example/v1', 'key-one', use('r4'))).toEqual(use('r1'))
    expect(useKey(ledger, 'https://other.example/v1', 'key-one', use('r5'))).toBeNull()
    expect(useKey(ledger, 'https://reactor.example/v1', 'key-two', use('r6'))).toBeNull()
    expect(useKey(ledger, 'https://reactor.example/v1', 'key-two', use('r7'))).toEqual(use('r6'))
    const text = readFileSync(ledger, 'utf8')
    expect(text).not.toContain('PASSWORD9')
    expect(JSON.parse(text).keys).toEqual({
      'https://reactor.example/v1': { [printOf('key-one')]: use('r1'), [printOf('key-two')]: use('r6') },
      'https://other.example/v1': { [printOf('key-one')]: use('r5') },
    })
  })

  it('reads a key with whitespace after it as the key fetch sends', () => {
    const ledger = join(scratch(), 'keys.json')
    expect(useKey(ledger, 'https://reactor.example/v1', 'key-one\r\n', use('r1'))).toBeNull()
    expect(useKey(ledger, 'https://reactor.example/v1', 'key-one\t ', use('r2'))).toEqual(use('r1'))
    expect(Object.keys(JSON.parse(readFileSync(ledger, 'utf8')).keys['https://reactor.example/v1'])).toEqual([
      printOf('key-one'),
    ])
  })

  it('refuses to file a run id it could not read back, and leaves the ledger as it was', () => {
    const ledger = join(scratch(), 'keys.json')
    expect(() => useKey(ledger, 'https://reactor.example/v1', 'key-one', use('has space'))).toThrow(
      /^the key ledger files only a run id the command line accepts$/,
    )
    expect(existsSync(ledger)).toBe(false)
  })

  it('refuses to write through a temp file already at its path, and leaves that file alone', () => {
    const dir = scratch()
    const ledger = join(dir, 'keys.json')
    const temp = `${ledger}.${process.pid}.tmp`
    writeFileSync(temp, 'not the ledger\n')
    expect(() => useKey(ledger, 'https://reactor.example/v1', 'key-one', use('r1'))).toThrow(
      `${temp}: already there; remove it if no run is writing the key ledger`,
    )
    expect(readFileSync(temp, 'utf8')).toBe('not the ledger\n')
    expect(readdirSync(dir).sort()).toEqual([`keys.json.${process.pid}.tmp`])
  })

  it('files the key before its first request, so a run that stops after that still counts as having used it', async () => {
    const ledger = join(scratch(), 'keys.json')
    const dead = 'http://127.0.0.1:9/v1'
    const stop = async (): Promise<void> => {
      throw new Error('stopped')
    }
    await expect(reactor({ ledger, runId: 'ledger-a', baseUrl: dead, sleep: stop })).rejects.toThrow('stopped')
    await expect(reactor({ ledger, runId: 'ledger-b', baseUrl: dead, freshKeyRequired: true })).rejects.toThrow(
      /^the Reactor key was used by run ledger-a before this run; --fresh-key-required refuses it$/,
    )
  })

  it('files no key when the run fails on this machine before its first request', async () => {
    const ledger = join(scratch(), 'keys.json')
    const blocker = join(scratch(), 'a-file')
    writeFileSync(blocker, '')
    const asked = fake.seen.length
    await expect(reactor({ ledger, out: join(blocker, 'run') })).rejects.toThrow(/ENOTDIR|EEXIST/)
    expect(fake.seen.length).toBe(asked)
    expect(existsSync(ledger)).toBe(false)
  })

  it('reads a key another run filed after the lookup as seen, and refuses it then when a fresh key is required', async () => {
    // A domain that files the key while the run is set up, as another run starting at that moment would.
    const racing = (ledger: string): typeof domain => ({
      ...domain,
      instances: (...args: Parameters<typeof domain.instances>) => {
        useKey(ledger, fake.url, KEY, use('ledger-z'))
        return domain.instances(...args)
      },
    })
    const ledger = join(scratch(), 'keys.json')
    const out = join(scratch(), 'run')
    const record = await reactor({ ledger, out, domain: racing(ledger) })
    expect(record).toMatchObject({ key_seen_before: true, key_earlier_run_id: 'ledger-z' })
    expect(JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))).toMatchObject({
      key_seen_before: true,
      key_earlier_run_id: 'ledger-z',
    })
    const fresh = join(scratch(), 'keys.json')
    const asked = fake.seen.length
    await expect(reactor({ ledger: fresh, domain: racing(fresh), freshKeyRequired: true })).rejects.toThrow(
      /^the Reactor key was used by run ledger-z before this run; --fresh-key-required refuses it$/,
    )
    expect(fake.seen.length).toBe(asked)
  })

  it('refuses to start on a key it has seen when a fresh key is required, naming the earlier run, before any request or file', async () => {
    const ledger = join(scratch(), 'keys.json')
    await reactor({ ledger, runId: 'ledger-a', freshKeyRequired: true })
    const before = readFileSync(ledger, 'utf8')
    const asked = fake.seen.length
    const out = join(scratch(), 'run')
    await expect(reactor({ ledger, runId: 'ledger-b', out, freshKeyRequired: true })).rejects.toThrow(
      /^the Reactor key was used by run ledger-a before this run; --fresh-key-required refuses it$/,
    )
    expect(fake.seen.length).toBe(asked)
    expect(existsSync(out)).toBe(false)
    expect(readFileSync(ledger, 'utf8')).toBe(before)
  })

  it('refuses a ledger it cannot read, rather than reading it as empty', async () => {
    const dir = scratch()
    const prints = (byPrint: unknown): string =>
      JSON.stringify({ benchmark: 'repeat-bill', keys: { [fake.url]: byPrint } })
    const entry = (over: Partial<Record<keyof KeyUse, unknown>>): string =>
      prints({ [printOf(KEY)]: { ...use('r1'), ...over } })
    const bad = {
      'not-json.json': 'not json',
      'keys-a-list.json': JSON.stringify({ benchmark: 'repeat-bill', keys: [] }),
      'another-benchmark.json': JSON.stringify({ benchmark: 'other', keys: {} }),
      'prints-a-list.json': prints([]),
      'prints-null.json': prints(null),
      'a-run-id-no-run-has.json': entry({ run_id: '../x' }),
      'no-run-id.json': entry({ run_id: undefined }),
      'no-domain.json': entry({ domain: undefined }),
      'no-time.json': entry({ at: undefined }),
    }
    const asked = fake.seen.length
    for (const [name, text] of Object.entries(bad)) {
      const ledger = join(dir, name)
      writeFileSync(ledger, text)
      await expect(reactor({ ledger }), name).rejects.toThrow(`${ledger}: not a key ledger this harness wrote`)
      expect(readFileSync(ledger, 'utf8')).toBe(text)
    }
    const folder = join(dir, 'a-folder')
    mkdirSync(folder)
    await expect(reactor({ ledger: folder })).rejects.toThrow(`${folder}: the key ledger cannot be read`)
    expect(fake.seen.length).toBe(asked)
  })

  it('leaves the plain arm, and a reactor arm given no ledger, unchecked', async () => {
    const ledger = join(scratch(), 'keys.json')
    const plain = await reactor({ arm: 'plain', small: null, ledger })
    expect(plain).toMatchObject({ key_seen_before: null, key_earlier_run_id: null })
    expect(existsSync(ledger)).toBe(false)
    expect(await reactor({})).toMatchObject({ key_seen_before: null, key_earlier_run_id: null })
    await expect(reactor({ freshKeyRequired: true })).rejects.toThrow(
      /^--fresh-key-required needs a key ledger to check the key against$/,
    )
  })
})

describe("the engine's calls under a step, from x-reactor-spent", () => {
  const domain = domainNamed('support-ops')

  it('prices each call at its model and writes the sum as overhead_usd, 0 where the header is absent', async () => {
    const r = await ran(
      {
        domain,
        seed: 5,
        days: 1,
        spent: (step) =>
          step === 1 ? [{ model: 'small-model', tokens_in: 1000, tokens_out: 0, purpose: 'plan' }] : [],
      },
      { arm: 'reactor', small: 'small-model', runId: 'spent-1' },
    )
    const inst = domain.instances(5, 1)[0]!
    const mine = r.steps.filter((s) => s.instance === inst.id)
    // step 1 is the first answer (zero assistant turns before it); the fake counts steps from 0.
    expect(mine.map((s) => [s.step, s.overhead_usd])).toEqual(mine.map((s) => [s.step, s.step === 2 ? 0.001 : 0]))
  })

  it('counts a call at a model nobody priced as unpriced overhead, at $0', async () => {
    const r = await ran(
      { domain, seed: 5, days: 1, spent: () => [{ model: 'mystery', tokens_in: 10, tokens_out: 0, purpose: 'ask' }] },
      { arm: 'reactor', small: 'small-model', runId: 'spent-2' },
    )
    expect(r.steps.every((s) => s.overhead_usd === 0 && s.overhead_unpriced === 1)).toBe(true)
  })
})

describe('the price a step is costed at', () => {
  const domain = domainNamed('support-ops')

  it('is the small price for a small-model step that reports usage, and the large price for a name neither has', async () => {
    const small = await ran(
      { domain, seed: 11, days: 1, largeAs: () => 'small-model' },
      { arm: 'reactor', small: 'small-model', runId: 'priced-small' },
    )
    for (const s of small.steps) {
      const u = usageAt(s.step - 1)
      expect(s).toMatchObject({ served_by: 'small', usage_reported: true })
      expect(s.cost_usd).toBe((u.prompt_tokens * 1 + u.completion_tokens * 2) / 1_000_000)
    }
    const other = await ran(
      { domain, seed: 11, days: 1, largeAs: () => 'someone-else' },
      { arm: 'reactor', small: 'small-model', runId: 'priced-other' },
    )
    expect(other.steps.every((s) => s.served_by === 'other' && s.cost_usd === bigCost(s.step - 1))).toBe(true)
  })
})

describe('the harness commit', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
    })

  it('stays clean with run output or a price edit in bench/, and turns dirty with a harness edit', () => {
    const repo = scratch()
    const bench = join(repo, 'bench')
    mkdirSync(bench)
    writeFileSync(join(bench, 'run.ts'), 'export {}\n')
    writeFileSync(join(bench, 'prices.json'), '{}\n')
    git(repo, 'init', '-q')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.name=bench', '-c', 'user.email=bench@example.test', 'commit', '-q', '--no-verify', '-m', 'a')
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    expect(harnessCommit(bench)).toBe(head)
    mkdirSync(join(bench, 'runs', 'plain'), { recursive: true })
    writeFileSync(join(bench, 'runs', 'plain', 'run.json'), '{}\n')
    expect(harnessCommit(bench)).toBe(head)
    writeFileSync(join(bench, 'prices.json'), '{"models":{}}\n')
    expect(harnessCommit(bench)).toBe(head)
    writeFileSync(join(bench, 'run.ts'), 'export const changed = 1\n')
    expect(harnessCommit(bench)).toBe(`${head}-dirty`)
  })
})

const cli = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(BENCH, 'cli.ts'), ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  )

// Each test here starts node processes, which a busy machine can slow to seconds apiece.
describe('the command line', { timeout: 60_000 }, () => {
  const domain = domainNamed('files-ops')
  const pricesFile = join(scratch(), 'prices.json')
  writeFileSync(pricesFile, JSON.stringify(PRICES))
  const runArgs = (out: string, url: string): string[] => [
    'run',
    '--arm',
    'plain',
    '--domain',
    'files-ops',
    '--run-id',
    'cli-1',
    '--base-url',
    url,
    '--key',
    'REPEAT_BILL_TEST_KEY',
    '--large',
    'big-model',
    '--days',
    '1',
    '--seed',
    '3',
    '--out',
    out,
    '--prices',
    pricesFile,
  ]

  it('reads the key from the named variable, sends it, and never prints or writes it', async () => {
    const secret = `sk-test-${Math.random().toString(36).slice(2)}-never-shown`
    const fake = await startFake({ domain, seed: 3, days: 1 })
    const out = join(scratch(), 'run')
    try {
      const { code, out: printed } = await cli(runArgs(out, fake.url), { REPEAT_BILL_TEST_KEY: secret })
      expect({ code, printed }).toMatchObject({ code: 0 })
      expect(printed).toContain('done: plain arm, files-ops, 1 days, run cli-1')
      expect(printed).not.toContain(secret)
      const written = filesUnder(out)
      expect(written.map((f) => f.slice(out.length + 1)).sort()).toEqual(['run.json', 'steps.jsonl', 'tasks.jsonl'])
      for (const file of written) {
        expect(readFileSync(file, 'utf8')).not.toContain(secret)
      }
      expect(fake.seen.length).toBeGreaterThan(20)
      expect(fake.seen.every((s) => s.headers.authorization === `Bearer ${secret}`)).toBe(true)
      expect(lines<TaskLine>(join(out, 'tasks.jsonl')).filter((t) => t.passed)).toHaveLength(20)
      const record = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as RunRecord
      expect(record.harness_commit).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/)
    } finally {
      await fake.close()
    }
  })

  it('refuses a key passed as the flag value, an unset variable and a stray argument, echoing none', async () => {
    const out = join(scratch(), 'never')
    const base = runArgs(out, 'http://127.0.0.1:9/v1')
    const keyAt = base.indexOf('--key') + 1
    const withKey = (value: string): string[] => base.map((a, i) => (i === keyAt ? value : a))

    const pasted = await cli(withKey('sk-live-PASTEDKEY123'))
    expect(pasted.code).toBe(2)
    expect(pasted.out).toContain('the name of an environment variable')
    expect(pasted.out).not.toContain('PASTEDKEY123')

    const unset = await cli(withKey('rk_live_UNSETNAME456'))
    expect(unset.code).toBe(2)
    expect(unset.out).toContain('is not set')
    expect(unset.out).not.toContain('UNSETNAME456')

    const stray = await cli([...base, 'sk-STRAYVALUE789'], { REPEAT_BILL_TEST_KEY: 'x' })
    expect(stray.code).toBe(2)
    expect(stray.out).not.toContain('STRAYVALUE789')
  })

  it("takes the domain's own step cap when --max-steps is not given", async () => {
    const jobs = domainNamed('long-jobs')
    const fake = await startFake({ domain: jobs, seed: 3, days: 1 })
    const out = join(scratch(), 'run')
    try {
      const args = runArgs(out, fake.url).map((a) => (a === 'files-ops' ? 'long-jobs' : a))
      const { code, out: printed } = await cli(args, { REPEAT_BILL_TEST_KEY: 'x' })
      expect({ code, printed }).toMatchObject({ code: 0 })
      expect(JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))).toMatchObject({
        domain: 'long-jobs',
        max_steps: 40,
      })
      expect(lines<TaskLine>(join(out, 'tasks.jsonl')).filter((t) => t.passed)).toHaveLength(20)
    } finally {
      await fake.close()
    }
  })

  it('takes --small on the reactor arm only', async () => {
    const out = join(scratch(), 'never')
    const base = runArgs(out, 'http://127.0.0.1:9/v1')
    const plainWithSmall = await cli([...base, '--small', 'small-model'], { REPEAT_BILL_TEST_KEY: 'x' })
    expect(plainWithSmall).toMatchObject({ code: 2 })
    expect(plainWithSmall.out).toContain('the plain arm takes no --small')
    const reactor = base.map((a) => (a === 'plain' ? 'reactor' : a))
    const reactorWithout = await cli(reactor, { REPEAT_BILL_TEST_KEY: 'x' })
    expect(reactorWithout).toMatchObject({ code: 2 })
    expect(reactorWithout.out).toContain('the reactor arm needs --small')
  })

  it('takes --words new or same only, echoing no other value', async () => {
    const base = runArgs(join(scratch(), 'never'), 'http://127.0.0.1:9/v1')
    for (const words of ['Same', '', 'WORDSVALUE42']) {
      const refused = await cli([...base, '--words', words], { REPEAT_BILL_TEST_KEY: 'x' })
      expect({ words, code: refused.code }).toEqual({ words, code: 2 })
      expect(refused.out).toContain('--words is new or same')
      expect(refused.out).not.toContain('WORDSVALUE42')
    }
  })

  it('runs with --words same: every day asks in the day-1 phrasing, and run.json records it', async () => {
    const fake = await startFake({ domain, seed: 3, days: 2, words: 'same' })
    const out = join(scratch(), 'run')
    try {
      const args = runArgs(out, fake.url).map((a, i, all) => (all[i - 1] === '--days' ? '2' : a))
      const { code, out: printed } = await cli([...args, '--words', 'same'], { REPEAT_BILL_TEST_KEY: 'x' })
      expect({ code, printed }).toMatchObject({ code: 0 })
      const record = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as RunRecord
      expect(record).toMatchObject({ days: 2, seed: 3, words: 'same' })
      const tasks = lines<TaskLine>(join(out, 'tasks.jsonl'))
      expect(tasks.filter((t) => t.passed)).toHaveLength(40)
      const [day1, day2] = formsByDay(tasks, 2)
      expect(day2).toEqual(day1)
    } finally {
      await fake.close()
    }
  })

  it('takes --ledger and --fresh-key-required on the reactor and playbook arms only', async () => {
    const base = runArgs(join(scratch(), 'never'), 'http://127.0.0.1:9/v1')
    const ledger = await cli([...base, '--ledger', join(scratch(), 'keys.json')], { REPEAT_BILL_TEST_KEY: 'x' })
    expect(ledger).toMatchObject({ code: 2 })
    expect(ledger.out).toContain('--ledger applies to the reactor and playbook arms only')
    const fresh = await cli([...base, '--fresh-key-required'], { REPEAT_BILL_TEST_KEY: 'x' })
    expect(fresh).toMatchObject({ code: 2 })
    expect(fresh.out).toContain('--fresh-key-required applies to the reactor and playbook arms only')
    const reactor = [...base.map((a) => (a === 'plain' ? 'reactor' : a)), '--small', 'small-model']
    const empty = await cli([...reactor, '--ledger', ''], { REPEAT_BILL_TEST_KEY: 'x' })
    expect(empty).toMatchObject({ code: 2 })
    expect(empty.out).toContain('--ledger takes the path of a file')
  })

  it('keeps the key ledger under the home folder unless --ledger names one, and --fresh-key-required refuses a key it has seen', async () => {
    const secret = `rk-test-${Math.random().toString(36).slice(2)}-LEDGERCLI`
    const fake = await startFake({ domain, seed: 3, days: 1 })
    const home = scratch()
    const env = { REPEAT_BILL_TEST_KEY: secret, HOME: home }
    const reactorArgs = (out: string, runId: string): string[] => [
      ...runArgs(out, fake.url).map((a) => (a === 'plain' ? 'reactor' : a === 'cli-1' ? runId : a)),
      '--small',
      'small-model',
    ]
    try {
      const outA = join(scratch(), 'run')
      const a = await underUmask022(() => cli(reactorArgs(outA, 'cli-a'), env))
      expect({ code: a.code, out: a.out }).toMatchObject({ code: 0 })
      expect(a.out).toContain('the key ledger had not seen this Reactor key')
      const ledger = join(home, '.repeat-bill', 'keys.json')
      expect(modeOf(ledger)).toBe(0o600)
      expect(readFileSync(ledger, 'utf8')).not.toContain('LEDGERCLI')
      expect(JSON.parse(readFileSync(join(outA, 'run.json'), 'utf8'))).toMatchObject({ key_seen_before: false })

      const outB = join(scratch(), 'run')
      const b = await cli([...reactorArgs(outB, 'cli-b'), '--fresh-key-required'], env)
      expect(b.code).toBe(1)
      expect(b.out).toContain('the Reactor key was used by run cli-a before this run; --fresh-key-required refuses it')
      expect(b.out).not.toContain('LEDGERCLI')
      expect(existsSync(outB)).toBe(false)

      const elsewhere = join(scratch(), 'other', 'keys.json')
      const outC = join(scratch(), 'run')
      const c = await cli([...reactorArgs(outC, 'cli-c'), '--fresh-key-required', '--ledger', elsewhere], env)
      expect({ code: c.code, out: c.out }).toMatchObject({ code: 0 })
      expect(JSON.parse(readFileSync(join(outC, 'run.json'), 'utf8'))).toMatchObject({
        key_seen_before: false,
        key_earlier_run_id: null,
      })
      expect(existsSync(elsewhere)).toBe(true)
    } finally {
      await fake.close()
    }
  })
})

/** Each act's tool, record and values as text: a playbook's blanks carry every value as a string. */
const actsOf = (effects: readonly Effect[]): unknown[] =>
  effects.map((e) => [e.tool, e.target, Object.fromEntries(Object.entries(e.args).map(([k, v]) => [k, String(v)]))])

/** What a job's reference calls change, in a sandbox of their own. */
const referenceEffects = (inst: Instance): unknown[] => {
  const session = inst.open()
  for (const c of inst.solve().calls) {
    session.call(c.tool, c.args)
  }
  return actsOf(session.effects)
}

/** The client's dependencies at their plainest: one fetch a request, no retries, a chat answer read for words or tools. */
const depsFor = (door: Door, session: Session, domain: Domain): Deps => {
  const send = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const started = performance.now()
    const res = await fetch(`${door.url}/${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    const latencyMs = Math.round(performance.now() - started)
    return res.ok
      ? { ok: true, body: JSON.parse(text) as Record<string, unknown>, spent: [], latencyMs, retries: 0 }
      : { ok: false, error: `status ${res.status}`, latencyMs, retries: 0 }
  }
  return {
    post: send,
    chat: async (messages) => {
      const answer = await send('chat/completions', { model: 'big-model', messages, tools: domain.tools })
      if (!answer.ok) {
        return { kind: 'error', error: answer.error, answer }
      }
      const choices = answer.body.choices as { message: { content: string | null; tool_calls?: unknown[] } }[]
      const message = choices[0]?.message
      const asked = (message?.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[]
      return asked.length > 0
        ? {
            kind: 'tools',
            tools: asked.map((c) => c.function.name),
            calls: asked.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
            by: 'large',
            answer,
          }
        : { kind: 'words', words: message?.content ?? '', by: 'large', answer }
    },
    call: (tool, args) => session.call(tool, args),
    failed: toolFailed,
    nonce: () => 'n1',
    now: () => '2026-10-25T00:00:00.000Z',
  }
}

const sentTo = (door: Door, route: string) => door.seen.filter((s) => s.route === route)

/** An object with one key taken out. */
const without = (body: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([name]) => name !== key))

/** The report a job sent; every job but one handed to the plain path sends one. */
const reportOf = (trace: Trace) => need(trace.report ?? undefined, 'a report')

const toolEvents = (trace: Trace) => trace.events.flatMap((e) => (e.kind === 'tool' ? [e] : []))

describe('the bare playbook client, against a fake playbook door', () => {
  const domain = domainNamed('support-ops')
  const instances = domain.instances(5, 1)
  const first = need(instances[0], 'a job')

  const played = async (
    opts: Partial<Omit<DoorOptions, 'domain' | 'seed' | 'days'>>,
    inst: Instance,
    job: Partial<Job> = {},
    over: (deps: Deps) => Partial<Deps> = () => ({}),
  ): Promise<{ trace: Trace; session: Session; door: Door }> => {
    const door = await startDoor({ domain, seed: 5, days: 1, ...opts })
    const session = inst.open()
    try {
      const deps = depsFor(door, session, domain)
      const trace = await playJob(
        {
          ask: inst.ask,
          tools: domain.tools,
          jobId: `run-p.${inst.id}`,
          allowModel: true,
          messages: [
            { role: 'system', content: domain.system },
            { role: 'user', content: inst.ask },
          ],
          maxSteps: 25,
          ...job,
        },
        { ...deps, ...over(deps) },
      )
      return { trace, session, door }
    } finally {
      await door.close()
    }
  }

  it('fills a blank marked local with its ask value in place, at no cost and with no fill call', async () => {
    const { trace, session, door } = await played({ mark: () => 'ask' }, first)
    expect(sentTo(door, 'playbooks/fill')).toEqual([])
    expect(toolEvents(trace).map((e) => [e.tool, e.by, e.filled_by, e.model, e.shape])).toEqual(
      first.solve().calls.map((c) => [c.tool, 'client', 'ask', 'none', 'ok']),
    )
    expect(actsOf(session.effects)).toEqual(referenceEffects(first))
    expect(trace).toMatchObject({ ended: 'done', why: null, reply: first.solve().reply })
    expect(session.check(trace.reply ?? '').pass).toBe(true)
  })

  it("fills a blank marked local from an earlier step's result: a string at its key, from a tool called once", async () => {
    const reads = (p: Planned): boolean => Object.values(p.marks).some((m) => typeof m === 'object')
    const inst = need(
      instances.find((i) => plannedOf(domain, i).some(reads)),
      'a job whose playbook reads a result',
    )
    const planned = plannedOf(domain, inst)
    const { trace, session, door } = await played(
      {
        mark: (_, stepNo, name) => {
          const mark = planned[stepNo - 1]?.marks[name]
          return typeof mark === 'object' ? mark : 'ask'
        },
      },
      inst,
    )
    expect(sentTo(door, 'playbooks/fill')).toEqual([])
    expect(toolEvents(trace).flatMap((e) => (e.filled_by === 'result' ? [e.step_no] : []))).toEqual(
      planned.flatMap((p, i) => (reads(p) ? [i + 1] : [])),
    )
    expect(actsOf(session.effects)).toEqual(referenceEffects(inst))
    expect(trace.ended).toBe('done')
  })

  it('sends every step with a blank not marked local to the fill entrance, with allow_model as the run sets it', async () => {
    const steps = first.solve().calls.length
    for (const allowModel of [true, false]) {
      const { trace, session, door } = await played({ mark: () => 'door' }, first, { allowModel })
      const fills = sentTo(door, 'playbooks/fill')
      expect(fills.map((f) => [f.body.step_no, f.body.allow_model, (f.body.results as unknown[]).length])).toEqual(
        Array.from({ length: steps }, (_, i) => [i + 1, allowModel, i]),
      )
      expect(fills.every((f) => f.body.job_id === `run-p.${first.id}` && f.body.ask === first.ask)).toBe(true)
      expect(fills.some((f) => Object.hasOwn(f.body, 'tenant'))).toBe(false)
      expect(toolEvents(trace).every((e) => e.by === 'door' && e.filled_by === 'large' && e.model === 'large')).toBe(
        true,
      )
      expect(actsOf(session.effects)).toEqual(referenceEffects(first))
    }
  })

  it('sends a result-marked blank to the fill entrance when its tool ran twice, its value is no string, or its step has not run', async () => {
    const inst = need(
      instances.find((i) => i.solve().calls[0]?.tool === 'get_ticket'),
      'a job that starts at a ticket',
    )
    const ticketId = String(need(inst.solve().calls[0], 'a call').args.ticket_id)
    const ticket = inst.open().call('get_ticket', { ticket_id: ticketId }) as {
      order_id: string | null
      customer_id: string
    }
    const orderId = need(ticket.order_id ?? undefined, 'an order on the ticket')
    const plan: Planned[] = [
      { tool: 'get_ticket', args: { ticket_id: ticketId }, marks: { ticket_id: 'ask' } },
      { tool: 'get_order', args: { order_id: orderId }, marks: { order_id: { from: 1, path: 'order_id' } } },
      // A number, a key the result does not have, and a step that has not run yet.
      {
        tool: 'list_orders',
        args: { customer_id: ticket.customer_id },
        marks: { customer_id: { from: 2, path: 'total' } },
      },
      {
        tool: 'list_orders',
        args: { customer_id: ticket.customer_id },
        marks: { customer_id: { from: 1, path: 'no_key' } },
      },
      { tool: 'get_order', args: { order_id: orderId }, marks: { order_id: { from: 7, path: 'id' } } },
      { tool: 'get_ticket', args: { ticket_id: ticketId }, marks: { ticket_id: { from: 1, path: 'id' } } },
      // get_ticket has now run twice, so which ticket a value came from is no longer one.
      { tool: 'get_order', args: { order_id: orderId }, marks: { order_id: { from: 1, path: 'order_id' } } },
    ]
    const { trace, door } = await played({ plan: () => plan }, inst)
    expect(sentTo(door, 'playbooks/fill').map((f) => f.body.step_no)).toEqual([3, 4, 5, 7])
    expect(toolEvents(trace).map((e) => [e.step_no, e.by, e.filled_by])).toEqual([
      [1, 'client', 'ask'],
      [2, 'client', 'result'],
      [3, 'door', 'large'],
      [4, 'door', 'large'],
      [5, 'door', 'large'],
      [6, 'client', 'result'],
      [7, 'door', 'large'],
    ])
    const third = need(sentTo(door, 'playbooks/fill')[0], 'a fill').body.step as { blanks: unknown[] }
    expect(third.blanks).toEqual([
      { name: 'customer_id', value: null, local: true, filled_by: null, from: { step_no: 2, path: 'total' } },
    ])
  })

  it('stops on a failed result and reports it failed, calling nothing after it and asking for no reply', async () => {
    const plan: Planned[] = [
      { tool: 'get_order', args: { order_id: 'O-NONE' }, marks: { order_id: 'ask' } },
      ...plannedOf(domain, first),
    ]
    const { trace, session, door } = await played({ plan: () => plan }, first)
    expect(toolEvents(trace).map((e) => [e.step_no, e.shape])).toEqual([[1, 'failed']])
    expect(trace).toMatchObject({ ended: 'stopped', why: 'a failed result', reply: null })
    expect(session.effects).toEqual([])
    expect(door.model.seen).toEqual([])
    expect(reportOf(trace).steps).toMatchObject([
      { step_no: 1, tool: 'get_order', result_shape: 'failed', verified: false, model: 'none' },
    ])
    expect(sentTo(door, 'playbooks/report').map((r) => r.body.ended)).toEqual(['stopped'])
    // The refused call and the tool's words ride on the event, so the record can say what was sent (2026-10-30).
    expect(toolEvents(trace)[0]).toMatchObject({
      refused: { call: { order_id: 'O-NONE' }, error: expect.stringContaining('O-NONE') as string },
    })
  })

  it('stops on an empty result and reports it empty', async () => {
    const plan: Planned[] = [
      { tool: 'find_customer', args: { query: 'nobody-by-this-name' }, marks: { query: 'ask' } },
      ...plannedOf(domain, first),
    ]
    const { trace, door } = await played({ plan: () => plan }, first)
    expect(toolEvents(trace).map((e) => [e.step_no, e.shape])).toEqual([[1, 'empty']])
    expect(trace).toMatchObject({ ended: 'stopped', why: 'an empty result' })
    expect(reportOf(trace).steps).toMatchObject([{ step_no: 1, result_shape: 'empty', verified: false }])
    expect(door.model.seen).toEqual([])
  })

  it('stops before calling a tool the playbook did not name for its step', async () => {
    const swapped = await played(
      { mark: () => 'door', fillAs: (_, __, step) => ({ ...step, tool: 'close_ticket' }) },
      first,
    )
    expect(toolEvents(swapped.trace)).toEqual([])
    expect(swapped.trace).toMatchObject({ ended: 'stopped', why: 'an act the playbook did not name' })
    expect(swapped.session.effects).toEqual([])
  })

  it("hands the job to the agent on needs_model: the large model makes that step and the rest, and the report carries them as the large model's", async () => {
    const calls = first.solve().calls
    const { trace, session, door } = await played(
      { mark: () => 'door', kind: (_, stepNo) => (stepNo === 2 ? 'needs_model' : undefined) },
      first,
    )
    expect(toolEvents(trace).map((e) => e.tool)).toEqual([calls[0]?.tool])
    expect(door.model.seen).toHaveLength(calls.length)
    expect(trace).toMatchObject({ ended: 'done', reply: first.solve().reply })
    expect(session.check(trace.reply ?? '').pass).toBe(true)
    expect(reportOf(trace).steps.map((s) => [s.step_no, s.tool, s.result_shape])).toEqual(
      calls.map((c, i) => [i + 1, c.tool, 'ok']),
    )
    expect(
      reportOf(trace)
        .steps.slice(1)
        .every((s) => s.model === 'large' && s.filled_by === 'large'),
    ).toBe(true)
    expect(reportOf(trace).steps[1]).toMatchObject({ filled_by: 'large', call: calls[1]?.args })
    expect(stepLineOf(trace)).toBe(
      [
        `1 ${calls[0]?.tool} large ok`,
        `2 ${calls[1]?.tool} needs_model`,
        ...calls.slice(1).map((c) => `agent large ${c.tool}`),
        'reply large',
      ].join(', '),
    )
  })

  it("asks the door for the reply of a job whose playbook ran to its end, and reports the words as the small model's", async () => {
    const { trace, session, door } = await played({}, first, { reply: true })
    expect(door.model.seen).toEqual([])
    expect(trace).toMatchObject({ ended: 'done', reply: first.solve().reply })
    expect(session.check(trace.reply ?? '').pass).toBe(true)
    const asked = need(sentTo(door, 'playbooks/reply')[0], 'a reply request')
    expect(asked.body).toEqual({ ask: first.ask, steps: reportOf(trace).steps.slice(0, -1) })
    expect(reportOf(trace).steps.at(-1)).toEqual({
      step_no: first.solve().calls.length + 1,
      tool: '',
      filled_by: 'small',
      result_shape: 'ok',
      verified: true,
      model: 'small',
      reply: first.solve().reply,
    })
    expect(stepLineOf(trace).endsWith('reply small')).toBe(true)
  })

  it("leaves the reply to the agent's large model when the door says a model is needed, and asks nothing with the route off or a step handed back", async () => {
    const reason = 'a value the reply wrote is not in the ask or the results: amount'
    const refused = await played({ reply: () => ({ kind: 'needs_model', reason }) }, first, { reply: true })
    expect(refused.door.model.seen).toHaveLength(1)
    expect(refused.trace).toMatchObject({ ended: 'done', reply: first.solve().reply })
    expect(reportOf(refused.trace).steps.every((s) => s.reply === undefined)).toBe(true)
    expect(stepLineOf(refused.trace).endsWith('reply needs_model, reply large')).toBe(true)

    const off = await played({}, first)
    expect(sentTo(off.door, 'playbooks/reply')).toEqual([])
    const handedBack = await played(
      { mark: () => 'door', kind: (_, stepNo) => (stepNo === 2 ? 'needs_model' : undefined) },
      first,
      { reply: true },
    )
    expect(sentTo(handedBack.door, 'playbooks/reply')).toEqual([])
    expect(handedBack.trace).toMatchObject({ ended: 'done', reply: first.solve().reply })
  })

  it('makes one chat call with the transcript so far on needs_model or done, and none on stop', async () => {
    const planned = plannedOf(domain, first)
    const extra = planned.length + 1
    const plan: Planned[] = [
      ...planned,
      { tool: 'get_ticket', args: { ticket_id: 'unused' }, marks: { ticket_id: 'door' } },
    ]
    for (const kind of ['needs_model', 'done'] as const) {
      const { trace, session, door } = await played(
        { plan: () => plan, kind: (_, stepNo) => (stepNo === extra ? kind : undefined) },
        first,
      )
      expect({ kind, chats: door.model.seen.length }).toEqual({ kind, chats: 1 })
      expect((door.model.seen[0]?.body.messages as unknown[]).length).toBe(2 + 2 * planned.length)
      expect(sentTo(door, 'playbooks/fill').at(-1)?.body.step_no).toBe(extra)
      expect(trace).toMatchObject({ ended: 'done', reply: first.solve().reply })
      expect(session.check(trace.reply ?? '').pass).toBe(true)
    }
    const stopped = await played({ mark: () => 'door', kind: () => 'stop' }, first)
    expect(stopped.door.model.seen).toEqual([])
    expect(stopped.trace).toMatchObject({ ended: 'stopped', why: 'the door said stop', reply: null })
  })

  it('hands a job the door could not plan back to the plain path, asking for no reply and sending no report', async () => {
    const { trace, door } = await played({ noPlaybook: new Set([first.id]) }, first)
    expect(door.model.seen).toEqual([])
    expect(sentTo(door, 'playbooks/report')).toEqual([])
    expect(trace).toMatchObject({
      ended: 'plain',
      why: 'the door could not plan the job',
      reply: null,
      report: null,
      reported: false,
    })
    expect(stepLineOf(trace)).toBe('plain: the door could not plan the job')
  })

  it("cuts a result past the door's bound to text whose JSON fits it, and leaves out a call past its own", async () => {
    const padding = 'y"\\'.repeat(3000)
    const { trace } = await played({}, first, {}, (deps) => ({
      call: (tool, args) => {
        const result = deps.call(tool, args)
        return typeof result === 'object' && result !== null && !Array.isArray(result) ? { ...result, padding } : result
      },
    }))
    expect(trace.ended).toBe('done')
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
    for (const step of reportOf(trace).steps.filter((s) => s.call !== undefined)) {
      expect([step.step_no, step.truncated, typeof step.result]).toEqual([step.step_no, true, 'string'])
      expect(bytes(step.result)).toBeLessThanOrEqual(8192)
      expect(bytes(step.result)).toBeGreaterThan(8000)
    }
  })

  it('reports each step it called, who filled it, its shape, its call and its result, under the job id and a nonce', async () => {
    const { trace, door } = await played({}, first)
    const reports = sentTo(door, 'playbooks/report')
    expect(reports).toHaveLength(1)
    const sandbox = first.open()
    const results = first.solve().calls.map((c) => sandbox.call(c.tool, c.args))
    const events = toolEvents(trace)
    expect(reports[0]?.body).toEqual({
      job_id: `run-p.${first.id}`,
      pass_id: `run-p.${first.id}.n1`,
      ended: 'done',
      reported_at: '2026-10-25T00:00:00.000Z',
      ask: first.ask,
      ask_truncated: false,
      system: domain.system,
      system_truncated: false,
      tools: domain.tools,
      tools_truncated: false,
      steps: first.solve().calls.map((c, i) => ({
        step_no: i + 1,
        tool: c.tool,
        filled_by: events[i]?.filled_by,
        result_shape: 'ok',
        verified: true,
        model: events[i]?.model,
        call: Object.fromEntries(Object.entries(c.args).map(([name, value]) => [name, String(value)])),
        call_truncated: false,
        result: results[i],
        truncated: false,
      })),
      steps_truncated: false,
    })
    expect(trace.reported).toBe(true)
  })

  it("cuts the report's system prompt over its bound and flags it, and leaves out tools over theirs, flagged", async () => {
    const system = 'é'.repeat(9000)
    const tools = [...domain.tools, { blob: 'x'.repeat(70_000) }]
    const long = await played({}, first, {
      tools,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: first.ask },
      ],
    })
    const report = reportOf(long.trace)
    expect(report).toMatchObject({
      ask: first.ask,
      ask_truncated: false,
      system_truncated: true,
      tools_truncated: true,
    })
    expect(Buffer.byteLength(report.system as string)).toBeLessThanOrEqual(SYSTEM_BYTES)
    expect(Buffer.byteLength(report.system as string)).toBeGreaterThan(SYSTEM_BYTES - 4)
    expect(system.startsWith(report.system as string)).toBe(true)
    // The door takes tools as a list only, so a cut list is none: left out, and the door counts without them.
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeGreaterThan(TOOLS_BYTES)
    expect(report.tools).toBeUndefined()
    expect(long.trace.ended).toBe('done')
    const ask = `${first.ask} ${'x'.repeat(17_000)}`
    const asked = await played({}, first, { ask })
    expect(asked.trace).toMatchObject({ ended: 'abandoned', report: { ask_truncated: true } })
    expect(Buffer.byteLength(reportOf(asked.trace).ask as string)).toBe(ASK_BYTES)
    expect(ask.startsWith(reportOf(asked.trace).ask as string)).toBe(true)
  })

  it('leaves a call over 4 KB out of the report and flags it, while the tool is called with all of it', async () => {
    const query = 'q'.repeat(5000)
    let sent = ''
    const { trace } = await played(
      { plan: () => [{ tool: 'find_customer', args: { query }, marks: { query: 'ask' } }] },
      first,
      {},
      (deps) => ({
        call: (tool, args) => {
          sent = String(args.query)
          return deps.call(tool, args)
        },
      }),
    )
    expect(sent).toBe(query)
    const step = need(reportOf(trace).steps[0], 'a reported step')
    // The door takes a call as an object only, so a cut one is none.
    expect(Buffer.byteLength(JSON.stringify({ query }))).toBeGreaterThan(CALL_BYTES)
    expect([step.call, step.call_truncated]).toEqual([undefined, true])
  })

  it('reports at most 64 steps, and flags a longer job whose report was cut', async () => {
    const inst = need(
      instances.find((i) => i.solve().calls[0]?.tool === 'get_ticket'),
      'a job that starts at a ticket',
    )
    const ticketId = String(need(inst.solve().calls[0], 'a call').args.ticket_id)
    const plan: Planned[] = Array.from({ length: 70 }, () => ({
      tool: 'get_ticket',
      args: { ticket_id: ticketId },
      marks: { ticket_id: 'ask' },
    }))
    const { trace } = await played({ plan: () => plan }, inst, { maxSteps: 100 })
    expect(toolEvents(trace)).toHaveLength(70)
    expect(reportOf(trace).steps.map((s) => s.step_no)).toEqual(Array.from({ length: REPORT_STEPS }, (_, i) => i + 1))
    expect(reportOf(trace).steps_truncated).toBe(true)
  })

  it("sends each earlier step's call beside its result to the fill entrance", async () => {
    const { door } = await played({ mark: () => 'door' }, first)
    const calls = first
      .solve()
      .calls.map((c) => Object.fromEntries(Object.entries(c.args).map(([name, value]) => [name, String(value)])))
    for (const [i, fill] of sentTo(door, 'playbooks/fill').entries()) {
      const results = fill.body.results as { step_no: number; call: unknown; result: unknown }[]
      expect(results.map((r) => [r.step_no, r.call])).toEqual(calls.slice(0, i).map((call, j) => [j + 1, call]))
    }
  })

  it('cuts a result over 8 KB to text whose own JSON fits 8192 bytes, never splitting a character, and says so', async () => {
    const big = { blob: 'é'.repeat(6000) }
    let calls = 0
    const { trace } = await played({}, first, {}, (deps) => ({
      call: (tool, args) => {
        const result = deps.call(tool, args)
        calls += 1
        return calls === 1 ? big : result
      },
    }))
    const step = need(reportOf(trace).steps[0], 'a reported step')
    expect(step).toMatchObject({ truncated: true, result_shape: 'ok' })
    const cut = step.result as string
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(RESULT_BYTES)
    expect(Buffer.byteLength(cut)).toBeGreaterThan(RESULT_BYTES - 6)
    expect(JSON.stringify(big).startsWith(cut)).toBe(true)
    expect(
      reportOf(trace)
        .steps.slice(1)
        .every((s) => !s.truncated),
    ).toBe(true)
  })

  it('writes a step line saying who filled each step and how the job ended', async () => {
    const calls = first.solve().calls
    const mixed = await played({ mark: (_, stepNo) => (stepNo === 1 ? 'ask' : 'door') }, first)
    expect(stepLineOf(mixed.trace)).toBe(
      [...calls.map((c, i) => `${i + 1} ${c.tool} ${i === 0 ? 'ask' : 'large'} ok`), 'reply large'].join(', '),
    )
    const failed = await played(
      { plan: () => [{ tool: 'get_order', args: { order_id: 'O-NONE' }, marks: { order_id: 'ask' } }] },
      first,
    )
    expect(stepLineOf(failed.trace)).toBe('1 get_order ask failed, stopped: a failed result')
    const told = await played({ mark: () => 'door', kind: () => 'stop' }, first)
    expect(stepLineOf(told.trace)).toBe(`1 ${need(calls[0], 'a call').tool} stop, stopped: the door said stop`)
  })

  it('abandons the job when the door does not answer, and still sends its report', async () => {
    const { trace, door } = await played({ off: true }, first)
    expect(trace).toMatchObject({ ended: 'abandoned', why: 'status 404', reply: null, reported: false })
    expect(door.seen).toEqual([])
    expect(trace.events.map((e) => (e.kind === 'door' ? e.route : e.kind))).toEqual(['playbooks', 'playbooks/report'])
    expect(stepLineOf(trace)).toBe('abandoned: status 404')
  })

  it('fills on the client only a local ask value in place: an ask value not marked local, a model value or a blank one goes to the door', async () => {
    for (const mark of ['ask-not-local', 'model-in-place', 'blank-ask'] as const) {
      const { trace, session, door } = await played({ mark: (_, stepNo) => (stepNo === 1 ? mark : 'ask') }, first)
      expect({ mark, fills: sentTo(door, 'playbooks/fill').map((f) => f.body.step_no) }).toEqual({ mark, fills: [1] })
      expect(toolEvents(trace)[0]).toMatchObject({ step_no: 1, by: 'door', filled_by: 'large' })
      expect(actsOf(session.effects)).toEqual(referenceEffects(first))
    }
  })

  it('does not fill from an earlier result whose value at the key is blank, and asks the door', async () => {
    const inst = need(
      instances.find((i) => i.solve().calls[0]?.tool === 'get_ticket'),
      'a job that starts at a ticket',
    )
    const ticketId = String(need(inst.solve().calls[0], 'a call').args.ticket_id)
    const ticket = inst.open().call('get_ticket', { ticket_id: ticketId }) as { order_id: string | null }
    const plan: Planned[] = [
      { tool: 'get_ticket', args: { ticket_id: ticketId }, marks: { ticket_id: 'ask' } },
      {
        tool: 'get_order',
        args: { order_id: need(ticket.order_id ?? undefined, 'an order') },
        marks: { order_id: { from: 1, path: 'order_id' } },
      },
    ]
    const { door } = await played({ plan: () => plan }, inst, {}, (deps) => ({
      call: (tool, args) => {
        const result = deps.call(tool, args)
        return tool === 'get_ticket' ? { ...(result as object), order_id: '   ' } : result
      },
    }))
    expect(sentTo(door, 'playbooks/fill').map((f) => f.body.step_no)).toEqual([2])
  })

  it('stops on a filled step under another step number, or with a blank left empty, calling nothing', async () => {
    const changes: [string, (step: DoorStep) => DoorStep][] = [
      ['another step number', (step) => ({ ...step, step_no: step.step_no + 1 })],
      [
        'a blank left empty',
        (step) => ({ ...step, blanks: step.blanks.map((b, i) => (i === 0 ? { ...b, value: null } : b)) }),
      ],
    ]
    for (const [what, change] of changes) {
      const { trace, session } = await played({ mark: () => 'door', fillAs: (_, __, step) => change(step) }, first)
      expect({ what, calls: toolEvents(trace).length, why: trace.why }).toEqual({
        what,
        calls: 0,
        why: 'an act the playbook did not name',
      })
      expect(session.effects).toEqual([])
    }
  })

  it('reads null, nothing, an empty string, an empty list and an empty object each as an empty result, and stops', async () => {
    for (const empty of [null, undefined, '', [], {}]) {
      const { trace } = await played({}, first, {}, () => ({ call: () => empty }))
      expect({ empty, shapes: toolEvents(trace).map((e) => e.shape), why: trace.why }).toEqual({
        empty,
        shapes: ['empty'],
        why: 'an empty result',
      })
    }
  })

  it('stops at the step cap, capped, having called no more steps than it allows', async () => {
    const inst = need(
      instances.find((i) => i.solve().calls.length >= 2),
      'a job of two calls or more',
    )
    const { trace } = await played({}, inst, { maxSteps: 1 })
    expect(toolEvents(trace)).toHaveLength(1)
    expect(trace).toMatchObject({ ended: 'stopped', why: 'the step cap', capped: true, reply: null })
  })

  it('abandons the job on a door answer that does not read as its record', async () => {
    type Body = Record<string, unknown>
    const withStep = (body: Body, change: Body): Body => ({
      ...body,
      steps: (body.steps as Body[]).map((s, i) => (i === 0 ? { ...s, ...change } : s)),
    })
    const withBlank = (body: Body, change: Body): Body =>
      withStep(body, {
        blanks: (need((body.steps as Body[])[0], 'a step').blanks as Body[]).map((b, i) =>
          i === 0 ? { ...b, ...change } : b,
        ),
      })
    const cases: [string, 'playbooks' | 'playbooks/fill', (body: Body) => Body, string][] = [
      ['no job_id', 'playbooks', (b) => without(b, 'job_id'), 'an answer that is not a playbook'],
      [
        'a step_no no whole number',
        'playbooks',
        (b) => withStep(b, { step_no: 'one' }),
        'an answer that is not a playbook',
      ],
      ['a tool no string', 'playbooks', (b) => withStep(b, { tool: 7 }), 'an answer that is not a playbook'],
      ['a local no boolean', 'playbooks', (b) => withBlank(b, { local: 'yes' }), 'an answer that is not a playbook'],
      [
        'an unknown filled_by',
        'playbooks',
        (b) => withBlank(b, { filled_by: 'guess' }),
        'an answer that is not a playbook',
      ],
      ['a value no string', 'playbooks', (b) => withBlank(b, { value: 5 }), 'an answer that is not a playbook'],
      [
        'a from with no whole step_no',
        'playbooks',
        (b) => withBlank(b, { from: { step_no: 'x', path: 'id' } }),
        'an answer that is not a playbook',
      ],
      ['an unknown kind', 'playbooks/fill', (b) => ({ ...b, kind: 'maybe' }), 'an answer that is not a fill answer'],
      [
        'an unknown filler',
        'playbooks/fill',
        (b) => ({ ...b, filled_by: 'guess' }),
        'an answer that is not a fill answer',
      ],
      [
        'a filled answer with no step',
        'playbooks/fill',
        (b) => without(b, 'step'),
        'an answer that is not a fill answer',
      ],
    ]
    for (const [what, route, corrupt, why] of cases) {
      const { trace } = await played({ mark: () => 'door' }, first, {}, (deps) => ({
        post: async (to, body, headers) => {
          const answer = await deps.post(to, body, headers)
          return to === route && answer.ok ? { ...answer, body: corrupt(answer.body) } : answer
        },
      }))
      expect({ what, ended: trace.ended, why: trace.why }).toEqual({ what, ended: 'abandoned', why })
    }
  })
})

describe("the reference solutions, as the playbook client's stop rules read them", () => {
  it('come back neither empty nor refused in every domain, so a right job is never stopped', () => {
    for (const domain of DOMAINS) {
      for (const inst of domain.instances(1, 4)) {
        const session = inst.open()
        for (const c of inst.solve().calls) {
          const result = session.call(c.tool, c.args)
          const empty =
            result === null ||
            result === '' ||
            (Array.isArray(result) && result.length === 0) ||
            (typeof result === 'object' && result !== null && Object.keys(result).length === 0)
          expect({ task: inst.id, tool: c.tool, empty, failed: toolFailed(result) }).toEqual({
            task: inst.id,
            tool: c.tool,
            empty: false,
            failed: false,
          })
        }
      }
    }
  })
})

describe('the playbook arm', () => {
  const domain = domainNamed('support-ops')
  const instances = domain.instances(5, 1)

  const ranPlaybook = async (
    doorOpts: Partial<Omit<DoorOptions, 'domain' | 'seed'>>,
    run: Partial<RunOptions> = {},
  ): Promise<{
    door: Door
    out: string
    sleeps: number[]
    record: RunRecord
    steps: StepLine[]
    tasks: TaskLine[]
  }> => {
    const days = doorOpts.days ?? 1
    const door = await startDoor({ domain, seed: 5, ...doorOpts, days })
    const out = scratch()
    const sleeps: number[] = []
    try {
      const record = await runArm({
        arm: 'playbook',
        domain,
        days,
        seed: 5,
        baseUrl: door.url,
        key: 'test-key',
        large: 'big-model',
        small: 'small-model',
        runId: 'pb-1',
        out,
        prices: PRICES,
        harnessCommit: 'abc123',
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        // The library client's provider is the fake model behind the door, which the door itself no longer forwards to.
        ...(run.client === 'library' ? { providerUrl: door.model.url, providerKey: 'provider-key' } : {}),
        ...run,
      })
      return {
        door,
        out,
        sleeps,
        record,
        steps: lines(join(out, 'steps.jsonl')),
        tasks: lines(join(out, 'tasks.jsonl')),
      }
    } finally {
      await door.close()
    }
  }

  it("posts each job once on a cold round and runs every step through the task's own tools, every task passing", async () => {
    const r = await ranPlaybook({})
    expect(r.door.seen[0]).toMatchObject({ route: 'playbooks' })
    expect(r.door.seen[0]?.body).toEqual({})
    const asked = sentTo(r.door, 'playbooks').slice(1)
    expect(asked.map((s) => s.body.ask)).toEqual(instances.map((i) => i.ask))
    expect(asked.map((s) => s.headers['x-reactor-run'])).toEqual(instances.map((i) => `pb-1.${i.id}`))
    expect(asked.every((s) => s.headers.authorization === 'Bearer test-key')).toBe(true)
    expect(r.tasks).toHaveLength(20)
    expect(r.tasks.filter((t) => !t.passed)).toEqual([])
    for (const inst of instances) {
      const mine = r.steps.filter((s) => s.instance === inst.id && s.kind === 'tool')
      expect(mine.map((s) => s.tool)).toEqual(inst.solve().calls.map((c) => c.tool))
    }
    expect(r.door.model.seen.map((s) => s.headers['x-reactor-run'])).toEqual(instances.map((i) => `pb-1.${i.id}`))
    expect(r.tasks.every((t) => t.ended === 'done' && t.reported === true)).toBe(true)
    expect(sentTo(r.door, 'playbooks/report')).toHaveLength(20)
  })

  it('stamps each step line with when it ended, in ms since its job started, on either client', async () => {
    for (const client of ['bare', 'library'] as const) {
      const r = await ranPlaybook({}, { client })
      expectClocked(r.steps, r.tasks)
      // The plan's round runs before the first tool step, so the first tool's line is later than the job's start.
      const firstTool = r.steps.find((s) => s.kind === 'tool')
      expect(firstTool?.at_ms, client).toBeGreaterThanOrEqual(r.steps[0]!.at_ms!)
    }
  })

  it('runs the arm with the customer library as it runs it with the bare client, door by door and step by step', async () => {
    // The library is what a customer installs; on every door the bare client meets here it must take the same steps,
    // ask the door the same things, and end each job the same way.
    const wrong = new Set([instances[3]!.id])
    const doors: Partial<Omit<DoorOptions, 'domain' | 'seed'>>[] = [
      {},
      { mark: () => 'door' },
      { mark: () => 'door', kind: (_i, stepNo) => (stepNo === 2 ? 'needs_model' : undefined) },
      { mark: () => 'door', kind: (_i, stepNo) => (stepNo === 2 ? 'stop' : undefined) },
      { wrong },
      { noPlaybook: new Set([instances[0]!.id]) },
    ]
    const view = (r: Awaited<ReturnType<typeof ranPlaybook>>) => ({
      tasks: r.tasks.map((t) => [t.instance, t.passed, t.ended, t.reported, t.step_line]),
      // The library client asks pass before each of the agent's calls, which the bare client does not: those lines and
      // posts are left out, the agent's own call beside them is compared.
      steps: r.steps
        .filter((s) => !(s.kind === 'door' && s.route === 'playbooks/pass'))
        .map((s) => [s.instance, s.kind, s.tool, s.route === 'playbooks/pass' ? 'chat/completions' : s.route]),
      routes: r.door.seen.filter((s) => s.route !== 'playbooks/pass').map((s) => [s.route, s.body.step_no ?? null]),
      // Each report's steps, the agent's after the hand-back included.
      reports: r.door.seen
        .filter((s) => s.route === 'playbooks/report')
        .map((s) =>
          (s.body.steps as Record<string, unknown>[]).map((step) => [
            step.step_no,
            step.tool,
            step.filled_by,
            step.model,
            step.result_shape,
          ]),
        ),
    })
    for (const doorOpts of doors) {
      const bare = view(await ranPlaybook(doorOpts))
      const library = await ranPlaybook(doorOpts, { client: 'library' })
      expect(view(library), JSON.stringify(Object.keys(doorOpts))).toEqual(bare)
      expect(library.record).toMatchObject({ client: 'library' })
    }
    // With the reply route on: the door's words, its refusal, and a step handed back that asks for no reply.
    const reason = 'a value the reply wrote is not in the ask or the results: id'
    for (const doorOpts of [
      {},
      { reply: () => ({ kind: 'needs_model' as const, reason }) },
      {
        mark: () => 'door' as const,
        kind: (_i: Instance, stepNo: number) => (stepNo === 2 ? ('needs_model' as const) : undefined),
      },
    ]) {
      const bare = await ranPlaybook(doorOpts, { reply: true })
      const library = await ranPlaybook(doorOpts, { client: 'library', reply: true })
      expect(view(library), JSON.stringify(Object.keys(doorOpts))).toEqual(view(bare))
      expect(bare.record).toMatchObject({ reply: 'on' })
    }
  })

  it('prices a pass the door served after a small-model round, and writes no provider key to the run', async () => {
    const r = await ranPlaybook(
      { mark: () => 'door', kind: (_, stepNo) => (stepNo === 2 ? 'needs_model' : undefined), servePass: true },
      { client: 'library', providerKey: 'sk-provider-secret' },
    )
    const answers = r.steps.filter((s) => s.route === 'playbooks/answer')
    expect(answers.length).toBeGreaterThan(0)
    // The pass line says the door asked a round; the round's line carries the verdict the pass settled on, as the
    // pass's own. The 2026-11-04 rerun wrote null on both, and the table could not tell a served step from a refused one.
    expect(
      new Set(r.steps.filter((s) => s.kind === 'door' && s.route === 'playbooks/pass').map((s) => s.said)),
    ).toEqual(new Set(['run_model']))
    expect(new Set(answers.map((s) => `${s.settles ?? '-'}:${s.said ?? '-'}`))).toEqual(
      new Set(['playbooks/pass:served']),
    )
    const small = PRICES.models['small-model']!
    for (const line of answers) {
      expect(line.served_by).toBe('small')
      expect(line.usage_reported).toBe(true)
      // The fake model reports usageAt(step) on each run; the round is priced at the small model.
      const tokens = [...Array(40).keys()]
        .map((step) => usageAt(step))
        .find(
          (u) =>
            (u.prompt_tokens * small.in_per_mtok + u.completion_tokens * small.out_per_mtok) / 1_000_000 ===
            line.cost_usd,
        )
      expect(tokens, `cost ${line.cost_usd}`).toBeDefined()
      expect(line.response_model).toBeNull()
    }
    const served = r.steps.filter((s) => s.kind === 'tool' && s.route === 'playbooks/pass')
    expect(served.length).toBeGreaterThan(0)
    expect(served.every((s) => s.served_by === 'small' && s.cost_usd === 0)).toBe(true)
    const passes = r.steps.filter((s) => s.kind === 'door' && s.route === 'playbooks/pass')
    expect(passes.length).toBeGreaterThan(0)
    expect(passes.every((s) => s.said === 'run_model')).toBe(true)
    // The provider key reaches the provider only: no file of the run holds it.
    for (const file of ['steps.jsonl', 'tasks.jsonl', 'run.json']) {
      expect(readFileSync(join(r.out, file), 'utf8')).not.toContain('sk-provider-secret')
    }
  })

  it('runs a job the door could not plan on the plain path, served by the large model under no run, and reports nothing for it', async () => {
    const unplanned = need(instances[0], 'a job')
    for (const client of ['bare', 'library'] as const) {
      const r = await ranPlaybook({ noPlaybook: new Set([unplanned.id]) }, { client })
      expect(r.tasks.filter((t) => !t.passed)).toEqual([])
      expect(r.tasks.find((t) => t.instance === unplanned.id)).toMatchObject({
        ended: 'plain',
        reported: false,
        step_line: 'plain: the door could not plan the job',
      })
      const mine = r.steps.filter((s) => s.instance === unplanned.id)
      const calls = unplanned.solve().calls.map((c) => c.tool)
      expect(mine.map((s) => [s.step, s.kind, s.tool, s.route])).toEqual([
        [1, 'door', null, 'playbooks'],
        ...calls.map((tool, i) => [i + 2, 'tool', tool, 'chat/completions']),
        [calls.length + 2, 'talk', null, 'chat/completions'],
      ])
      expect(mine.filter((s) => s.kind !== 'door').every((s) => s.served_by === 'large')).toBe(true)
      expect(sentTo(r.door, 'playbooks/report')).toHaveLength(19)
      const chats = r.door.model.seen.filter(
        (s) => (s.body.messages as { content: string }[])[1]?.content === unplanned.ask,
      )
      expect(chats).toHaveLength(calls.length + 1)
      expect(chats.every((s) => s.headers['x-reactor-run'] === undefined)).toBe(true)
    }
  })

  it('passes a job whose write the door hands back as needs_model: the agent makes it, its lines priced as model answers', async () => {
    const r = await ranPlaybook({ mark: () => 'door', kind: (_, stepNo) => (stepNo === 2 ? 'needs_model' : undefined) })
    expect(r.tasks.filter((t) => !t.passed)).toEqual([])
    expect(r.tasks.every((t) => t.ended === 'done' && t.reported === true)).toBe(true)
    for (const inst of instances.filter((i) => i.solve().calls.length >= 2)) {
      const agent = r.steps.filter((s) => s.instance === inst.id && s.kind === 'tool' && s.route === 'chat/completions')
      expect(agent.map((s) => s.tool)).toEqual(
        inst
          .solve()
          .calls.slice(1)
          .map((c) => c.tool),
      )
      expect(agent.every((s) => s.served_by === 'large' && s.usage_reported)).toBe(true)
    }
  })

  it('lets the door call a model on every fill unless --allow-model false says not to', async () => {
    const steps = instances.reduce((n, i) => n + i.solve().calls.length, 0)
    for (const allowModel of [undefined, false]) {
      const r = await ranPlaybook({ mark: () => 'door' }, allowModel === undefined ? {} : { allowModel })
      const fills = sentTo(r.door, 'playbooks/fill')
      expect(fills).toHaveLength(steps)
      expect(fills.every((f) => f.body.allow_model === (allowModel ?? true))).toBe(true)
      expect(r.record).toMatchObject({ client: 'bare', allow_model: allowModel ?? true })
    }
  })

  it('refuses to start against a door with the playbook off, in one sentence naming the variable, writing nothing', async () => {
    const door = await startDoor({ domain, seed: 5, days: 1, off: true })
    const out = join(scratch(), 'run')
    const ledger = join(scratch(), 'keys.json')
    try {
      await expect(
        runArm({
          arm: 'playbook',
          domain,
          days: 1,
          seed: 5,
          baseUrl: door.url,
          key: 'test-key',
          large: 'big-model',
          small: 'small-model',
          runId: 'pb-off',
          out,
          prices: PRICES,
          harnessCommit: 'abc123',
          ledger,
        }),
      ).rejects.toThrow(
        /^the door answered 404 at \/v1\/playbooks: start it with REACTOR_PLAYBOOK_DOOR=on to run the playbook arm$/,
      )
      expect(existsSync(out)).toBe(false)
      expect(existsSync(ledger)).toBe(false)
      expect(door.model.seen).toEqual([])
    } finally {
      await door.close()
    }
  })

  it('writes the reason a fill answer gives on its door line, and none where it gives none', async () => {
    const r = await ranPlaybook({
      mark: (_, stepNo) => (stepNo === 1 ? 'ask' : 'door'),
      kind: (_, stepNo) => (stepNo === 2 ? 'needs_model' : undefined),
      reason: (_, stepNo) => (stepNo === 2 ? 'send: no tool schema at the door' : undefined),
    })
    const fills = r.steps.filter((s) => s.kind === 'door' && s.route === 'playbooks/fill')
    expect(
      fills.filter((s) => s.said === 'needs_model').every((s) => s.reason === 'send: no tool schema at the door'),
    ).toBe(true)
    expect(fills.filter((s) => s.said === 'needs_model').length).toBeGreaterThan(0)
    expect(fills.filter((s) => s.said === 'filled').every((s) => !('reason' in s))).toBe(true)
  })

  it("prices each door answer's spend, the header's when it names a call and else the body's, and a local fill at $0", async () => {
    const one = (model: string) => [{ model, tokens_in: 1000, tokens_out: 0, purpose: 'fill' }]
    const r = await ranPlaybook({
      mark: (_, stepNo) => (stepNo === 1 ? 'ask' : 'door'),
      spent: (route, _, stepNo) =>
        route === 'playbooks/fill'
          ? stepNo === 2
            ? { body: one('small-model'), header: one('big-model') }
            : { body: one('small-model') }
          : {},
    })
    const inst = need(
      instances.find((i) => i.solve().calls.length >= 3),
      'a job of three calls or more',
    )
    const mine = r.steps.filter((s) => s.instance === inst.id)
    const fills = mine.filter((s) => s.kind === 'door' && s.route === 'playbooks/fill')
    expect(fills.map((s) => s.overhead_usd)).toEqual(
      inst
        .solve()
        .calls.slice(1)
        .map((_, i) => (i === 0 ? 0.01 : 0.001)),
    )
    const tools = mine.filter((s) => s.kind === 'tool')
    expect(tools.every((s) => s.cost_usd === 0 && s.overhead_usd === 0)).toBe(true)
    expect(tools[0]).toMatchObject({ filled_by: 'ask', served_by: null })
    expect(tools.slice(1).every((s) => s.filled_by === 'large' && s.served_by === 'large')).toBe(true)
    expect(mine.find((s) => s.kind === 'talk')).toMatchObject({
      served_by: 'large',
      usage_reported: true,
      cost_usd: bigCost(inst.solve().calls.length),
    })
  })

  it("writes each task's step line, how its job ended and whether the door took its report", async () => {
    const r = await ranPlaybook({ mark: (_, stepNo) => (stepNo === 1 ? 'ask' : 'door') })
    for (const inst of instances) {
      const task = need(
        r.tasks.find((t) => t.instance === inst.id),
        inst.id,
      )
      const parts = inst.solve().calls.map((c, i) => `${i + 1} ${c.tool} ${i === 0 ? 'ask' : 'large'} ok`)
      expect(task.step_line).toBe([...parts, 'reply large'].join(', '))
      expect(task).toMatchObject({ ended: 'done', reported: true, passed: true })
    }
  })

  it('waits the settle time between days, and records its client and allow_model on the playbook arm only', async () => {
    const r = await ranPlaybook({ days: 2 })
    expect(r.sleeps).toEqual([65_000])
    expect(JSON.parse(readFileSync(join(r.out, 'run.json'), 'utf8'))).toMatchObject({
      arm: 'playbook',
      small_model: 'small-model',
      settle_seconds: 65,
      client: 'bare',
      allow_model: true,
    })
    const plain = await ran({ domain, seed: 5, days: 1 }, { arm: 'plain' })
    const record = JSON.parse(readFileSync(join(plain.out, 'run.json'), 'utf8')) as Record<string, unknown>
    expect([Object.hasOwn(record, 'client'), Object.hasOwn(record, 'allow_model')]).toEqual([false, false])
  })

  it('sends a report again after a 5xx with the same pass_id, the job id and a nonce of its own', async () => {
    const r = await ranPlaybook({ reportStatuses: [503] })
    const reports = sentTo(r.door, 'playbooks/report')
    expect(reports).toHaveLength(21)
    expect(reports[1]?.body).toEqual(reports[0]?.body)
    const jobId = String(reports[0]?.body.job_id)
    const passId = String(reports[0]?.body.pass_id)
    expect([passId.startsWith(`${jobId}.`), /^[0-9a-f]{8}$/.test(passId.slice(jobId.length + 1))]).toEqual([true, true])
    expect(new Set(reports.map((s) => s.body.pass_id)).size).toBe(20)
    expect(r.sleeps).toEqual([1000])
    expect(r.tasks.every((t) => t.reported === true)).toBe(true)
  })

  it('checks its Reactor key against the key ledger as the reactor arm does, and refuses a seen key when a fresh one is required', async () => {
    const door = await startDoor({ domain, seed: 5, days: 1 })
    const ledger = join(scratch(), 'keys.json')
    const base = {
      arm: 'playbook',
      domain,
      days: 1,
      seed: 5,
      baseUrl: door.url,
      key: 'reactor-playbook-key',
      large: 'big-model',
      small: 'small-model',
      prices: PRICES,
      harnessCommit: 'abc123',
      sleep: async () => undefined,
      ledger,
    } as const
    try {
      const first = await runArm({ ...base, runId: 'pb-a', out: join(scratch(), 'run') })
      expect(first).toMatchObject({ key_seen_before: false, key_earlier_run_id: null })
      const out = join(scratch(), 'run')
      await expect(runArm({ ...base, runId: 'pb-b', out, freshKeyRequired: true })).rejects.toThrow(
        /^the Reactor key was used by run pb-a before this run; --fresh-key-required refuses it$/,
      )
      expect(existsSync(out)).toBe(false)
      const again = await runArm({ ...base, runId: 'pb-c', out: join(scratch(), 'run') })
      expect(again).toMatchObject({ key_seen_before: true, key_earlier_run_id: 'pb-a' })
    } finally {
      await door.close()
    }
  })

  it('fails the task of a job that ended with no reply, and says how it ended', async () => {
    const stopped = need(instances[0], 'a job')
    const r = await ranPlaybook({
      plan: (i) =>
        i.id === stopped.id
          ? [{ tool: 'get_order', args: { order_id: 'O-NONE' }, marks: { order_id: 'ask' } }]
          : undefined,
    })
    expect(r.tasks.find((t) => t.instance === stopped.id)).toMatchObject({
      passed: false,
      reason: 'stopped: a failed result',
      ended: 'stopped',
    })
    expect(r.tasks.filter((t) => t.instance !== stopped.id).every((t) => t.passed)).toBe(true)
  })
})

describe('the playbook arm on the command line', { timeout: 60_000 }, () => {
  const domain = domainNamed('support-ops')
  const pricesFile = join(scratch(), 'prices.json')
  writeFileSync(pricesFile, JSON.stringify(PRICES))
  const env = { REPEAT_BILL_TEST_KEY: 'x' }
  const args = (url: string, out: string): string[] => [
    'run',
    '--arm',
    'playbook',
    '--domain',
    'support-ops',
    '--run-id',
    'cli-pb',
    '--base-url',
    url,
    '--key',
    'REPEAT_BILL_TEST_KEY',
    '--large',
    'big-model',
    '--small',
    'small-model',
    '--days',
    '1',
    '--seed',
    '1',
    '--out',
    out,
    '--prices',
    pricesFile,
    '--ledger',
    join(scratch(), 'keys.json'),
  ]

  it('runs every job through the door and writes the arm', async () => {
    const door = await startDoor({ domain, seed: 1, days: 1 })
    const out = join(scratch(), 'run')
    try {
      const r = await cli(args(door.url, out), env)
      expect({ code: r.code, out: r.out }).toMatchObject({ code: 0 })
      expect(r.out).toContain('done: playbook arm, support-ops, 1 days, run cli-pb')
      expect(lines<TaskLine>(join(out, 'tasks.jsonl')).filter((t) => t.passed)).toHaveLength(20)
    } finally {
      await door.close()
    }
  })

  it('passes --allow-model false to every fill the door sees and to run.json', async () => {
    const door = await startDoor({ domain, seed: 1, days: 1, mark: () => 'door' })
    const out = join(scratch(), 'run')
    try {
      const r = await cli([...args(door.url, out), '--allow-model', 'false'], env)
      expect({ code: r.code, out: r.out }).toMatchObject({ code: 0 })
      expect(JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))).toMatchObject({ allow_model: false })
      const fills = sentTo(door, 'playbooks/fill')
      expect(fills.length).toBeGreaterThan(0)
      expect(fills.every((f) => f.body.allow_model === false)).toBe(true)
    } finally {
      await door.close()
    }
  })

  it('refuses the arm against a door with the playbook off, naming the variable', async () => {
    const door = await startDoor({ domain, seed: 1, days: 1, off: true })
    const out = join(scratch(), 'run')
    try {
      const r = await cli(args(door.url, out), env)
      expect(r.code).toBe(1)
      expect(r.out).toContain('start it with REACTOR_PLAYBOOK_DOOR=on to run the playbook arm')
      expect(existsSync(out)).toBe(false)
    } finally {
      await door.close()
    }
  })

  it('takes --client bare and --allow-model true or false on the playbook arm only, which needs --small', async () => {
    const base = args('http://127.0.0.1:9/v1', join(scratch(), 'never'))
    const other = await cli([...base, '--client', 'CLIENTVALUE7'], env)
    expect(other.code).toBe(2)
    expect(other.out).toContain('--client is bare')
    expect(other.out).not.toContain('CLIENTVALUE7')
    const word = await cli([...base, '--allow-model', 'ALLOWVALUE8'], env)
    expect(word.code).toBe(2)
    expect(word.out).toContain('--allow-model is true or false')
    expect(word.out).not.toContain('ALLOWVALUE8')
    const unsmall = await cli(
      base.filter((a) => a !== '--small' && a !== 'small-model'),
      env,
    )
    expect(unsmall.out).toContain('the playbook arm needs --small, the small model its key was made with')
    const plain = base
      .map((a) => (a === 'playbook' ? 'plain' : a))
      .filter(
        (a, i, all) => !['--small', '--ledger'].includes(a) && !['--small', '--ledger'].includes(all[i - 1] ?? ''),
      )
    for (const [flag, value] of [
      ['--client', 'bare'],
      ['--allow-model', 'false'],
    ] as const) {
      const refused = await cli([...plain, flag, value], env)
      expect({ flag, code: refused.code }).toEqual({ flag, code: 2 })
      expect(refused.out).toContain(`${flag} applies to the playbook arm only`)
    }
  })
})

describe('scoring the playbook arm against its plain arm', () => {
  const domain = domainNamed('support-ops')

  const playbookOut = async (
    seed: number,
    over: {
      words?: Words
      door?: Partial<Omit<DoorOptions, 'domain' | 'seed' | 'days' | 'words'>>
      reply?: boolean
    } = {},
  ): Promise<string> => {
    const door = await startDoor({ domain, seed, days: 2, words: over.words, ...over.door })
    const out = scratch()
    try {
      await runArm({
        arm: 'playbook',
        domain,
        days: 2,
        seed,
        words: over.words,
        baseUrl: door.url,
        key: 'test-key',
        large: 'big-model',
        small: 'small-model',
        runId: 'sc-1',
        out,
        prices: PRICES,
        harnessCommit: 'abc123',
        sleep: async () => undefined,
        ...(over.reply === undefined ? {} : { reply: over.reply }),
      })
    } finally {
      await door.close()
    }
    return out
  }
  const plainOut = async (seed: number, words: Words = 'new'): Promise<string> =>
    (await ran({ domain, seed, days: 2, words }, { arm: 'plain', runId: 'sc-1', words })).out

  it('pairs a playbook run with a plain run of the same seed and words, and refuses another seed or other words by name', async () => {
    const playbook = readRun(await playbookOut(5))
    expect(scoreRuns([readRun(await plainOut(5)), playbook]).map((r) => r.arm)).toEqual(['plain', 'playbook'])
    const otherSeed = readRun(await plainOut(6))
    expect(() => scoreRuns([otherSeed, playbook])).toThrow(
      /^run sc-1: the arms differ on seed \(plain 6, playbook 5\)$/,
    )
    const otherWords = readRun(await plainOut(5, 'same'))
    expect(() => scoreRuns([otherWords, playbook])).toThrow(
      /^run sc-1: the arms differ on words \(plain same, playbook new\)$/,
    )
  })

  it("counts the playbook arm's wrong tool calls by the reactor arm's rule, beside its failed calls on passed tasks", async () => {
    const playbook = readRun(await playbookOut(5, { door: { wrong: new Set(['support-ops.d2.refund-full']) } }))
    const results = scoreRuns([readRun(await plainOut(5)), playbook])
    const scored = need(
      results.find((r) => r.arm === 'playbook'),
      'the playbook arm',
    )
    expect(scored.days.map((d) => [d.day, d.wrong_tool_calls, d.failed_calls_on_passed])).toEqual([
      [1, 0, 0],
      [2, 1, 0],
    ])
    expect(scored.days.map((d) => d.passed)).toEqual([20, 19])
    expect(scored.notes).toContain(
      "On the playbook arm a failed or an empty result of a step the playbook made stops the job, so that task never passes; a call the customer's agent makes after the playbook may fail and the job goes on.",
    )
    expect(scored.notes).not.toContain('ends the job before its reply')
  })

  it('counts a job the door could not plan as run plain, with no saving, and never its failure as a wrong tool call', async () => {
    const job = 'support-ops.d2.refund-full'
    const others = 'support-ops.d2.address-update'
    const playbook = readRun(
      await playbookOut(5, { door: { noPlaybook: new Set([job, others]), model: { wrong: new Set([job]) } } }),
    )
    const scored = need(
      scoreRuns([readRun(await plainOut(5)), playbook]).find((r) => r.arm === 'playbook'),
      'the playbook arm',
    )
    expect(scored.days.map((d) => [d.day, d.passed, d.wrong_tool_calls])).toEqual([
      [1, 20, 0],
      [2, 19, 0],
    ])
    expect(scored.notes).toContain(
      '2 jobs the door could not plan ran on the plain path, served by the large model with no saving; a task among them that failed is not counted as a wrong tool call.',
    )
  })

  it("carries each task's step line into results.json and the table, and counts tool steps filled with no model", async () => {
    const dir = await playbookOut(5, { door: { mark: (_, stepNo) => (stepNo === 1 ? 'ask' : 'door') } })
    const data = readRun(dir)
    const [plain, scored] = scoreRuns([readRun(await plainOut(5)), data])
    expect(scored?.step_lines).toEqual(data.tasks.map((t) => ({ day: t.day, job: t.template, line: t.step_line })))
    expect(scored?.days.map((d) => d.no_model_tool_steps)).toEqual([20, 20])
    expect(scored?.days.map((d) => d.small_model_tool_steps)).toEqual([0, 0])
    expect(Object.hasOwn(need(plain, 'the plain arm'), 'step_lines')).toBe(false)
    expect(plain?.days.some((d) => Object.hasOwn(d, 'no_model_tool_steps'))).toBe(false)
    const table = `${tableOf(scoreRuns([readRun(await plainOut(5)), data]))}\n${jobTableOf([readRun(await plainOut(5)), data])}`
    expect(table).toContain('| 2 | playbook |')
    expect(table).toContain('on the playbook arm.')
    expect(table).toContain('who filled each tool step on the playbook arm, per job')
    expect(table).toContain(
      `- Day 1, ${need(data.tasks[0], 'a task').template}: ${need(data.tasks[0], 'a task').step_line}`,
    )
  })

  it("counts each day's final replies by who wrote them, those the small model held back and the door's refusals by kind, beside the cost with every tool step free", async () => {
    // In turn: the oracle's words, a reply the small model held back, a refusal for an amount; and on day 2 one reply
    // the shell never answered, which the large model writes and no refusal column counts.
    const counts = new Map<number, { held: number; refused: number }>()
    let asked = 0
    let unanswered = false
    const scripted = {
      reply: (inst: Instance) => {
        const day = counts.get(inst.day) ?? { held: 0, refused: 0 }
        counts.set(inst.day, day)
        if (inst.day === 2 && !unanswered) {
          unanswered = true
          return { kind: 'needs_model' as const, reason: 'the shell did not answer: it could not be reached' }
        }
        const turn = asked++ % 3
        if (turn === 1) {
          day.held += 1
          return { kind: 'needs_model' as const, reason: 'the small model says a step is still to be made' }
        }
        if (turn === 2) {
          day.refused += 1
          return {
            kind: 'needs_model' as const,
            reason: 'a value the reply wrote is not in the ask or the results: amount',
          }
        }
        return undefined
      },
    }
    // Every other job's playbook is the planner's, so the small replies split by source (2026-10-29).
    let jobs = 0
    const sourced = { ...scripted, source: () => (jobs++ % 2 === 1 ? ('plan' as const) : ('template' as const)) }
    const data = readRun(await playbookOut(5, { door: sourced, reply: true }))
    const table = jobTableOf([readRun(await plainOut(5)), data])
    expect(table).toContain('the final reply on the playbook arm, per day')
    expect(table).toContain(
      '| Written small: template | Written small: planner or cold | Written large after needs_model | Held back by the small model |',
    )
    // The reply section's rows alone: the measures section after it has rows of the same shape.
    const replyRows = (t: string): string[] =>
      t
        .slice(t.indexOf('the final reply on the playbook arm'), t.indexOf("the rerun's measures on the playbook arm"))
        .split('\n')
        .filter((line) => /^\| [12] \| \d/.test(line))
    const rows = replyRows(table)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const [, day, template, planner, large, held, refused] = row.split('|').map((cell) => cell.trim())
      const expected = need(counts.get(Number(day)), 'that day')
      expect([day, Number(template) + Number(planner) + Number(large), Number(held), refused]).toEqual([
        day,
        20,
        expected.held,
        expected.refused === 0 ? '-' : `amount ${String(expected.refused)}`,
      ])
      expect(Number(planner)).toBeGreaterThan(0)
      expect(Number(template)).toBeGreaterThan(0)
    }
    // A refusal for an act the words claimed counts under its stem.
    const claiming = {
      ...sourced,
      reply: () => ({ kind: 'needs_model' as const, reason: 'the reply names an act no step made: refund' }),
    }
    const claimed = jobTableOf([
      readRun(await plainOut(5)),
      readRun(await playbookOut(5, { door: claiming, reply: true })),
    ])
    expect(replyRows(claimed).every((row) => /\| act refund \d+ \|/.test(row))).toBe(true)
    expect(claimed).toContain('talk-order-total passes when the total is anywhere in the reply')
    expect(table).toMatch(/\| \$\d+\.\d{4} \| \$\d+\.\d{4} \| -?\d+\.\d% \|/)
  })

  it("counts, per day, the steps a job the small model closed skipped, the replies the claim check refused, the wrong calls by cause and the door's round trip (2026-10-30)", async () => {
    // Day 2: refund-full's playbook drops its refund, the act, and the small model closes the job, so the task fails
    // with a step skipped. address-update's last act is the decoy: a wrong value, closed small. Day 1 is whole.
    const skipped = 'support-ops.d2.refund-full'
    const decoyed = 'support-ops.d2.address-update'
    const data = readRun(
      await playbookOut(5, {
        door: {
          plan: (inst) => (inst.id === skipped ? plannedOf(domain, inst).slice(0, -1) : undefined),
          wrong: new Set([decoyed]),
        },
        reply: true,
      }),
    )
    const table = jobTableOf([readRun(await plainOut(5)), data])
    const heading = "the rerun's measures on the playbook arm, per day"
    expect(table).toContain(heading)
    // The measures section's rows alone: the step-time section after it has rows that start the same way.
    const section = table.slice(table.indexOf(heading), table.indexOf('time per tool step'))
    expect(section).toContain(
      '| Day | Skipped steps | Replies refused by the claim check | Wrong calls by cause | Fill round trip ms, median (p90) | Report ms, median |',
    )
    const rows = section.split('\n').filter((line) => /^\| [12] \| /.test(line))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^\| 1 \| 0 \| 0 \| - \| \d+ \(\d+\) \| \d+ \|$/)
    expect(rows[1]).toMatch(
      /^\| 2 \| 1 \| 0 \| skipped step, closed small 1, wrong value or reply, closed small 1 \| \d+ \(\d+\) \| \d+ \|$/,
    )
    expect(section).toContain('- Day 2, refund-full: skipped refund_order, closed small')
    expect(section).toContain('- Day 2, address-update: wrong value or reply, closed small')
    expect(section).not.toContain('- Day 1,')
    // A reply the claim check refused is counted in its own column, and the large model's close is said so.
    const claiming = {
      wrong: new Set([decoyed]),
      reply: (inst: Instance) =>
        inst.id === decoyed
          ? { kind: 'needs_model' as const, reason: 'the reply names an act no step made: refund' }
          : undefined,
    }
    const refused = jobTableOf([
      readRun(await plainOut(5)),
      readRun(await playbookOut(5, { door: claiming, reply: true })),
    ])
    const refusedRows = refused
      .slice(refused.indexOf(heading))
      .split('\n')
      .filter((line) => /^\| [12] \| /.test(line))
    expect(refusedRows[1]).toMatch(/^\| 2 \| 0 \| 1 \| wrong value or reply, closed large 1 \| /)
  })

  it("writes the call a tool refused and the tool's words on its step line, and names them under the wrong call (2026-10-30)", async () => {
    const refused = 'support-ops.d2.refund-full'
    const dir = await playbookOut(5, {
      door: {
        plan: (inst) =>
          inst.id === refused
            ? [{ tool: 'get_order', args: { order_id: 'O-NONE' }, marks: { order_id: 'ask' } }]
            : undefined,
      },
    })
    const data = readRun(dir)
    const line = need(
      data.steps.find((s) => s.instance === refused && s.kind === 'tool'),
      'the refused step',
    )
    expect(line).toMatchObject({
      tool: 'get_order',
      tool_failures: 1,
      refused: { call: { order_id: 'O-NONE' }, error: expect.stringContaining('O-NONE') as string },
    })
    expect(data.steps.filter((s) => s.kind === 'tool' && s.instance !== refused).every((s) => !('refused' in s))).toBe(
      true,
    )
    const table = jobTableOf([readRun(await plainOut(5)), data])
    expect(table).toMatch(
      /- Day 2, refund-full: a fill the tool refused, filled by ask: get_order \{"order_id":"O-NONE"\}, [^\n]*O-NONE/,
    )
  })

  it('refuses a playbook run whose reply call reported no usage as the large model, and reads its door and tool lines as costed', async () => {
    const dir = await playbookOut(5)
    expect(() => readRun(dir)).not.toThrow()
    const steps = readFileSync(join(dir, 'steps.jsonl'), 'utf8').trim().split('\n')
    const reply = steps.findIndex((l) => (JSON.parse(l) as StepLine).kind === 'talk')
    const unreported = { ...(JSON.parse(need(steps[reply], 'a reply line')) as StepLine), usage_reported: false }
    steps[reply] = JSON.stringify(unreported)
    writeFileSync(join(dir, 'steps.jsonl'), `${steps.join('\n')}\n`)
    expect(() => readRun(dir)).toThrow(/1 steps answered as the large model or by neither model reported no usage/)
  })

  it('refuses a playbook run with a fill the large model made, or nobody named, that named no priced spend', async () => {
    type DoorOver = Partial<Omit<DoorOptions, 'domain' | 'seed' | 'days' | 'words'>>
    const silent = (over: DoorOver): DoorOver => ({ mark: () => 'door', spent: () => ({}), ...over })
    const unpriced = [{ model: 'no-such-model', tokens_in: 1000, tokens_out: 0, purpose: 'fill' }]
    const refused: [string, DoorOver][] = [
      ['the large model, no spend', silent({})],
      ['nobody named, no spend', silent({ filler: () => null })],
      ['the large model, a spend at a model with no price', silent({ spent: () => ({ body: unpriced }) })],
      [
        'the large model, no spend, a step for another tool',
        silent({ fillAs: (_, __, s) => ({ ...s, tool: 'close_ticket' }) }),
      ],
    ]
    for (const [what, door] of refused) {
      const dir = await playbookOut(5, { door })
      expect(() => readRun(dir), what).toThrow(
        /steps answered as the large model or by neither model reported no usage, so their cost is unknown$/,
      )
    }
    const small = readRun(await playbookOut(5, { door: silent({ filler: () => 'small' }) }))
    const [, scored] = scoreRuns([readRun(await plainOut(5)), small])
    const smallFills = small.steps.filter((s) => s.kind === 'door' && s.served_by === 'small').length
    expect(smallFills).toBeGreaterThan(0)
    expect(scored?.notes).toContain(` ${smallFills} steps reported no usage and are counted at $0.`)
    const asked = await playbookOut(5, { door: silent({ kind: () => 'needs_model' }) })
    expect(() => readRun(asked)).not.toThrow()
    const named = readRun(await playbookOut(5, { door: { mark: () => 'door' } }))
    const fills = named.steps.filter((s) => s.kind === 'door' && s.route === 'playbooks/fill')
    expect(fills.length).toBeGreaterThan(0)
    expect(fills.every((s) => s.served_by === 'large' && s.usage_reported && (s.overhead_usd ?? 0) > 0)).toBe(true)
    const [, priced] = scoreRuns([readRun(await plainOut(5)), named])
    const replies = named.steps.filter((s) => s.day === 1 && s.kind === 'talk').reduce((n, s) => n + s.cost_usd, 0)
    expect(need(priced?.days[0], 'day 1').cost_usd).toBeGreaterThan(replies)
    const nobody = readRun(await playbookOut(5, { door: { mark: () => 'door', filler: () => null } }))
    const [, unnamed] = scoreRuns([readRun(await plainOut(5)), nobody])
    expect(unnamed?.days.map((d) => d.no_model_tool_steps)).toEqual([0, 0])
  })

  it('refuses a playbook run whose task line carries no step line', async () => {
    const dir = await playbookOut(5)
    const tasks = readFileSync(join(dir, 'tasks.jsonl'), 'utf8').trim().split('\n')
    tasks[0] = JSON.stringify(
      without(JSON.parse(need(tasks[0], 'a task line')) as Record<string, unknown>, 'step_line'),
    )
    writeFileSync(join(dir, 'tasks.jsonl'), `${tasks.join('\n')}\n`)
    expect(() => readRun(dir)).toThrow(/: every task of the playbook arm carries its step line$/)
  })
})
