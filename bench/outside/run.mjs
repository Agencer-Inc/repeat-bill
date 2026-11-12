// node bench/outside/run.mjs --arms A,B,C,F --domains support-ops,files-ops --days 4 --seed 8 --out runs/outside
//
// The outside test's run: the bench's own jobs (the same seeds and days as its control runs), each in a fresh
// sandbox, asked of a plain agent once per arm. The arms take turns job by job, so they meet the same hour of every
// provider. Between days it waits --settle seconds (65 by default) when arm B runs, so a day's jobs are learned before
// the next day asks them again. Each job's line goes to <out>/jobs.jsonl as it ends; summary.mjs reads it.
// The bill is the provider's, not this file: the token counts here are what each response reported, a cross-check.
import console from 'node:console'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { domainNamed } from '../tasks/domains.ts'
import { runAgent } from './agent.mjs'
import { ARMS } from './arms.mjs'

const { values } = parseArgs({
  options: {
    arms: { type: 'string', default: 'A,B' },
    domains: { type: 'string', default: 'support-ops,files-ops' },
    days: { type: 'string', default: '4' },
    from: { type: 'string', default: '1' },
    seed: { type: 'string', default: '8' },
    words: { type: 'string', default: 'new' },
    settle: { type: 'string', default: '65' },
    limit: { type: 'string' },
    out: { type: 'string', default: 'runs/outside' },
  },
})
const arms = values.arms.split(',')
for (const arm of arms) {
  if (!(arm in ARMS)) {
    throw new Error(`no arm ${arm}; the arms are ${Object.keys(ARMS).join(', ')}`)
  }
}
const days = Number(values.days)
const from = Number(values.from)
const settle = Number(values.settle)
mkdirSync(values.out, { recursive: true })
const lines = join(values.out, 'jobs.jsonl')
const clients = Object.fromEntries(await Promise.all(arms.map(async (arm) => [arm, await ARMS[arm]()])))

for (let day = from; day <= days; day++) {
  for (const name of values.domains.split(',')) {
    const domain = domainNamed(name)
    let jobs = domain.instances(Number(values.seed), days, values.words).filter((i) => i.day === day)
    if (values.limit) {
      jobs = jobs.slice(0, Number(values.limit))
    }
    for (const inst of jobs) {
      for (const arm of arms) {
        const { client, model, extra } = clients[arm]
        const session = inst.open()
        const started = performance.now()
        let ran
        let error = null
        try {
          ran = await runAgent({
            client,
            model,
            extra,
            system: domain.system,
            ask: inst.ask,
            tools: domain.tools,
            call: (tool, args) => session.call(tool, args),
            maxSteps: domain.maxSteps ?? 25,
          })
        } catch (err) {
          error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'failed'
          ran = { reply: null, steps: 0, capped: false, usage: null }
        }
        const check = ran.reply === null ? { pass: false, reason: error ?? 'no reply' } : session.check(ran.reply)
        const line = {
          arm,
          model,
          day,
          domain: name,
          task: inst.id,
          template: inst.template,
          passed: check.pass && !ran.capped,
          reason: check.reason,
          steps: ran.steps,
          capped: ran.capped,
          seconds: Math.round(performance.now() - started) / 1000,
          usage: ran.usage,
          error,
          at: new Date().toISOString(),
        }
        appendFileSync(lines, `${JSON.stringify(line)}\n`)
        console.log(
          `day ${day} ${name} ${inst.template} ${arm}: ${line.passed ? 'pass' : `FAIL ${line.reason.slice(0, 80)}`}`,
        )
      }
    }
  }
  if (arms.includes('B') && day < days && settle > 0) {
    console.log(`day ${day} done; waiting ${settle} s for its jobs to be learned`)
    await setTimeout(settle * 1000)
  }
}
