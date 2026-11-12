import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One run that used a Reactor key, as the ledger files it. */
export interface KeyUse {
  run_id: string
  domain: string
  at: string
}

/** The ledger file: by base URL, then by key fingerprint, the run that used that key there before any other. */
export interface Ledger {
  benchmark: 'repeat-bill'
  keys: Record<string, Record<string, KeyUse>>
}

/** A run id as the CLI accepts it, so a ledger entry cannot carry anything else into run.json or a message. */
const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/

/** Where the harness keeps its key ledger unless --ledger names another file. */
export const defaultLedger = (): string => join(homedir(), '.repeat-bill', 'keys.json')

/**
 * sha256 of the key as fetch sends it, its first 12 hex characters: enough to tell keys apart, never enough to get
 * one back. fetch drops a header's trailing whitespace, so a key pasted with a newline after it is the same key.
 */
export const fingerprintOf = (key: string): string =>
  createHash('sha256')
    .update(key.replace(/[\t\n\r ]+$/, ''))
    .digest('hex')
    .slice(0, 12)

/** The endpoint a key is filed under: the base URL with no query, credentials or trailing slash. */
export const endpointOf = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUse = (value: unknown): value is KeyUse =>
  isObject(value) &&
  typeof value.run_id === 'string' &&
  RUN_ID.test(value.run_id) &&
  typeof value.domain === 'string' &&
  typeof value.at === 'string'

/**
 * The ledger in the file, or an empty one when there is no file. Anything else it cannot read refuses the run:
 * a ledger read as empty would call every key fresh.
 */
export const readLedger = (file: string): Ledger => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { benchmark: 'repeat-bill', keys: {} }
    }
    throw new Error(`${file}: the key ledger cannot be read (${code ?? 'unknown error'})`, { cause: err })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const wrote =
    isObject(parsed) &&
    parsed.benchmark === 'repeat-bill' &&
    isObject(parsed.keys) &&
    Object.values(parsed.keys).every((prints) => isObject(prints) && Object.values(prints).every(isUse))
  if (!wrote) {
    throw new Error(`${file}: not a key ledger this harness wrote`)
  }
  return parsed as unknown as Ledger
}

/** The run the ledger names for this key at this endpoint, or null. Reads the ledger and never writes it. */
export const earlierUse = (file: string, baseUrl: string, key: string): KeyUse | null =>
  readLedger(file).keys[endpointOf(baseUrl)]?.[fingerprintOf(key)] ?? null

/**
 * The run that used this key at this endpoint before, or null after filing this use as the first. The ledger is
 * written whole to a temp file created new, so nothing already at that path is followed, and renamed into place.
 * The file is 0600; a folder this creates is 0700.
 */
export const useKey = (file: string, baseUrl: string, key: string, use: KeyUse): KeyUse | null => {
  if (!isUse(use)) {
    throw new Error('the key ledger files only a run id the command line accepts')
  }
  const ledger = readLedger(file)
  const endpoint = endpointOf(baseUrl)
  const print = fingerprintOf(key)
  const earlier = ledger.keys[endpoint]?.[print]
  if (earlier !== undefined) {
    return earlier
  }
  ledger.keys[endpoint] = { ...ledger.keys[endpoint], [print]: use }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${temp}: already there; remove it if no run is writing the key ledger`, { cause: err })
    }
    throw err
  }
  renameSync(temp, file)
  return null
}
