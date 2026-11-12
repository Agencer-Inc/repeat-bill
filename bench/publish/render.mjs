// node bench/publish/render.mjs --in bench/results --out bench/results/index.html
//
// Reads every results.json under --in, checks each against schema.json and the rules of a
// valid run it can check (bench/METHOD.md lists them), pairs the two arms of each run and
// writes one static page.
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// A file that breaks the contract. The render stops and names it.
export class Refusal extends Error {}

const compare = (a, b) => {
  if (a < b) {
    return -1
  }
  return a > b ? 1 : 0
}

// ---------- the schema ----------

const CHECKS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'minItems',
  'pattern',
]
const NOTES = ['$schema', '$id', 'title', 'description']

const refuseUnknown = (schema, at) => {
  for (const key of Object.keys(schema)) {
    if (!CHECKS.includes(key) && !NOTES.includes(key)) {
      throw new Error(`${at}: schema keyword not supported: ${key}`)
    }
  }
}

// Walks the whole schema, so a keyword this validator does not check stops the render
// instead of letting every file through unchecked.
export const assertKnownKeywords = (schema, at = 'schema') => {
  refuseUnknown(schema, at)
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    assertKnownKeywords(sub, `${at}.properties.${name}`)
  }
  if (schema.items !== undefined) {
    assertKnownKeywords(schema.items, `${at}.items`)
  }
  if (typeof schema.additionalProperties === 'object') {
    assertKnownKeywords(schema.additionalProperties, `${at}.additionalProperties`)
  }
}

export const SCHEMA = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.json'), 'utf8'))
assertKnownKeywords(SCHEMA)

const typeOf = (value) => {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'array' : typeof value
}

const isType = (value, type) => (type === 'integer' ? Number.isInteger(value) : typeOf(value) === type)

const field = (path, key) => (path ? `${path}.${key}` : key)

const validateObject = (schema, value, path) => {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      return { path: field(path, key), why: 'missing' }
    }
  }
  const named = schema.properties ?? {}
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(named, key)) {
      continue
    }
    if (schema.additionalProperties === false) {
      return { path: field(path, key), why: 'not allowed' }
    }
    if (typeof schema.additionalProperties === 'object') {
      const failure = validate(schema.additionalProperties, value[key], field(path, key))
      if (failure) {
        return failure
      }
    }
  }
  for (const [key, sub] of Object.entries(named)) {
    if (Object.hasOwn(value, key)) {
      const failure = validate(sub, value[key], field(path, key))
      if (failure) {
        return failure
      }
    }
  }
  return null
}

// The first failure as { path, why }, or null. An object reports a missing field first,
// then a field the schema does not name, then each named field in schema order.
export const validate = (schema, value, path = '') => {
  refuseUnknown(schema, path || 'schema')
  if (schema.type !== undefined) {
    const types = [schema.type].flat()
    if (!types.some((type) => isType(value, type))) {
      return { path, why: `must be ${types.join(' or ')}, got ${typeOf(value)}` }
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return { path, why: `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}` }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    return { path, why: `must be at least ${schema.minimum}` }
  }
  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    return { path, why: `must match ${schema.pattern}` }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return { path, why: `must hold at least ${schema.minItems}` }
    }
    for (const [index, item] of value.entries()) {
      const failure = schema.items === undefined ? null : validate(schema.items, item, `${path}[${index}]`)
      if (failure) {
        return failure
      }
    }
  }
  return typeOf(value) === 'object' ? validateObject(schema, value, path) : null
}

// ---------- the rules of a valid run ----------

// A writer may round cost_per_solved_usd to six decimal places.
const SLACK_USD = 0.000001

// What the schema cannot say: the arm's models, day numbers, and the day's own sums.
export const checkRules = (result) => {
  if (result.arm === 'plain' && result.small_model !== null) {
    return { path: 'small_model', why: 'must be null on the plain arm' }
  }
  if (result.arm !== 'plain' && result.small_model === null) {
    return { path: 'small_model', why: `must name the small model on the ${result.arm} arm` }
  }
  if (result.arm !== 'playbook' && Object.hasOwn(result, 'step_lines')) {
    return { path: 'step_lines', why: 'only the playbook arm carries step lines' }
  }
  const numbers = result.days.map((day) => day.day)
  const sorted = [...numbers].sort((a, b) => a - b)
  if (sorted.some((number, index) => number !== index + 1)) {
    return { path: 'days', why: `day numbers must run 1 to ${numbers.length}, once each (got ${numbers.join(', ')})` }
  }
  for (const [index, day] of result.days.entries()) {
    const at = (key) => `days[${index}].${key}`
    if (day.passed > day.tasks) {
      return { path: at('passed'), why: `must be at most tasks (${day.tasks})` }
    }
    if (result.arm === 'plain' && day.small_model_tool_steps !== 0) {
      return { path: at('small_model_tool_steps'), why: 'must be 0 on the plain arm' }
    }
    if (day.small_model_tool_steps > day.tool_steps) {
      return { path: at('small_model_tool_steps'), why: `must be at most tool_steps (${day.tool_steps})` }
    }
    if (result.arm !== 'playbook' && Object.hasOwn(day, 'no_model_tool_steps')) {
      return { path: at('no_model_tool_steps'), why: 'only the playbook arm counts tool steps filled with no model' }
    }
    if (day.small_model_tool_steps + (day.no_model_tool_steps ?? 0) > day.tool_steps) {
      const left = day.tool_steps - day.small_model_tool_steps
      return {
        path: at('no_model_tool_steps'),
        why: `must be at most tool_steps less small_model_tool_steps (${left})`,
      }
    }
    if (day.passed === 0 && day.cost_per_solved_usd !== null) {
      return { path: at('cost_per_solved_usd'), why: 'must be null when passed is 0' }
    }
    const expected = day.cost_usd / day.passed
    const cost = day.cost_per_solved_usd
    if (day.passed > 0 && (cost === null || !(Math.abs(cost - expected) <= SLACK_USD))) {
      return { path: at('cost_per_solved_usd'), why: `must be cost_usd / passed (${expected})` }
    }
  }
  return null
}

const parse = (text) => {
  try {
    return { result: JSON.parse(text) }
  } catch {
    return null
  }
}

export const readResult = (file, text) => {
  const parsed = parse(text)
  if (!parsed) {
    throw new Refusal(`${file}: not JSON`)
  }
  const failure = validate(SCHEMA, parsed.result) ?? checkRules(parsed.result)
  if (failure) {
    throw new Refusal(`${file}: ${failure.path || '(top level)'}: ${failure.why}`)
  }
  return parsed.result
}

// ---------- pairing ----------

const SHARED = ['large_model', 'domain', 'harness_commit']

// How far apart a run's arms may start.
const ONE_DAY_MS = 24 * 60 * 60 * 1000

// The sentence the scorer (bench/score/score.ts) puts first in both arms' notes of a run asked
// with --words same; results.json has no field for the setting.
const SAME_WORDS_NOTE =
  'This run asked each job in the same words every day, its day-1 phrasing, with new data each day (--words same).'

const wordsOf = (result) => (result.notes.startsWith(SAME_WORDS_NOTE) ? 'same' : 'new')

const tasksOn = (result, number) => result.days.find((day) => day.day === number).tasks

// Both arms of a run share run_id and domain: one run may hold several domains, as the scorer pairs
// them. The plain arm has no small model, so a run's small model is the reactor arm's.
export const pairRuns = (entries) => {
  const byRun = new Map()
  for (const entry of entries) {
    const key = JSON.stringify([entry.result.run_id, entry.result.domain])
    byRun.set(key, [...(byRun.get(key) ?? []), entry])
  }
  return [...byRun.keys()].sort(compare).map((key) => {
    const arms = byRun.get(key)
    const [id, domain] = JSON.parse(key)
    // Named by run_id alone where it is the page's own label; by its domain too in a refusal, which must say which.
    const runId = id
    const named = `${id} (${String(domain)})`
    const plains = arms.filter((entry) => entry.result.arm === 'plain')
    const reactors = arms.filter((entry) => entry.result.arm === 'reactor')
    const playbooks = arms.filter((entry) => entry.result.arm === 'playbook')
    const files = arms.map((entry) => entry.file).join(', ')
    // A run with no playbook arm is held to the two arms it always was, in the same words.
    if (playbooks.length === 0 && (plains.length !== 1 || reactors.length !== 1)) {
      throw new Refusal(
        `run ${named}: needs one plain arm and one reactor arm, found ${plains.length} plain and ${reactors.length} reactor (${files})`,
      )
    }
    if (playbooks.length > 0 && (plains.length !== 1 || reactors.length > 1 || playbooks.length > 1)) {
      throw new Refusal(
        `run ${named}: needs one plain arm and one reactor arm, one playbook arm or both, found ${plains.length} plain, ${reactors.length} reactor and ${playbooks.length} playbook (${files})`,
      )
    }
    const plain = plains[0].result
    const reactor = reactors[0]?.result ?? null
    const playbook = playbooks[0]?.result ?? null
    const differ = (what, a, b, other = 'reactor') =>
      new Refusal(
        `run ${named}: the arms differ on ${what} (plain ${JSON.stringify(a)}, ${other} ${JSON.stringify(b)})`,
      )
    for (const other of [reactor, playbook].filter((result) => result !== null)) {
      for (const key of SHARED) {
        if (plain[key] !== other[key]) {
          throw differ(key, plain[key], other[key], other.arm)
        }
      }
      if (plain.days.length !== other.days.length) {
        throw differ('days', plain.days.length, other.days.length, other.arm)
      }
      for (let number = 1; number <= plain.days.length; number += 1) {
        if (tasksOn(plain, number) !== tasksOn(other, number)) {
          throw differ(`tasks on day ${number}`, tasksOn(plain, number), tasksOn(other, number), other.arm)
        }
      }
      if (wordsOf(plain) !== wordsOf(other)) {
        throw differ('words', wordsOf(plain), wordsOf(other), other.arm)
      }
      // A run's arms run together: an arm copied in from another run started on another day (2026-11-12).
      if (Math.abs(Date.parse(plain.started_at) - Date.parse(other.started_at)) > ONE_DAY_MS) {
        throw new Refusal(
          `run ${named}: the arms started more than 24 hours apart (plain ${plain.started_at}, ${other.arm} ${other.started_at})`,
        )
      }
    }
    if (reactor !== null && playbook !== null && reactor.small_model !== playbook.small_model) {
      throw new Refusal(
        `run ${named}: the arms differ on small_model (reactor ${JSON.stringify(reactor.small_model)}, playbook ${JSON.stringify(playbook.small_model)})`,
      )
    }
    return {
      runId,
      plain,
      reactor,
      playbook,
      words: wordsOf(plain),
      domain: plain.domain,
      largeModel: plain.large_model,
      smallModel: (reactor ?? playbook).small_model,
      harnessCommit: plain.harness_commit,
    }
  })
}

// ---------- the numbers ----------

// 1 - reactor / plain on cost per solved task. null when either side has no number, or
// plain's is 0 or so near it the ratio overflows, so the page reads n/a, never Infinity.
export const saving = (reactorCost, plainCost) => {
  if (reactorCost === null || plainCost === null || plainCost === 0) {
    return null
  }
  const value = 1 - reactorCost / plainCost
  return Number.isFinite(value) ? value : null
}

const fixed = (number, digits) => {
  const text = number.toFixed(digits)
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text
}

const share = (part, whole) => (whole === 0 ? 'n/a' : `${fixed((part / whole) * 100, 0)}%`)
const usd = (amount) => (amount === null ? 'n/a' : `$${fixed(amount, amount >= 1 ? 2 : 4)}`)
const savingText = (value) => (value === null ? 'n/a' : `${fixed(value * 100, 1)}%`)
const countText = (value) => (value === null ? 'n/a' : String(value))

// ---------- the page ----------

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// Every string a submitter wrote goes through this before it reaches the page.
export const esc = (text) => String(text).replace(/[&<>"']/g, (char) => ENTITIES[char])

const ARMS = ['plain', 'reactor', 'playbook']

// The arms a run has, in page order: plain, then reactor and playbook where it has them.
const armsOf = (run) => ARMS.filter((name) => run[name] !== null && run[name] !== undefined)

const dayPairs = (run) =>
  [...run.plain.days]
    .sort((a, b) => a.day - b.day)
    .map((plain) => ({
      number: plain.day,
      plain,
      reactor: run.reactor?.days.find((day) => day.day === plain.day),
      playbook: run.playbook?.days.find((day) => day.day === plain.day),
    }))

const HEAD = [
  'Day',
  'Arm',
  'Pass rate',
  'Tool steps',
  'Tool steps not answered by the large model',
  '$ per solved task',
  "Saving before Reactor's share-of-savings charge",
  'Wrong tool calls',
]

const rowFor = (number, arm, day, savingCell) => {
  const cells = [
    `<td>${number}</td>`,
    `<td><span class="key ${arm}"></span>${arm}</td>`,
    `<td>${share(day.passed, day.tasks)} (${day.passed}/${day.tasks})</td>`,
    `<td>${day.tool_steps}</td>`,
    // On the playbook arm a step filled with no model is not answered by the large model either.
    `<td>${share(day.small_model_tool_steps + (day.no_model_tool_steps ?? 0), day.tool_steps)}</td>`,
    `<td>${usd(day.cost_per_solved_usd)}</td>`,
    `<td data-col="saving">${savingCell}</td>`,
    `<td>${countText(day.wrong_tool_calls)}</td>`,
  ]
  const first = arm === 'plain' ? ' class="first"' : ''
  return `<tr${first} data-day="${number}" data-arm="${arm}">${cells.join('')}</tr>`
}

const tableFor = (run) => {
  const rows = dayPairs(run).flatMap((pair) =>
    armsOf(run).map((name) =>
      rowFor(
        pair.number,
        name,
        pair[name],
        name === 'plain' || pair.number === 1
          ? ''
          : savingText(saving(pair[name].cost_per_solved_usd, pair.plain.cost_per_solved_usd)),
      ),
    ),
  )
  const head = HEAD.map((label) => `<th scope="col">${label}</th>`).join('')
  return `<div class="scroll"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table></div>`
}

const BOX = { width: 400, height: 240, left: 56, right: 72, top: 16, bottom: 36 }
const PLOT = { width: BOX.width - BOX.left - BOX.right, height: BOX.height - BOX.top - BOX.bottom }

const round = (number) => Math.round(number * 10) / 10

// A clean y-axis: 1, 2, 2.5 or 5 times a power of ten, about four steps to the top.
const axisFor = (values) => {
  const max = Math.max(0, ...values)
  if (max === 0) {
    return { step: 0.25, top: 1, digits: 2 }
  }
  const rough = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= rough) * magnitude
  const top = Math.ceil(max / step - 1e-9) * step
  const digits = [0, 1, 2, 3, 4, 5, 6].find((d) => Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) ?? 6
  return { step, top, digits: Math.max(digits, 2) }
}

const chartFor = (run, index) => {
  const pairs = dayPairs(run)
  const series = armsOf(run).map((arm) => ({ arm, costs: pairs.map((pair) => pair[arm].cost_per_solved_usd) }))
  const axis = axisFor(series.flatMap((line) => line.costs.filter((cost) => cost !== null)))
  const x = (at) =>
    round(pairs.length === 1 ? BOX.left + PLOT.width / 2 : BOX.left + (at * PLOT.width) / (pairs.length - 1))
  const y = (cost) => round(BOX.top + PLOT.height - (cost / axis.top) * PLOT.height)
  const ticks = Array.from({ length: Math.round(axis.top / axis.step) + 1 }, (_, k) => k * axis.step)

  const grid = ticks.map((tick) => {
    const at = y(tick)
    const kind = tick === 0 ? 'base' : 'grid'
    return `<line class="${kind}" x1="${BOX.left}" x2="${BOX.left + PLOT.width}" y1="${at}" y2="${at}"/><text class="tick" x="${BOX.left - 8}" y="${round(at + 4)}" text-anchor="end">$${tick.toFixed(axis.digits)}</text>`
  })
  const days = pairs.map(
    (pair, at) =>
      `<text class="tick" x="${x(at)}" y="${BOX.top + PLOT.height + 22}" text-anchor="middle">Day ${pair.number}</text>`,
  )

  const lines = series.map(({ arm, costs }) => {
    const points = costs.map((cost, at) =>
      cost === null ? null : { x: x(at), y: y(cost), cost, day: pairs[at].number },
    )
    const d = points
      .map((point, at) => {
        if (point === null) {
          return ''
        }
        return `${at === 0 || points[at - 1] === null ? 'M' : 'L'}${point.x} ${point.y}`
      })
      .filter(Boolean)
      .join(' ')
    const path = d ? `<path class="line ${arm}" d="${d}"/>` : ''
    const dots = points
      .filter((point) => point !== null)
      .map(
        (point) =>
          `<g class="pt"><title>${arm}, day ${point.day}: ${usd(point.cost)} per solved task</title><circle class="hit" cx="${point.x}" cy="${point.y}" r="12"/><circle class="dot ${arm}" cx="${point.x}" cy="${point.y}" r="4"/></g>`,
      )
    return { arm, path, dots, last: points.filter((point) => point !== null).at(-1) }
  })

  // End labels name each line where it stops, unless the two ends are too close to tell
  // apart; the legend above the chart names them either way.
  const ends = lines.filter((line) => line.last)
  const apart = ends.every((a, i) => ends.every((b, j) => i === j || Math.abs(a.last.y - b.last.y) >= 14))
  const labels = apart
    ? ends.map(
        (line) => `<text class="end" x="${round(line.last.x + 10)}" y="${round(line.last.y + 4)}">${line.arm}</text>`,
      )
    : []

  const describe = series
    .map(({ arm, costs }) => `${arm}: ${costs.map((cost, at) => `day ${pairs[at].number} ${usd(cost)}`).join(', ')}`)
    .join('; ')
  const id = `chart-${index}`
  return [
    `<svg class="chart" viewBox="0 0 ${BOX.width} ${BOX.height}" role="img" aria-labelledby="${id}-title ${id}-desc">`,
    `<title id="${id}-title">$ per solved task by day, plain against ${armsOf(run).slice(1).join(' and ')}</title>`,
    `<desc id="${id}-desc">${describe}</desc>`,
    ...grid,
    ...days,
    ...lines.map((line) => line.path),
    ...lines.flatMap((line) => line.dots),
    ...labels,
    '</svg>',
  ]
    .filter(Boolean)
    .join('\n')
}

const LEGEND_LINES = {
  plain: '<li><span class="key plain"></span>plain: the large model, called directly</li>',
  reactor: '<li><span class="key reactor"></span>reactor: the Reactor API, with the large model and a small model</li>',
  playbook:
    '<li><span class="key playbook"></span>playbook: the Reactor API\'s playbook door, each job run by the harness\'s bare client</li>',
}

const legendFor = (run) => ['<ul class="legend">', ...armsOf(run).map((arm) => LEGEND_LINES[arm]), '</ul>'].join('\n')

const notesFor = (run) =>
  armsOf(run)
    .filter((arm) => run[arm].notes.trim() !== '')
    .map((arm) => `<p class="fine"><strong>Notes, ${arm} arm.</strong> ${esc(run[arm].notes)}</p>`)
    .join('\n')

// Each task's step line on the playbook arm, closed by default: a run has one per task.
const stepLinesFor = (run) =>
  run.playbook?.step_lines?.length > 0
    ? [
        '<details class="fine">',
        '<summary>Who filled each step on the playbook arm</summary>',
        '<ol>',
        ...run.playbook.step_lines.map((s) => `<li>Day ${s.day}, <code>${esc(s.job)}</code>: ${esc(s.line)}</li>`),
        '</ol>',
        '</details>',
      ].join('\n')
    : ''

// Above the chart and the table, so a reader knows how the run was asked before reading its numbers.
const WORDS = {
  same: 'same words: every day asks each job in its day-1 words, with new data',
  new: 'new words: each day asks every job in words it was not asked in before, with new data',
}

const runFor = (run, index) =>
  [
    '<article class="run">',
    `<h3>Run <code>${esc(run.runId)}</code></h3>`,
    `<p class="fine">Harness commit <code>${esc(run.harnessCommit)}</code></p>`,
    `<p class="fine" data-words="${run.words}">${WORDS[run.words]}</p>`,
    '<figure>',
    legendFor(run),
    chartFor(run, index),
    '<figcaption class="fine">$ per solved task by day. Lower is cheaper. Every number is in the table below.</figcaption>',
    '</figure>',
    tableFor(run),
    notesFor(run),
    stepLinesFor(run),
    '</article>',
  ]
    .filter(Boolean)
    .join('\n')

const compareRuns = (a, b) =>
  compare(a.domain, b.domain) ||
  compare(a.largeModel, b.largeModel) ||
  compare(a.smallModel, b.smallModel) ||
  compare(a.runId, b.runId)

const sameGroup = (a, b) => a.domain === b.domain && a.largeModel === b.largeModel && a.smallModel === b.smallModel

// One section per domain and pair of models, in sorted order; runs arrive sorted.
const groupsOf = (sorted) => {
  const groups = []
  for (const run of sorted) {
    const last = groups.at(-1)
    if (last && sameGroup(last[0], run)) {
      last.push(run)
    } else {
      groups.push([run])
    }
  }
  return groups
}

const STYLE = `
:root{color-scheme:light dark;
--bg:#fff;--ink:#1d1d1f;--ink-2:#6e6e73;--line:#d2d2d7;--grid:#e8e8ed;
--plain:#5b46e0;--reactor:#1fa971;
--text:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme: dark){:root{
--bg:#000;--ink:#f5f5f7;--ink-2:#a1a1a6;--line:#3a3a3d;--grid:#232326;
--plain:#8270f0;--reactor:#1aa86b}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.47 var(--text);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%}
main{max-width:960px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:clamp(28px,7vw,40px);line-height:1.1;font-weight:600;letter-spacing:-.01em;margin:0}
h2{font-size:24px;line-height:1.2;font-weight:600;margin:48px 0 4px}
h3{font-size:18px;line-height:1.3;font-weight:600;margin:28px 0 2px}
p{margin:8px 0 0;max-width:720px}
.lead{font-size:18px;line-height:1.42;color:var(--ink-2);margin-top:12px}
.fine{font-size:14px;line-height:1.43;color:var(--ink-2)}
.fine strong{color:var(--ink);font-weight:600}
code{font-family:var(--mono);font-size:.88em;overflow-wrap:anywhere}
figure{margin:16px 0 0}
figcaption{margin-top:4px}
.legend{display:flex;flex-wrap:wrap;gap:4px 20px;list-style:none;margin:0 0 8px;padding:0;font-size:14px;color:var(--ink-2)}
.key{display:inline-block;width:16px;height:3px;border-radius:2px;vertical-align:middle;margin-right:8px}
.key.plain{background:var(--plain)}
.key.reactor{background:var(--reactor)}
.chart{display:block;width:100%;max-width:480px;height:auto;overflow:visible}
.chart text{font-family:var(--text);font-size:13px;fill:var(--ink-2)}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .base{stroke:var(--line);stroke-width:1}
.chart .line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.chart .line.plain{stroke:var(--plain)}
.chart .line.reactor{stroke:var(--reactor)}
.chart .hit{fill:transparent}
.chart .dot{stroke:var(--bg);stroke-width:2}
.chart .dot.plain{fill:var(--plain)}
.chart .dot.reactor{fill:var(--reactor)}
.chart .tick{font-variant-numeric:tabular-nums}
.chart .end{fill:var(--ink)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:20px}
table{border-collapse:collapse;width:100%;min-width:620px;font-size:14px;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;text-align:right;border-bottom:1px solid var(--grid)}
td{white-space:nowrap}
th{font-weight:600;color:var(--ink-2);vertical-align:bottom;line-height:1.3}
th:nth-child(-n+2),td:nth-child(-n+2){text-align:left}
tr.first td{border-top:1px solid var(--line)}
.empty{margin-top:40px;font-size:18px}
`

// Only a page with a playbook arm carries these, so a page of two arms reads byte for byte as before.
const PLAYBOOK_STYLE = `
:root{--playbook:#c26a12}
@media (prefers-color-scheme: dark){:root{--playbook:#e8913a}}
.key.playbook{background:var(--playbook)}
.chart .line.playbook{stroke:var(--playbook)}
.chart .dot.playbook{fill:var(--playbook)}
`

const PLAYBOOK_HEADER =
  "<p class=\"fine\">The playbook arm runs each job through the Reactor API's playbook door, with the harness's bare client playing the customer's own library: it fills what the playbook marks local from the ask and earlier results, and asks the door for every other step. Its saving is read against plain the same way, and its cost is a floor too: it counts what the door's answers name as spent.</p>"

const HEADER_LINES = [
  '<header>',
  '<h1>Repeat-bill benchmark</h1>',
  '<p class="lead">What an agent pays for repeated tool work, asked again with new data: through the Reactor API, against the same large model called directly, and whether the pass rate holds.</p>',
  "<p class=\"fine\">A day is a round of tasks, not a calendar day, and the rounds run back to back in one sitting. Day 1 is cold when the reactor arm runs on a Reactor account that has never run this benchmark; its notes say what the harness's key ledger saw of its key. Each later day asks the same kinds of jobs again with new data: in new words, or, where a run says same words, in that job's day-1 words. Saving before Reactor's share-of-savings charge is 1 - reactor / plain on $ per solved task, from day 2 on: Reactor's own charge is not taken out of it. n/a means there is no number to show: nothing passed that day, it was not measured, or, for the plain arm's wrong tool calls, there is nothing to count.</p>",
  '<p class="fine">Not all of the small model\'s spend is visible in a response, so the reactor arm\'s cost is a floor and its saving is a ceiling.</p>',
  '<p class="fine">The method and the rules of a valid run: <code>bench/METHOD.md</code>. How to submit a result: <code>bench/SUBMIT.md</code>.</p>',
]

const headerFor = (withPlaybook) =>
  [...HEADER_LINES, ...(withPlaybook ? [PLAYBOOK_HEADER] : []), '</header>'].join('\n')

const sectionFor = (group, sorted) =>
  [
    '<section class="group">',
    `<h2>${esc(group[0].domain)}</h2>`,
    `<p class="fine">Large model <code>${esc(group[0].largeModel)}</code>, small model <code>${esc(group[0].smallModel)}</code></p>`,
    ...group.map((run) => runFor(run, sorted.indexOf(run) + 1)),
    '</section>',
  ].join('\n')

const EMPTY =
  '<p class="empty">No results yet. A result appears here once both arms of a run are published under <code>bench/results</code>.</p>'

export const renderPage = (runs) => {
  const sorted = [...runs].sort(compareRuns)
  const withPlaybook = sorted.some((run) => run.playbook !== null && run.playbook !== undefined)
  const body =
    sorted.length === 0
      ? EMPTY
      : groupsOf(sorted)
          .map((group) => sectionFor(group, sorted))
          .join('\n')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<title>Repeat-bill benchmark results</title>',
    `<style>${STYLE}${withPlaybook ? PLAYBOOK_STYLE : ''}</style>`,
    '</head>',
    '<body>',
    '<main>',
    headerFor(withPlaybook),
    body,
    '<footer><p class="fine">Rendered by <code>bench/publish/render.mjs</code> from every results.json under <code>bench/results</code>. bench/ is under the Apache License 2.0.</p></footer>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

// ---------- the command ----------

const USAGE = 'usage: node bench/publish/render.mjs --in <results folder> --out <page.html>\n'

const readArgs = (argv) => {
  try {
    const { values } = parseArgs({ args: argv, options: { in: { type: 'string' }, out: { type: 'string' } } })
    return values.in && values.out ? values : null
  } catch {
    return null
  }
}

const KEPT = ['results.json', 'prices.json']

// Any other .json, in any case, is a result named wrong: refused, never skipped.
const stray = (name) => /\.json$/i.test(name) && !KEPT.includes(name)

// A link is refused rather than followed or skipped, so nothing under --in goes unchecked.
const resultFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => compare(a.name, b.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Refusal(`${path}: a link; results are read from files only`)
      }
      if (entry.isDirectory()) {
        return resultFiles(path)
      }
      if (entry.isFile() && stray(entry.name)) {
        throw new Refusal(`${path}: not a results.json; each arm's file is named results.json`)
      }
      return entry.isFile() && entry.name === 'results.json' ? [path] : []
    })

export const main = (argv) => {
  const args = readArgs(argv)
  if (!args) {
    process.stderr.write(USAGE)
    return 2
  }
  try {
    if (!statSync(args.in, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Refusal(`${args.in}: not a folder`)
    }
    const entries = resultFiles(args.in).map((file) => ({ file, result: readResult(file, readFileSync(file, 'utf8')) }))
    const runs = pairRuns(entries)
    mkdirSync(dirname(args.out), { recursive: true })
    writeFileSync(args.out, renderPage(runs))
    process.stdout.write(`${args.out}: ${runs.length} run(s) from ${entries.length} file(s)\n`)
    return 0
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
