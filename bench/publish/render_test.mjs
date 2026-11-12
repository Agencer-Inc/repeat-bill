import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { SAME_WORDS_NOTE } from '../score/score.ts'
import { assertKnownKeywords, checkRules, pairRuns, renderPage, saving, validate } from './render.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const renderer = join(here, 'render.mjs')
const fixture = join(here, 'fixtures', 'two-arms')
const schema = JSON.parse(readFileSync(join(here, 'schema.json'), 'utf8'))

const arm = (name) => JSON.parse(readFileSync(join(fixture, name, 'results.json'), 'utf8'))

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repeat-bill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Writes { 'run/plain/results.json': object | text } under dir.
const lay = (dir, files) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
}

const render = (inDir, out) =>
  spawnSync(process.execPath, [renderer, '--in', inDir, '--out', out], { encoding: 'utf8' })

const renderFiles = (t, files) => {
  const dir = scratch(t)
  lay(dir, files)
  const out = join(dir, 'page', 'index.html')
  const run = render(dir, out)
  return { ...run, out, page: existsSync(out) ? readFileSync(out, 'utf8') : null }
}

const pair = (plain, reactor) => ({ 'run/plain/results.json': plain, 'run/reactor/results.json': reactor })

// The cells of one table row, by day and arm, as text.
const cells = (page, day, armName) => {
  const row = page.match(new RegExp(`<tr[^>]*data-day="${day}" data-arm="${armName}"[^>]*>(.*?)</tr>`))
  assert.ok(row, `no row for day ${day}, ${armName}`)
  return [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]+>/g, ''))
}

const savingCell = (page, day) => {
  const row = page.match(new RegExp(`<tr[^>]*data-day="${day}" data-arm="reactor"[^>]*>(.*?)</tr>`))
  assert.ok(row, `no reactor row for day ${day}`)
  const cell = row[1].match(/<td data-col="saving">(.*?)<\/td>/)
  assert.ok(cell, `no saving cell on day ${day}`)
  return cell[1]
}

test('the two-arm fixture renders one table and one chart, plain against reactor', (t) => {
  const dir = scratch(t)
  const out = join(dir, 'index.html')
  const run = render(fixture, out)
  assert.equal(run.status, 0, run.stderr)
  const page = readFileSync(out, 'utf8')
  assert.equal(page.match(/<table/g)?.length, 1)
  assert.equal(page.match(/<svg/g)?.length, 1)
  assert.equal(page.match(/<tr[^>]*data-day=/g)?.length, 8)
  for (const name of ['plain', 'reactor']) {
    const line = page.match(new RegExp(`<path class="line ${name}" d="([^"]*)"`))
    assert.ok(line, `no ${name} line`)
    assert.equal(line[1].match(/[ML]/g).length, 4, `${name} line should join 4 days`)
    assert.equal(page.match(new RegExp(`class="dot ${name}"`, 'g'))?.length, 4)
  }
  assert.match(page, /fixture-orders/)
  assert.match(page, /example-large/)
  assert.match(page, /example-small/)
})

test('the saving on days 2 to 4 is 1 - reactor / plain on cost per solved task', (t) => {
  const plain = arm('plain')
  const reactor = arm('reactor')
  const { status, stderr, page } = renderFiles(t, pair(plain, reactor))
  assert.equal(status, 0, stderr)
  for (const day of [2, 3, 4]) {
    const p = plain.days.find((d) => d.day === day).cost_per_solved_usd
    const r = reactor.days.find((d) => d.day === day).cost_per_solved_usd
    assert.equal(savingCell(page, day), `${((1 - r / p) * 100).toFixed(1)}%`, `day ${day}`)
  }
  assert.equal(savingCell(page, 2), '50.0%')
  assert.equal(savingCell(page, 1), '', 'day 1 is cold and shows no saving')
  assert.equal(saving(0.0725, 0.145), 0.5)
})

test('plain against plain reads a saving of 0', (t) => {
  const plain = arm('plain')
  const twin = { ...plain, arm: 'reactor', small_model: 'example-small' }
  const { status, stderr, page } = renderFiles(t, pair(plain, twin))
  assert.equal(status, 0, stderr)
  for (const day of [2, 3, 4]) {
    assert.equal(savingCell(page, day), '0.0%', `day ${day}`)
  }
  assert.equal(saving(0.15, 0.15), 0)
})

test('the saving reads n/a when either side has no cost per solved task or plain cost nothing', () => {
  assert.equal(saving(null, 0.15), null)
  assert.equal(saving(0.15, null), null)
  assert.equal(saving(0.15, 0), null)
  assert.equal(saving(0.0725, 5e-324), null, 'a plain cost so near 0 the ratio overflows')
})

test('a day where nothing passed reads n/a, never Infinity or NaN', (t) => {
  const reactor = arm('reactor')
  reactor.days[2] = { ...reactor.days[2], passed: 0, cost_per_solved_usd: null, wrong_tool_calls: null }
  const { status, stderr, page } = renderFiles(t, pair(arm('plain'), reactor))
  assert.equal(status, 0, stderr)
  assert.equal(savingCell(page, 3), 'n/a')
  const row = cells(page, 3, 'reactor')
  assert.equal(row[5], 'n/a', '$ per solved task')
  assert.equal(row[7], 'n/a', 'wrong tool calls not measured')
  assert.doesNotMatch(page, /Infinity|NaN/)
  const line = page.match(/<path class="line reactor" d="([^"]*)"/)
  assert.equal(line[1].match(/M/g).length, 2, 'the line breaks at the missing day')
})

test('a results.json missing a field fails by name, and nothing is written', (t) => {
  const reactor = arm('reactor')
  delete reactor.run_id
  const { status, stderr, page } = renderFiles(t, pair(arm('plain'), reactor))
  assert.equal(status, 1)
  assert.match(stderr, /run\/reactor\/results\.json: run_id: missing/)
  assert.equal(page, null)
})

// The playbook arm's own fields, which only it carries, so they are the schema's only unrequired ones.
const PLAYBOOK_ONLY = ['step_lines']
const PLAYBOOK_ONLY_DAY = ['no_model_tool_steps']
// A day's field that only runs whose step lines carry their time have (since 2026-11-09), on either arm.
const CLOCKED_DAY = ['step_ms']
const UNREQUIRED_DAY = [...PLAYBOOK_ONLY_DAY, ...CLOCKED_DAY]

test("every field the schema names is required, at the top and on every day, but the playbook arm's own", () => {
  const whole = arm('plain')
  for (const key of Object.keys(schema.properties).filter((name) => !PLAYBOOK_ONLY.includes(name))) {
    const partial = { ...whole }
    delete partial[key]
    assert.deepEqual(validate(schema, partial), { path: key, why: 'missing' }, key)
  }
  for (const key of Object.keys(schema.properties.days.items.properties).filter(
    (name) => !UNREQUIRED_DAY.includes(name),
  )) {
    const days = whole.days.map((day) => ({ ...day }))
    delete days[1][key]
    assert.deepEqual(validate(schema, { ...whole, days }), { path: `days[1].${key}`, why: 'missing' }, key)
  }
})

test('a results.json with an extra top-level field fails by name', (t) => {
  const { status, stderr, page } = renderFiles(t, pair(arm('plain'), { ...arm('reactor'), colour: 'blue' }))
  assert.equal(status, 1)
  assert.match(stderr, /run\/reactor\/results\.json: colour: not allowed/)
  assert.equal(page, null)
})

test('a wrong type or an unknown arm fails by name', () => {
  const whole = arm('plain')
  assert.deepEqual(validate(schema, { ...whole, arm: 'cheap' }), {
    path: 'arm',
    why: 'must be one of "plain", "reactor", "playbook"',
  })
  const days = whole.days.map((day) => ({ ...day }))
  days[0].tasks = '10'
  assert.deepEqual(validate(schema, { ...whole, days }), { path: 'days[0].tasks', why: 'must be integer, got string' })
})

test('a file that is not JSON is named', (t) => {
  const { status, stderr } = renderFiles(t, { 'run/plain/results.json': '{ "arm": ' })
  assert.equal(status, 1)
  assert.match(stderr, /run\/plain\/results\.json: not JSON/)
})

test('the rules of a valid run refuse what the schema alone lets through', () => {
  const plain = arm('plain')
  const reactor = arm('reactor')
  const withDay = (result, index, change) => ({
    ...result,
    days: result.days.map((day, at) => (at === index ? { ...day, ...change } : day)),
  })
  assert.equal(checkRules(plain), null)
  assert.equal(checkRules(reactor), null)
  assert.equal(checkRules({ ...plain, small_model: 'example-small' }).path, 'small_model')
  assert.equal(checkRules({ ...reactor, small_model: null }).path, 'small_model')
  assert.equal(checkRules(withDay(plain, 1, { passed: 11 })).path, 'days[1].passed')
  assert.equal(checkRules(withDay(reactor, 1, { small_model_tool_steps: 59 })).path, 'days[1].small_model_tool_steps')
  assert.equal(checkRules(withDay(plain, 1, { small_model_tool_steps: 1 })).path, 'days[1].small_model_tool_steps')
  assert.equal(checkRules(withDay(plain, 1, { cost_per_solved_usd: 0.2 })).path, 'days[1].cost_per_solved_usd')
  assert.equal(checkRules(withDay(plain, 1, { cost_per_solved_usd: null })).path, 'days[1].cost_per_solved_usd')
  assert.equal(checkRules(withDay(plain, 1, { passed: 0 })).path, 'days[1].cost_per_solved_usd')
  assert.equal(checkRules(withDay(plain, 3, { day: 2 })).path, 'days')
})

test('minimum, pattern, minItems and the schema for unnamed keys each refuse by name', () => {
  const whole = arm('plain')
  const firstDay = (change) => ({
    ...whole,
    days: whole.days.map((day, at) => (at === 0 ? { ...day, ...change } : day)),
  })
  const rows = [
    [firstDay({ cost_usd: -1 }), { path: 'days[0].cost_usd', why: 'must be at least 0' }],
    [
      { ...whole, run_id: '  ' },
      { path: 'run_id', why: 'must match \\S' },
    ],
    [
      { ...whole, harness_commit: 'XYZ' },
      { path: 'harness_commit', why: 'must match ^[0-9a-f]{7,40}$' },
    ],
    [
      { ...whole, days: [] },
      { path: 'days', why: 'must hold at least 1' },
    ],
    [
      { ...whole, prices: { x: { in_per_mtok: 1 } } },
      { path: 'prices.x.out_per_mtok', why: 'missing' },
    ],
  ]
  for (const [input, expected] of rows) {
    assert.deepEqual(validate(schema, input), expected, expected.path)
  }
})

test('cost_per_solved_usd is held to within $0.000001 of cost_usd / passed', () => {
  const plain = arm('plain')
  const withCost = (cost) => ({
    ...plain,
    days: plain.days.map((day, at) => (at === 1 ? { ...day, cost_per_solved_usd: cost } : day)),
  })
  assert.equal(checkRules(withCost(0.145 + 0.0000009)), null)
  assert.equal(checkRules(withCost(0.145 + 0.000002))?.path, 'days[1].cost_per_solved_usd')
})

test('a result that is a link, or a .json not named results.json, is refused rather than skipped', (t) => {
  const misnamed = renderFiles(t, { 'run/plain/result.json': arm('plain'), 'run/reactor/results.json': arm('reactor') })
  assert.equal(misnamed.status, 1)
  assert.match(misnamed.stderr, /run\/plain\/result\.json: not a results\.json/)
  assert.equal(misnamed.page, null)
  const kept = renderFiles(t, { ...pair(arm('plain'), arm('reactor')), 'run/prices.json': {} })
  assert.equal(kept.status, 0, kept.stderr)
  const dir = scratch(t)
  lay(dir, { 'outside/results.json': arm('plain'), 'in/run/reactor/results.json': arm('reactor') })
  mkdirSync(join(dir, 'in', 'run', 'plain'))
  symlinkSync(join(dir, 'outside', 'results.json'), join(dir, 'in', 'run', 'plain', 'results.json'))
  const linked = render(join(dir, 'in'), join(dir, 'page.html'))
  assert.equal(linked.status, 1)
  assert.match(linked.stderr, /run\/plain\/results\.json: a link/)
})

test('one arm alone is refused by name', (t) => {
  const { status, stderr, page } = renderFiles(t, { 'run/plain/results.json': arm('plain') })
  assert.equal(status, 1)
  assert.match(
    stderr,
    /run fixture-2026-10-14 \(fixture-orders\): needs one plain arm and one reactor arm, found 1 plain and 0 reactor/,
  )
  assert.equal(page, null)
})

test('a doubled arm is refused by name', () => {
  const entries = [
    { file: 'a/plain/results.json', result: arm('plain') },
    { file: 'b/plain/results.json', result: arm('plain') },
    { file: 'a/reactor/results.json', result: arm('reactor') },
  ]
  assert.throws(() => pairRuns(entries), /found 2 plain and 1 reactor \(a\/plain\/results\.json, b\/plain/)
})

test('arms that differ on what they share are refused, naming the difference', () => {
  const plain = arm('plain')
  const reactor = arm('reactor')
  const differ = (change) => () =>
    pairRuns([
      { file: 'plain', result: plain },
      { file: 'reactor', result: { ...reactor, ...change } },
    ])
  assert.throws(differ({ large_model: 'other-large' }), /differ on large_model/)
  // Arms of two domains are two runs, each missing its other arm (2026-11-10: a run pairs by run_id and domain).
  assert.throws(
    differ({ domain: 'other-domain' }),
    /run fixture-2026-10-14 \((fixture-orders|other-domain)\): needs one plain arm/,
  )
  assert.throws(differ({ harness_commit: 'abcdef0' }), /differ on harness_commit/)
  assert.throws(differ({ days: reactor.days.slice(0, 3) }), /differ on days/)
  const days = reactor.days.map((day) => (day.day === 3 ? { ...day, tasks: 12 } : day))
  assert.throws(differ({ days }), /differ on tasks on day 3/)
  const [run] = pairRuns([
    { file: 'plain', result: plain },
    { file: 'reactor', result: reactor },
  ])
  assert.equal(run.smallModel, 'example-small', 'the small model comes from the reactor arm')
})

test('runs group by domain and models, in sorted order, each chart with its own id', () => {
  const runOf = (id, domain) => [
    { file: `${id}/plain`, result: { ...arm('plain'), run_id: id, domain } },
    { file: `${id}/reactor`, result: { ...arm('reactor'), run_id: id, domain } },
  ]
  const page = renderPage(pairRuns([...runOf('z', 'b-dom'), ...runOf('a', 'b-dom'), ...runOf('m', 'a-dom')]))
  const headings = [...page.matchAll(/<h2>([^<]*)<\/h2>/g)].map((match) => match[1])
  assert.deepEqual(headings, ['a-dom', 'b-dom'])
  const runs = [...page.matchAll(/<h3>Run <code>([^<]*)</g)].map((match) => match[1])
  assert.deepEqual(runs, ['m', 'a', 'z'])
  const ids = [...page.matchAll(/id="(chart-\d+-title)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, 3)
})

test('refuses arms that started more than 24 hours apart: an arm copied in from another run (2026-11-12)', () => {
  const plain = { ...arm('plain'), started_at: '2026-10-03T00:00:00.000Z' }
  assert.throws(
    () =>
      pairRuns([
        { file: 'r/plain', result: plain },
        { file: 'r/reactor', result: arm('reactor') },
      ]),
    /the arms started more than 24 hours apart/,
  )
})

test('pairs the arms of a run by run_id and domain, as the scorer writes them: one run, two domains', () => {
  // The harness runs both desks under one run_id, and `node cli.ts score` pairs them by run_id and domain (2026-11-10).
  const runOf = (domain) => [
    { file: `r-${domain}/plain`, result: { ...arm('plain'), run_id: 'r', domain } },
    { file: `r-${domain}/reactor`, result: { ...arm('reactor'), run_id: 'r', domain } },
  ]
  const runs = pairRuns([...runOf('support-ops'), ...runOf('files-ops')])
  assert.deepEqual(
    runs.map((run) => [run.runId, run.plain.domain]),
    [
      ['r', 'files-ops'],
      ['r', 'support-ops'],
    ],
  )
})

test('a one-day run, a run that cost nothing and days out of order render without NaN, in day order', () => {
  const both = (change) =>
    renderPage(
      pairRuns([
        { file: 'plain', result: change(arm('plain')) },
        { file: 'reactor', result: change(arm('reactor')) },
      ]),
    )
  assert.doesNotMatch(
    both((result) => ({ ...result, days: [result.days[0]] })),
    /NaN|Infinity/,
  )
  const free = (result) => ({
    ...result,
    days: result.days.map((day) => ({ ...day, cost_usd: 0, cost_per_solved_usd: 0 })),
  })
  assert.doesNotMatch(both(free), /NaN|Infinity/)
  const page = both((result) => ({ ...result, days: [...result.days].reverse() }))
  const order = [...page.matchAll(/data-day="(\d)" data-arm="plain"/g)].map((match) => match[1])
  assert.deepEqual(order, ['1', '2', '3', '4'])
})

// An arm's result as the scorer writes it for a run asked with --words same: its sentence leads the notes.
const sameWords = (result) => ({ ...result, notes: `${SAME_WORDS_NOTE} ${result.notes}` })

// Each run's words label, in page order, as [words, text].
const labels = (page) =>
  [...page.matchAll(/<p class="fine" data-words="([^"]*)">([^<]*)<\/p>/g)].map((match) => [match[1], match[2]])

test('each run says whether it asked in the same words or new words, from the sentence the scorer writes, above its chart and table', (t) => {
  const fresh = renderFiles(t, pair(arm('plain'), arm('reactor')))
  assert.equal(fresh.status, 0, fresh.stderr)
  assert.deepEqual(labels(fresh.page), [
    ['new', 'new words: each day asks every job in words it was not asked in before, with new data'],
  ])
  const run = fresh.page.match(/<article class="run">(.*?)<\/article>/s)[1]
  assert.ok(run.indexOf('data-words=') < run.indexOf('<svg'), 'the label comes before the chart')
  assert.doesNotMatch(run.match(/<div class="scroll">(.*?)<\/div>/s)[1], /data-words/, 'not inside the scrolling table')
  const same = renderFiles(t, pair(sameWords(arm('plain')), sameWords(arm('reactor'))))
  assert.equal(same.status, 0, same.stderr)
  assert.deepEqual(labels(same.page), [
    ['same', 'same words: every day asks each job in its day-1 words, with new data'],
  ])
  const later = (result) => ({ ...result, notes: `${result.notes} ${SAME_WORDS_NOTE}` })
  const mentioned = renderFiles(t, pair(later(arm('plain')), later(arm('reactor'))))
  assert.equal(mentioned.status, 0, mentioned.stderr)
  assert.deepEqual(
    labels(mentioned.page).map(([words]) => words),
    ['new'],
    'the sentence counts only where the scorer puts it, first',
  )
  const runOf = (id, change) => [
    { file: `${id}/plain`, result: change({ ...arm('plain'), run_id: id }) },
    { file: `${id}/reactor`, result: change({ ...arm('reactor'), run_id: id }) },
  ]
  const both = renderPage(pairRuns([...runOf('b', sameWords), ...runOf('a', (result) => result)]))
  assert.deepEqual(
    labels(both).map(([words]) => words),
    ['new', 'same'],
  )
})

test('arms whose notes disagree on the same words are refused by name, and nothing is written', (t) => {
  for (const [plain, reactor, said] of [
    [sameWords(arm('plain')), arm('reactor'), '(plain "same", reactor "new")'],
    [arm('plain'), sameWords(arm('reactor')), '(plain "new", reactor "same")'],
  ]) {
    const { status, stderr, page } = renderFiles(t, pair(plain, reactor))
    assert.equal(status, 1)
    assert.equal(stderr, `run fixture-2026-10-14 (fixture-orders): the arms differ on words ${said}\n`)
    assert.equal(page, null)
  }
})

test('the page says the reactor arm cost is a floor and its saving a ceiling', () => {
  assert.match(renderPage([]), /the reactor arm's cost is a floor and its saving is a ceiling/)
})

test("the page and METHOD.md name the saving as the saving before Reactor's share-of-savings charge", () => {
  const named = /saving\s+before\s+Reactor's\s+share-of-savings\s+charge/i
  const page = renderPage(
    pairRuns([
      { file: 'plain', result: arm('plain') },
      { file: 'reactor', result: arm('reactor') },
    ]),
  )
  assert.match(page.match(/<thead>(.*?)<\/thead>/s)[1], named, 'the column')
  assert.match(page.match(/<header>(.*?)<\/header>/s)[1], named, 'the definition above the tables')
  assert.match(readFileSync(join(here, '..', 'METHOD.md'), 'utf8'), named)
})

test('the plain arm writes null wrong tool calls, which read n/a, not 0', (t) => {
  const { status, stderr, page } = renderFiles(t, pair(arm('plain'), arm('reactor')))
  assert.equal(status, 0, stderr)
  for (const day of [1, 2, 3, 4]) {
    assert.equal(cells(page, day, 'plain')[7], 'n/a', `day ${day}`)
  }
  assert.match(page.match(/<header>(.*?)<\/header>/s)[1], /n\/a means[^<]*the plain arm's wrong tool calls/)
  const method = readFileSync(join(here, '..', 'METHOD.md'), 'utf8')
  assert.match(method, /^\| `wrong_tool_calls` \|[^\n]*`null` on the plain arm/m)
})

test('strings a submitter writes are escaped wherever the page shows them', (t) => {
  const hostile = {
    domain: '<img src=x onerror=alert(1)>',
    run_id: '"><svg onload=alert(1)>',
    large_model: '<b>large</b>',
  }
  const plain = { ...arm('plain'), ...hostile, notes: '<script>alert(1)</script>' }
  const reactor = { ...arm('reactor'), ...hostile, small_model: '<i>small</i>', notes: '</p><script>x</script>' }
  const { status, stderr, page } = renderFiles(t, pair(plain, reactor))
  assert.equal(status, 0, stderr)
  assert.doesNotMatch(page, /<script|<img|<svg onload|<b>|<i>/)
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('the page loads nothing from anywhere and has no inside word', (t) => {
  const dir = scratch(t)
  const out = join(dir, 'index.html')
  assert.equal(render(fixture, out).status, 0)
  const page = readFileSync(out, 'utf8')
  assert.doesNotMatch(page, /<script|<link|<iframe|<img|<object|<embed/i)
  assert.doesNotMatch(page, /\b(src|href|srcset|action)\s*=/i)
  assert.doesNotMatch(page, /@import|url\(|https?:\/\//i)
  assert.doesNotMatch(page, /\bfetch\s*\(/)
})

test('the page is light or dark by the reader preference and fits a phone', (t) => {
  const dir = scratch(t)
  const out = join(dir, 'index.html')
  assert.equal(render(fixture, out).status, 0)
  const page = readFileSync(out, 'utf8')
  assert.match(page, /@media \(prefers-color-scheme: ?dark\)/)
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
  assert.match(page, /<svg[^>]*viewBox="0 0 \d+ \d+"/)
  assert.match(page, /\.scroll\s*\{[^}]*overflow-x:\s*auto/)
})

test('the same input renders the same bytes', (t) => {
  const dir = scratch(t)
  assert.equal(render(fixture, join(dir, 'a.html')).status, 0)
  assert.equal(render(fixture, join(dir, 'b.html')).status, 0)
  assert.equal(readFileSync(join(dir, 'a.html'), 'utf8'), readFileSync(join(dir, 'b.html'), 'utf8'))
})

test('a results folder with no results renders the empty page and exits 0', (t) => {
  const { status, stderr, page } = renderFiles(t, { 'README.md': '# results\n' })
  assert.equal(status, 0, stderr)
  assert.match(page, /No results yet/)
  assert.doesNotMatch(page, /<table/)
  assert.equal(renderPage([]), page)
})

test('a missing --in or --out prints the usage and exits 2', (t) => {
  const dir = scratch(t)
  for (const args of [['--in', fixture], ['--out', join(dir, 'x.html')], []]) {
    const run = spawnSync(process.execPath, [renderer, ...args], { encoding: 'utf8' })
    assert.equal(run.status, 2, args.join(' '))
    assert.match(run.stderr, /^usage: node bench\/publish\/render\.mjs --in/)
  }
})

test('an --in folder that does not exist is named', (t) => {
  const dir = scratch(t)
  const run = render(join(dir, 'nowhere'), join(dir, 'x.html'))
  assert.equal(run.status, 1)
  assert.match(run.stderr, /nowhere: not a folder/)
})

test('the validator refuses a schema keyword it does not check, instead of skipping it', () => {
  assert.doesNotThrow(() => assertKnownKeywords(schema))
  const loose = { type: 'object', properties: { days: { type: 'array', items: { type: 'object', maxProperties: 3 } } } }
  assert.throws(() => assertKnownKeywords(loose), /schema keyword not supported: maxProperties/)
  const prices = { type: 'object', additionalProperties: { type: 'object', maxProperties: 3 } }
  assert.throws(() => assertKnownKeywords(prices), /schema keyword not supported: maxProperties/)
  assert.throws(() => validate({ type: 'string', maxLength: 3 }, 'abcd'), /schema keyword not supported: maxLength/)
})

test("the schema closes the top level and requires every field it names but the playbook arm's own", () => {
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(
    [...schema.required].sort(),
    Object.keys(schema.properties)
      .filter((name) => !PLAYBOOK_ONLY.includes(name))
      .sort(),
  )
  const day = schema.properties.days.items
  assert.deepEqual(
    [...day.required].sort(),
    Object.keys(day.properties)
      .filter((name) => !UNREQUIRED_DAY.includes(name))
      .sort(),
  )
  assert.deepEqual([...PLAYBOOK_ONLY, ...UNREQUIRED_DAY], ['step_lines', 'no_model_tool_steps', 'step_ms'])
})

// A playbook arm made from the fixture's reactor arm: its own two fields, and a step line for its first task.
const playbookArm = () => {
  const reactor = arm('reactor')
  return {
    ...reactor,
    arm: 'playbook',
    days: reactor.days.map((day) => ({ ...day, small_model_tool_steps: 0, no_model_tool_steps: 10 })),
    step_lines: [{ day: 1, job: 'refund-full', line: '1 get_ticket ask ok, 2 refund_order large ok, reply large' }],
  }
}

const three = (plain, reactor, playbook) => ({ ...pair(plain, reactor), 'run/playbook/results.json': playbook })

test('a run with plain, reactor and playbook arms renders three rows a day, three lines and the step lines', (t) => {
  const plain = arm('plain')
  const playbook = playbookArm()
  const { status, stderr, page } = renderFiles(t, three(plain, arm('reactor'), playbook))
  assert.equal(status, 0, stderr)
  assert.equal(page.match(/<tr[^>]*data-day=/g)?.length, 12)
  for (const day of [2, 3, 4]) {
    const row = page.match(new RegExp(`<tr[^>]*data-day="${day}" data-arm="playbook"[^>]*>(.*?)</tr>`))[1]
    const p = plain.days.find((d) => d.day === day).cost_per_solved_usd
    const b = playbook.days.find((d) => d.day === day).cost_per_solved_usd
    assert.match(row, new RegExp(`<td data-col="saving">${((1 - b / p) * 100).toFixed(1)}%</td>`), `day ${day}`)
  }
  const day = playbook.days[1]
  assert.equal(cells(page, 2, 'playbook')[4], `${((10 / day.tool_steps) * 100).toFixed(0)}%`, 'local fills count')
  assert.match(page, /<path class="line playbook" d="/)
  assert.match(page, /<span class="key playbook"><\/span>playbook:/)
  assert.match(page, /\.chart \.line\.playbook\{stroke:var\(--playbook\)\}/)
  assert.match(page, /plain against reactor and playbook/)
  assert.match(
    page,
    /<li>Day 1, <code>refund-full<\/code>: 1 get_ticket ask ok, 2 refund_order large ok, reply large<\/li>/,
  )
})

test('a run with plain and playbook alone renders, against plain', (t) => {
  const { status, stderr, page } = renderFiles(t, {
    'run/plain/results.json': arm('plain'),
    'run/playbook/results.json': playbookArm(),
  })
  assert.equal(status, 0, stderr)
  assert.equal(page.match(/<tr[^>]*data-day=/g)?.length, 8)
  assert.doesNotMatch(page, /data-arm="reactor"/)
  assert.match(page, /plain against playbook/)
})

test('a run with a playbook arm and the wrong arms beside it is refused, naming all three', () => {
  const entries = [
    { file: 'a/plain/results.json', result: arm('plain') },
    { file: 'a/playbook/results.json', result: playbookArm() },
    { file: 'b/playbook/results.json', result: playbookArm() },
  ]
  assert.throws(
    () => pairRuns(entries),
    /needs one plain arm and one reactor arm, one playbook arm or both, found 1 plain, 0 reactor and 2 playbook \(a\/plain/,
  )
  assert.throws(() => pairRuns([entries[1]]), /found 0 plain, 0 reactor and 1 playbook/)
  const smaller = { ...playbookArm(), small_model: 'other-small' }
  assert.throws(
    () =>
      pairRuns([
        { file: 'plain', result: arm('plain') },
        { file: 'reactor', result: arm('reactor') },
        { file: 'playbook', result: smaller },
      ]),
    /the arms differ on small_model \(reactor "example-small", playbook "other-small"\)/,
  )
  assert.throws(
    () =>
      pairRuns([
        { file: 'plain', result: arm('plain') },
        { file: 'playbook', result: { ...playbookArm(), large_model: 'other-large' } },
      ]),
    /the arms differ on large_model \(plain "example-large", playbook "other-large"\)/,
  )
})

test("the rules hold the playbook arm's own fields to the playbook arm, and its small model to every arm but plain", () => {
  const playbook = playbookArm()
  const withDay = (result, change) => ({
    ...result,
    days: result.days.map((day, at) => (at === 1 ? { ...day, ...change } : day)),
  })
  assert.equal(checkRules(playbook), null)
  assert.deepEqual(checkRules({ ...playbook, small_model: null }), {
    path: 'small_model',
    why: 'must name the small model on the playbook arm',
  })
  assert.equal(checkRules({ ...arm('reactor'), step_lines: [] }).path, 'step_lines')
  assert.equal(checkRules(withDay(arm('plain'), { no_model_tool_steps: 0 })).path, 'days[1].no_model_tool_steps')
  assert.equal(checkRules(withDay(playbook, { no_model_tool_steps: 61 })).path, 'days[1].no_model_tool_steps')
  assert.equal(
    validate(schema, { ...playbook, step_lines: [{ day: 1, job: 'x', line: ' ' }] }).path,
    'step_lines[0].line',
  )
})

test('a page with no playbook arm says nothing of one', (t) => {
  const { status, stderr, page } = renderFiles(t, pair(arm('plain'), arm('reactor')))
  assert.equal(status, 0, stderr)
  assert.doesNotMatch(page, /playbook/)
})

test('strings a submitter writes on the playbook arm are escaped too: its step lines and its notes', (t) => {
  const playbook = {
    ...playbookArm(),
    notes: '</p><script>x</script>',
    step_lines: [{ day: 1, job: '<b>refund-full</b>', line: '</li><script>alert(1)</script>' }],
  }
  const { status, stderr, page } = renderFiles(t, three(arm('plain'), arm('reactor'), playbook))
  assert.equal(status, 0, stderr)
  assert.doesNotMatch(page, /<script|<b>/)
  assert.match(
    page,
    /<li>Day 1, <code>&lt;b&gt;refund-full&lt;\/b&gt;<\/code>: &lt;\/li&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li>/,
  )
  assert.match(page, /Notes, playbook arm\.<\/strong> &lt;\/p&gt;&lt;script&gt;x&lt;\/script&gt;/)
})
