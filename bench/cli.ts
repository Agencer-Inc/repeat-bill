import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { defaultLedger } from './harness/ledger.ts'
import { loadPrices, priceOf } from './harness/prices.ts'
import type { ClientName } from './harness/run.ts'
import { CLIENTS, SETTLE_SECONDS, TIMEOUT_SECONDS, capOf, harnessCommit, runArm } from './harness/run.ts'
import { CHARS_PER_TOKEN, estimateTable } from './score/estimate.ts'
import { jobTableOf, readRun, scoreRuns, tableOf, writeResults } from './score/score.ts'
import { DOMAINS, domainNamed } from './tasks/domains.ts'
import type { Domain } from './tasks/shared.ts'
import { DAYS } from './tasks/shared.ts'

const USAGE = `usage:
  node cli.ts run --arm plain|reactor|playbook --domain ${DOMAINS.map((d) => d.name).join('|')} --run-id ID --base-url URL
                  --key ENV_NAME --large MODEL [--small MODEL] [--days ${DAYS}] [--seed 1] [--words new|same] --out DIR
                  [--settle-seconds ${SETTLE_SECONDS}] [--max-steps N] [--timeout-seconds ${TIMEOUT_SECONDS}] [--prices FILE]
                  [--ledger FILE] [--fresh-key-required] [--client ${Object.keys(CLIENTS).join('|')}] [--allow-model true|false]
                  [--reply on|off] [--provider-url URL --provider-key ENV_NAME]
  node cli.ts score --in DIR [--in DIR ...] --out DIR [--table FILE]
  node cli.ts estimate [--seed 1] [--prices FILE]

  --key names the environment variable that holds the API key; the key itself is never a flag.
  --small is the small model the Reactor key was made with, on the reactor and playbook arms; the plain arm takes none.
  --words new asks each job in a new phrasing every day; same asks its day-1 phrasing every day, with new data.
  --ledger is the reactor and playbook arms' key ledger, ~/.repeat-bill/keys.json unless given: a one-way fingerprint
    of each Reactor key it ran, by base URL. --fresh-key-required refuses to start on a key the ledger has seen.
  --client is the client the playbook arm runs each job with: bare, the harness's own stand-in for the customer's
    library, unless given; library, the customer's own (@agencer/reactor). --allow-model false asks the door to fill no step with a model; true unless given. --reply on asks the door for each job's final reply once its playbook ran to its end, the small model writing it; off unless given. The
    playbook arm needs a door started with REACTOR_PLAYBOOK_DOOR=on.
  --provider-url and --provider-key are the library client's own provider (--client library needs both): the
    OpenAI-shaped base URL its runner and its agent's own calls go to, and the name of the environment variable that
    holds that provider's key; as --key, the key itself is never a flag. The door sees only a fingerprint of it.
  --max-steps is the domain's own cap unless given: ${DOMAINS.map((d) => `${d.name} ${capOf(d)}`).join(', ')}.`

class UsageError extends Error {}

const need = (value: string | undefined, flag: string): string => {
  if (value === undefined || value === '') {
    throw new UsageError(`${flag} is required`)
  }
  return value
}

const whole = (value: string | undefined, flag: string, fallback: number, lo: number, hi: number): number => {
  if (value === undefined) {
    return fallback
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new UsageError(`${flag} must be a whole number from ${lo} to ${hi}`)
  }
  return n
}

const run = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      arm: { type: 'string' },
      domain: { type: 'string' },
      'run-id': { type: 'string' },
      'base-url': { type: 'string' },
      key: { type: 'string' },
      large: { type: 'string' },
      small: { type: 'string' },
      days: { type: 'string' },
      seed: { type: 'string' },
      words: { type: 'string' },
      out: { type: 'string' },
      'settle-seconds': { type: 'string' },
      'max-steps': { type: 'string' },
      'timeout-seconds': { type: 'string' },
      prices: { type: 'string' },
      ledger: { type: 'string' },
      'fresh-key-required': { type: 'boolean' },
      client: { type: 'string' },
      'allow-model': { type: 'string' },
      reply: { type: 'string' },
      'provider-url': { type: 'string' },
      'provider-key': { type: 'string' },
    },
  })
  const arm = need(values.arm, '--arm')
  if (arm !== 'plain' && arm !== 'reactor' && arm !== 'playbook') {
    throw new UsageError('--arm is plain, reactor or playbook')
  }
  const words = values.words ?? 'new'
  if (words !== 'new' && words !== 'same') {
    throw new UsageError('--words is new or same')
  }
  const domainName = need(values.domain, '--domain')
  let domain: Domain
  try {
    domain = domainNamed(domainName)
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
  const runId = need(values['run-id'], '--run-id')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(runId)) {
    throw new UsageError('--run-id is 1 to 64 letters, digits, dots, dashes or underscores')
  }
  const baseUrl = need(values['base-url'], '--base-url')
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new UsageError('--base-url must start with http:// or https://')
  }
  const small = values.small ?? null
  if (arm === 'plain' && small !== null) {
    throw new UsageError('the plain arm takes no --small')
  }
  if (arm !== 'plain' && small === null) {
    throw new UsageError(`the ${arm} arm needs --small, the small model its key was made with`)
  }
  if (arm === 'plain' && values['settle-seconds'] !== undefined) {
    throw new UsageError('--settle-seconds applies to the reactor and playbook arms only')
  }
  if (arm === 'plain' && values.ledger !== undefined) {
    throw new UsageError('--ledger applies to the reactor and playbook arms only')
  }
  if (arm === 'plain' && values['fresh-key-required'] !== undefined) {
    throw new UsageError('--fresh-key-required applies to the reactor and playbook arms only')
  }
  for (const flag of ['client', 'allow-model', 'reply'] as const) {
    if (arm !== 'playbook' && values[flag] !== undefined) {
      throw new UsageError(`--${flag} applies to the playbook arm only`)
    }
  }
  // Neither value is echoed: either may be a key pasted by mistake.
  const client = values.client ?? 'bare'
  if (!Object.hasOwn(CLIENTS, client)) {
    throw new UsageError(`--client is ${Object.keys(CLIENTS).join(' or ')}`)
  }
  const library = client === 'library'
  for (const flag of ['provider-url', 'provider-key'] as const) {
    if (!library && values[flag] !== undefined) {
      throw new UsageError(`--${flag} applies to --client library only`)
    }
    if (library && (values[flag] === undefined || values[flag] === '')) {
      throw new UsageError(`--${flag} is required with --client library`)
    }
  }
  const providerUrl = values['provider-url']
  if (providerUrl !== undefined && !/^https?:\/\//.test(providerUrl)) {
    throw new UsageError('--provider-url must start with http:// or https://')
  }
  const providerKeyName = values['provider-key']
  if (providerKeyName !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(providerKeyName)) {
    throw new UsageError('--provider-key takes the name of an environment variable, not a key')
  }
  const providerKey = providerKeyName === undefined ? undefined : process.env[providerKeyName]
  if (providerKeyName !== undefined && (providerKey === undefined || providerKey === '')) {
    throw new UsageError('the environment variable named by --provider-key is not set')
  }
  const allowModel = values['allow-model'] ?? 'true'
  if (allowModel !== 'true' && allowModel !== 'false') {
    throw new UsageError('--allow-model is true or false')
  }
  const reply = values.reply ?? 'off'
  if (reply !== 'on' && reply !== 'off') {
    throw new UsageError('--reply is on or off')
  }
  // The plain arm's key is the large model provider's, which learns nothing, so it keeps no ledger.
  const ledger = arm !== 'plain' ? (values.ledger ?? defaultLedger()) : undefined
  if (ledger === '') {
    throw new UsageError('--ledger takes the path of a file')
  }
  // The flag's value is never echoed: it may be a key pasted by mistake.
  const keyName = need(values.key, '--key')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) {
    throw new UsageError('--key takes the name of an environment variable, not a key')
  }
  const key = process.env[keyName]
  if (key === undefined || key === '') {
    throw new UsageError('the environment variable named by --key is not set')
  }
  const large = need(values.large, '--large')
  const prices = loadPrices(values.prices)
  try {
    priceOf(prices, large)
    if (small !== null) {
      priceOf(prices, small)
    }
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
  const bench = dirname(fileURLToPath(import.meta.url))
  const record = await runArm({
    arm,
    domain,
    days: whole(values.days, '--days', DAYS, 1, DAYS),
    baseUrl,
    key,
    large,
    small,
    seed: whole(values.seed, '--seed', 1, 0, 2 ** 31),
    words,
    runId,
    out: need(values.out, '--out'),
    prices,
    harnessCommit: harnessCommit(bench),
    maxSteps: whole(values['max-steps'], '--max-steps', capOf(domain), 1, 200),
    settleSeconds: whole(values['settle-seconds'], '--settle-seconds', SETTLE_SECONDS, 0, 3600),
    timeoutSeconds: whole(values['timeout-seconds'], '--timeout-seconds', TIMEOUT_SECONDS, 1, 3600),
    ledger,
    freshKeyRequired: values['fresh-key-required'] === true,
    client: client as ClientName,
    ...(providerUrl === undefined || providerKey === undefined ? {} : { providerUrl, providerKey }),
    allowModel: allowModel === 'true',
    reply: reply === 'on',
    log: (line) => console.log(line),
  })
  console.log(`done: ${record.arm} arm, ${record.domain}, ${record.days} days, run ${record.run_id}`)
}

const score = (argv: string[]): void => {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { in: { type: 'string', multiple: true }, out: { type: 'string' }, table: { type: 'string' } },
  })
  const dirs = values.in ?? []
  if (dirs.length === 0) {
    throw new UsageError('--in is required, once per run folder')
  }
  const out = need(values.out, '--out')
  const runs = dirs.map(readRun)
  const results = scoreRuns(runs)
  for (const file of writeResults(out, results)) {
    console.log(`wrote ${file}`)
  }
  const table = values.table ?? join(out, 'table.md')
  mkdirSync(dirname(table), { recursive: true })
  writeFileSync(table, `${tableOf(results)}\n${jobTableOf(runs)}`)
  console.log(`wrote ${table}`)
}

const estimate = (argv: string[]): void => {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { seed: { type: 'string' }, prices: { type: 'string' } },
  })
  const seed = whole(values.seed, '--seed', 1, 0, 2 ** 31)
  console.log(
    `An estimate, not a measurement: the reference solutions' own conversations at ${CHARS_PER_TOKEN} characters a token, 20 tasks a day for ${DAYS} days, at list prices.\n`,
  )
  console.log(estimateTable(DOMAINS, loadPrices(values.prices), seed))
}

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (command === 'run') {
      await run(rest)
      return 0
    }
    if (command === 'score') {
      score(rest)
      return 0
    }
    if (command === 'estimate') {
      estimate(rest)
      return 0
    }
    console.error(USAGE)
    return 2
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`)
      return 2
    }
    // parseArgs quotes a stray argument back, and a stray argument may be a pasted key.
    if (err instanceof TypeError && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS')) {
      console.error(`an unknown option or a stray argument\n\n${USAGE}`)
      return 2
    }
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}

process.exitCode = await main()
