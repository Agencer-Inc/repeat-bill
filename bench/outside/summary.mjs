// node bench/outside/summary.mjs runs/outside
//
// The outside test's table, per arm and day: jobs, passed, wrong calls (a job the arm failed
// where arm A passed it), the tokens each response reported and the share of the prompt in `cached_tokens`, and the median
// seconds per job. Spend is not here: it is read off each provider project's usage page, which is the result.
import console from 'node:console'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'runs/outside'
const jobs = readFileSync(join(dir, 'jobs.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const passedByA = new Set(jobs.filter((j) => j.arm === 'A' && j.passed).map((j) => j.task))
const arms = [...new Set(jobs.map((j) => j.arm))].sort()
const days = [...new Set(jobs.map((j) => j.day))].sort((a, b) => a - b)

console.log(
  '| Arm | Day | Jobs | Passed | Wrong vs A | Errors | Prompt tokens | cached_tokens | Completion tokens | Unreported responses | p50 s |',
)
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const arm of arms) {
  for (const day of days) {
    const these = jobs.filter((j) => j.arm === arm && j.day === day)
    if (these.length === 0) {
      continue
    }
    const sum = (key) => these.reduce((n, j) => n + (j.usage?.[key] ?? 0), 0)
    const prompt = sum('prompt')
    const wrong = arm === 'A' ? '-' : String(these.filter((j) => !j.passed && passedByA.has(j.task)).length)
    console.log(
      `| ${arm} | ${day} | ${these.length} | ${these.filter((j) => j.passed).length} | ${wrong} | ${
        these.filter((j) => j.error !== null).length
      } | ${prompt} | ${prompt === 0 ? '-' : `${Math.round((sum('cached_tokens') / prompt) * 100)}%`} | ${sum('completion')} | ${sum(
        'unreported',
      )} | ${median(these.map((j) => j.seconds)).toFixed(1)} |`,
    )
  }
}
const failed = jobs.filter((j) => !j.passed)
if (failed.length > 0) {
  console.log('\nFailed jobs:')
  for (const j of failed) {
    console.log(`- ${j.arm} day ${j.day} ${j.domain} ${j.template}: ${j.reason.slice(0, 140)}`)
  }
}
