/** Tool arguments as the model sent them, parsed from JSON. */
export type Args = Record<string, unknown>

export interface ParamSpec {
  type: 'string' | 'number'
  description: string
  enum?: readonly string[]
}

/** A tool in the OpenAI function form, exactly as it is sent in a request's `tools`. */
export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ParamSpec>
      required: string[]
      additionalProperties: false
    }
  }
}

export interface Call {
  tool: string
  args: Args
}

/** One successful acting call: the tool, its arguments, and the record it changed. */
export interface Effect {
  tool: string
  args: Args
  target: string
}

export interface Check {
  pass: boolean
  reason: string
}

/** A job's reference answer: the tool calls that do it, then the reply in words. */
export interface Solution {
  calls: Call[]
  reply: string
}

export interface End<W> {
  start: W
  state: W
  effects: readonly Effect[]
  reply: string
}

/** One generated job: its world, the values its ask is filled with, and how to solve and check it. */
export interface Job<W> {
  world: W
  slots: Record<string, string>
  solve: () => Solution
  check: (end: End<W>) => Check
  /** A plausible wrong acting call (a look-alike record, a wrong value). A checker must fail it. */
  decoy: () => Call
}

export interface Template<W, D> {
  id: string
  goal: string
  /** At least five phrasings of the ask, with `{slot}` placeholders. */
  forms: readonly string[]
  make: (draw: D) => Job<W>
}

/** A fresh sandbox for one task. */
export interface Session {
  call: (tool: string, args: unknown) => unknown
  readonly effects: readonly Effect[]
  check: (reply: string) => Check
}

export interface Instance {
  domain: string
  day: number
  template: string
  id: string
  form: number
  ask: string
  slots: Readonly<Record<string, string>>
  world: unknown
  /** Every identifying value drawn for this instance. */
  drawn: readonly string[]
  open: () => Session
  solve: () => Solution
  decoy: () => Call
  /** The identifying values present in this instance's world, read from the world itself. */
  identities: () => string[]
}

/** The words a run asks each job in: a different phrasing every day (new), or its day-1 phrasing every day (same). */
export type Words = 'new' | 'same'

export interface Domain {
  name: string
  system: string
  tools: readonly ToolSpec[]
  acting: ReadonlySet<string>
  /** Fixed words an ask may repeat across tasks (a team, a city, a product), lower-cased. */
  vocabulary: ReadonlySet<string>
  templates: readonly { id: string; goal: string; forms: readonly string[] }[]
  /** Every instance of a run, day-major; words is new unless given. */
  instances: (seed: number, days: number, words?: Words) => Instance[]
  /** The steps a task may take, for a domain whose jobs outgrow the harness's default; unset takes the default. */
  maxSteps?: number
}

export interface Rng {
  next: () => number
  int: (lo: number, hi: number) => number
  pick: <T>(list: readonly T[]) => T
  shuffle: <T>(list: readonly T[]) => T[]
  sample: <T>(list: readonly T[], n: number) => T[]
}

/** Hands out a value no earlier instance of the domain has used. */
export interface Picker {
  fresh: (draw: () => string) => string
}

export interface DomainDef<W, D> {
  name: string
  system: string
  tools: readonly ToolSpec[]
  acting: readonly string[]
  vocabulary: readonly string[]
  templates: readonly Template<W, D>[]
  draws: (rng: Rng, pick: Picker) => D
  table: (state: W, effects: Effect[]) => Record<string, (args: Args) => unknown>
  identities: (world: W) => string[]
  maxSteps?: number
}

export const DAYS = 4

/** A refusal a tool answers with `{ error }`, as a real API would; anything else thrown is a bug. */
export class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Seeded random: FNV-1a over the parts, then mulberry32. No clock, no Math.random.
// ---------------------------------------------------------------------------

const hash32 = (text: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export const rngFor = (...parts: readonly (string | number)[]): Rng => {
  let a = hash32(parts.join('\u001f'))
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1))
  const pick = <T>(list: readonly T[]): T => need(list[int(0, list.length - 1)], 'a value from an empty list')
  const shuffle = <T>(list: readonly T[]): T[] => {
    const out = [...list]
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i)
      const held = out[i] as T
      out[i] = out[j] as T
      out[j] = held
    }
    return out
  }
  const sample = <T>(list: readonly T[], n: number): T[] => shuffle(list).slice(0, n)
  return { next, int, pick, shuffle, sample }
}

export const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) {
    throw new Error(`missing ${what}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Instances by day
// ---------------------------------------------------------------------------

const fill = (form: string, slots: Record<string, string>): string =>
  form.replace(/\{(\w+)\}/g, (_, name: string) => need(slots[name], `slot {${name}}`))

const openSession = <W, D>(def: DomainDef<W, D>, job: Job<W>): Session => {
  const state = structuredClone(job.world)
  const effects: Effect[] = []
  const table = def.table(state, effects)
  const call = (tool: string, args: unknown): unknown => {
    const run = Object.hasOwn(table, tool) ? table[tool] : undefined
    if (run === undefined) {
      return { error: `there is no tool named ${tool}` }
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { error: 'arguments must be a JSON object' }
    }
    try {
      return structuredClone(run(args as Args))
    } catch (err) {
      if (err instanceof ToolError) {
        return { error: err.message }
      }
      throw err
    }
  }
  return { call, effects, check: (reply) => job.check({ start: job.world, state, effects, reply }) }
}

/**
 * Day-major, templates in order, one shared set of used values: so the first N days of a
 * four-day generation are the N-day generation, and no identifying value repeats in a domain.
 */
const generate = <W, D>(def: DomainDef<W, D>, seed: number, days: number, words: Words): Instance[] => {
  if (!Number.isInteger(days) || days < 1 || days > DAYS) {
    throw new Error(`days must be a whole number from 1 to ${DAYS}`)
  }
  if (words !== 'new' && words !== 'same') {
    throw new Error('words must be new or same')
  }
  const used = new Set<string>()
  const out: Instance[] = []
  for (let day = 1; day <= days; day++) {
    for (const template of def.templates) {
      const drawn: string[] = []
      const pick: Picker = {
        fresh: (draw) => {
          for (let tries = 0; tries < 500; tries++) {
            const value = draw()
            const key = value.toLowerCase()
            if (!used.has(key)) {
              used.add(key)
              drawn.push(value)
              return value
            }
          }
          throw new Error(`${def.name} ran out of fresh values in ${template.id}`)
        },
      }
      const job = template.make(def.draws(rngFor(seed, def.name, day, template.id), pick))
      const order = rngFor(seed, def.name, template.id, 'forms').shuffle(template.forms.map((_, i) => i))
      // The order is the same on every day, so order[0] is day 1's phrasing; the draws above never read it.
      const form = need(order[words === 'same' ? 0 : day - 1], `a phrasing for day ${day} of ${template.id}`)
      out.push({
        domain: def.name,
        day,
        template: template.id,
        id: `${def.name}.d${day}.${template.id}`,
        form,
        ask: fill(need(template.forms[form], 'a form'), job.slots),
        slots: job.slots,
        world: job.world,
        drawn,
        open: () => openSession(def, job),
        solve: job.solve,
        decoy: job.decoy,
        identities: () => def.identities(job.world),
      })
    }
  }
  return out
}

export const defineDomain = <W, D>(def: DomainDef<W, D>): Domain => ({
  name: def.name,
  system: def.system,
  tools: def.tools,
  acting: new Set(def.acting),
  vocabulary: new Set(def.vocabulary.map((v) => v.toLowerCase())),
  templates: def.templates.map(({ id, goal, forms }) => ({ id, goal, forms })),
  instances: (seed, days, words = 'new') => generate(def, seed, days, words),
  maxSteps: def.maxSteps,
})

// ---------------------------------------------------------------------------
// Tool building blocks
// ---------------------------------------------------------------------------

export const tool = (
  name: string,
  description: string,
  properties: Record<string, ParamSpec>,
  required: string[] = Object.keys(properties),
): ToolSpec => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
})

export const text = (args: Args, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`${key} is required and must be text`)
  }
  return value.trim()
}

export const amount = (args: Args, key: string): number => {
  const value = args[key]
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new ToolError(`${key} must be a positive number`)
  }
  return n
}

export const choice = <T extends string>(args: Args, key: string, choices: readonly T[]): T => {
  const value = text(args, key).toLowerCase()
  const hit = choices.find((c) => c === value)
  if (hit === undefined) {
    throw new ToolError(`${key} must be one of ${choices.join(', ')}`)
  }
  return hit
}

export const cents = (dollars: number): number => Math.round(dollars * 100)

export const dollars = (c: number): number => c / 100

export const usd = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ---------------------------------------------------------------------------
// Checker building blocks. Each guard returns null when it holds, or the reason it does not.
// ---------------------------------------------------------------------------

export const verdict = (...problems: (string | null)[]): Check => {
  const problem = problems.find((p): p is string => p !== null)
  return problem === undefined ? { pass: true, reason: 'ok' } : { pass: false, reason: problem }
}

/** Every effect must be one of the allowed (tool, target) pairs. */
export const onlyEffects = (
  effects: readonly Effect[],
  allowed: readonly (readonly [string, string])[],
): string | null => {
  const stray = effects.find((e) => !allowed.some(([t, target]) => t === e.tool && target === e.target))
  return stray === undefined ? null : `${stray.tool} on ${stray.target} was not asked for`
}

export const numbersIn = (words: string): number[] =>
  (words.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')))

export const saysAmount = (words: string, value: number): boolean =>
  numbersIn(words).some((n) => Math.abs(n - value) < 0.005)

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** Every match of a global pattern in the words, in the order they appear. */
export const allOf = (words: string, pattern: RegExp): string[] => [...words.matchAll(pattern)].map((m) => m[0])

/** Money in words: a dollar amount or a number with cents, never an id or a date. */
export const amountsIn = (words: string): number[] =>
  allOf(words, /\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*\.\d+/g).map((m) => Number(m.replace(/[$,\s]/g, '')))

/** Whole counts in words, as digits or as the words zero to ten, in the order they appear. */
export const countsIn = (words: string): number[] =>
  allOf(words.toLowerCase(), new RegExp(`\\b(?:\\d+|${COUNT_WORDS.join('|')})\\b`, 'g')).map((w) =>
    COUNT_WORDS.includes(w) ? COUNT_WORDS.indexOf(w) : Number(w),
  )

/** Which of the names the words mention first; case is ignored. */
export const firstNamed = (words: string, names: readonly string[]): string | undefined => {
  const hay = words.toLowerCase()
  const found = names.map((name) => [hay.indexOf(name.toLowerCase()), name] as const).filter(([at]) => at !== -1)
  return found.sort(([a], [b]) => a - b)[0]?.[1]
}

/** A reply is read by its first value of the asked kind, so a swap or a hedge that leads with another fails. */
export const firstIs = <T>(found: readonly T[], want: (value: T) => boolean): boolean => {
  const first = found[0]
  return first !== undefined && want(first)
}

export const says = (words: string, needle: string): boolean => words.toLowerCase().includes(needle.toLowerCase())

export const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

// ---------------------------------------------------------------------------
// Shared vocabularies. People are drawn as first + last; a domain never reuses a full name.
// ---------------------------------------------------------------------------

export const listOf = (spaced: string): readonly string[] => spaced.trim().split(/\s+/)

export const FIRST_NAMES = listOf(`
  Ada Amir Ana Ari Beatriz Bo Chen Dana Dev Elif Emeka Esme Farah Felix Gita Hana Hugo Ines Ivan Jae
  Jonas Kaito Kemi Lars Leila Lina Malik Mara Mateo Nadia Nico Noor Omar Oona Priya Quinn Rafael Rosa
  Sami Sofia Tariq Tess Uma Vera Wei Yara Yusuf Zoe
`)

export const LAST_NAMES = listOf(`
  Abara Bauer Castillo Dahl Eriksen Fontaine Garcia Haddad Ibarra Jensen Kowalski Lindqvist Moreau
  Nakamura Okafor Petrov Quintero Rahman Silva Tanaka Ueda Varga Weber Xu Yilmaz Zielinski Adeyemi
  Brennan Costa Dubois Engel Ferreira Gallo Horvat Iyer Jovanovic Kaur Laine Mensah Novak Ortiz Park
  Rossi Sato Toivonen Ulloa Vasquez Wolfe
`)

export const MAIL_HOSTS = listOf('mail.test post.test inbox.test letters.test')

/** Plain words for names of files, folders, tags and phrases. No word here is a prefix of another. */
export const WORDS = listOf(`
  amber birch cedar delta ember fjord garnet harbor indigo juniper kestrel lagoon maple nectar onyx
  pebble quartz raven sable timber umber velvet willow yarrow zephyr acorn basalt canyon dune falcon
  glacier heron iris jasper kelp lark meadow nutmeg orchid prairie quill saffron thistle tundra valley
  walnut alder bramble cobalt dahlia fern granite hazel ivory jade lotus marble nimbus pine quince
  russet slate topaz upland violet wren aspen beacon coral flint grove haven inlet jetty knoll ledge
  mesa oasis pier ridge summit tide vista wharf zenith bayou clover dusk estuary forge gully hollow
  islet lantern mantle nook orbit plume rapids spruce
`)

export const person = (rng: Rng, last?: string): { name: string; email: string } => {
  const first = rng.pick(FIRST_NAMES)
  const surname = last ?? rng.pick(LAST_NAMES)
  return { name: `${first} ${surname}`, email: `${first}.${surname}@${rng.pick(MAIL_HOSTS)}`.toLowerCase() }
}

export const surnameOf = (name: string): string => need(name.split(' ').at(-1), `a surname in ${name}`)
