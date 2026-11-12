import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOMAINS, domainNamed } from '../tasks/domains.ts'
import type { FilesWorld } from '../tasks/files-ops/tools.ts'
import type { JobsWorld } from '../tasks/long-jobs/tools.ts'
import type { Call, Domain, Instance, Session, Words } from '../tasks/shared.ts'
import { DAYS, numbersIn, usd } from '../tasks/shared.ts'
import type { SupportWorld } from '../tasks/support-ops/tools.ts'

const SEEDS = [1, 20261014]

const isError = (result: unknown): boolean => typeof result === 'object' && result !== null && 'error' in result

const play = (inst: Instance, calls: readonly Call[]): { session: Session; errors: unknown[] } => {
  const session = inst.open()
  const errors = calls.map((c) => session.call(c.tool, c.args)).filter(isError)
  return { session, errors }
}

const slotsOf = (form: string): string[] => [...form.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort()

const actingCalls = (domain: Domain, calls: readonly Call[]): number[] =>
  calls.flatMap((c, i) => (domain.acting.has(c.tool) ? [i] : []))

/** Arguments that name the record a call acts on; every other argument is a value. */
const TARGET_ARGS = new Set(['path', 'order_id', 'ticket_id', 'customer_id', 'to'])

const otherValue = (key: string, value: unknown, enumOf: readonly string[] | undefined): unknown => {
  if (TARGET_ARGS.has(key)) {
    return value
  }
  if (enumOf !== undefined) {
    return enumOf.find((e) => e !== value) ?? value
  }
  if (typeof value === 'number') {
    return 0.01
  }
  return String(value).includes('@') ? 'someone.else@example.test' : 'something-else'
}

/** The same call on the same record, with every value replaced by another a tool accepts. */
const otherValues = (domain: Domain, call: Call): Call => {
  const spec = domain.tools.find((t) => t.function.name === call.tool)
  const args: Call['args'] = {}
  for (const [key, value] of Object.entries(call.args)) {
    args[key] = otherValue(key, value, spec?.function.parameters.properties[key]?.enum)
  }
  return { tool: call.tool, args }
}

const listLengths = (value: unknown): number[] => {
  if (Array.isArray(value)) {
    return [value.length, ...value.flatMap(listLengths)]
  }
  return typeof value === 'object' && value !== null ? Object.values(value).flatMap(listLengths) : []
}

const snapshot = (instances: readonly Instance[]): string =>
  JSON.stringify(
    instances.map(({ id, day, form, ask, slots, world, drawn }) => ({ id, day, form, ask, slots, world, drawn })),
  )

describe.each(DOMAINS.map((d) => [d.name, d] as const))('%s', (_, domain) => {
  it('offers 8 to 10 tools in the OpenAI function form, each named once', () => {
    expect(domain.tools.length).toBeGreaterThanOrEqual(8)
    expect(domain.tools.length).toBeLessThanOrEqual(10)
    const names = domain.tools.map((t) => t.function.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of domain.tools) {
      expect(t.type).toBe('function')
      expect(t.function.name).toMatch(/^[a-z_]+$/)
      expect(t.function.description.length).toBeGreaterThan(10)
      expect(t.function.parameters.type).toBe('object')
      const keys = Object.keys(t.function.parameters.properties)
      expect(keys.length).toBeGreaterThan(0)
      expect(t.function.parameters.required.every((k) => keys.includes(k))).toBe(true)
      for (const p of Object.values(t.function.parameters.properties)) {
        expect(['string', 'number']).toContain(p.type)
        expect(p.description.length).toBeGreaterThan(0)
      }
    }
    expect([...domain.acting].every((a) => names.includes(a))).toBe(true)
  })

  it('has 20 templates, each with at least five distinct phrasings carrying the same slots', () => {
    expect(domain.templates).toHaveLength(20)
    expect(new Set(domain.templates.map((t) => t.id)).size).toBe(20)
    for (const t of domain.templates) {
      expect(t.goal.length).toBeGreaterThan(10)
      expect(t.forms.length).toBeGreaterThanOrEqual(5)
      expect(new Set(t.forms).size).toBe(t.forms.length)
      const first = slotsOf(t.forms[0] ?? '')
      expect(first.length).toBeGreaterThan(0)
      for (const form of t.forms) {
        expect({ template: t.id, slots: slotsOf(form) }).toEqual({ template: t.id, slots: first })
      }
    }
  })

  it('refuses a day count outside 1 to 4', () => {
    expect(() => domain.instances(1, 0)).toThrow(/days/)
    expect(() => domain.instances(1, DAYS + 1)).toThrow(/days/)
  })

  it('answers an unknown tool and a non-object argument with an error, not a throw', () => {
    const session = domain.instances(1, 1)[0]?.open()
    expect(session?.call('no_such_tool', {})).toEqual({ error: 'there is no tool named no_such_tool' })
    expect(session?.call(domain.tools[0]?.function.name ?? '', [])).toEqual({
      error: 'arguments must be a JSON object',
    })
    expect(session?.effects).toEqual([])
  })

  describe.each(SEEDS)('seed %i', (seed) => {
    const all = domain.instances(seed, DAYS)

    it('makes 20 instances a day, one per template, in template order, ids unique', () => {
      expect(all).toHaveLength(20 * DAYS)
      for (let day = 1; day <= DAYS; day++) {
        const today = all.filter((i) => i.day === day)
        expect(today.map((i) => i.template)).toEqual(domain.templates.map((t) => t.id))
      }
      expect(new Set(all.map((i) => i.id)).size).toBe(all.length)
      expect(all.filter((i) => i.ask.includes('{') || i.ask.includes('}'))).toEqual([])
    })

    it('is deterministic for a seed, and its first days are the shorter run', () => {
      expect(snapshot(domain.instances(seed, DAYS))).toBe(snapshot(all))
      expect(snapshot(domain.instances(seed, 2))).toBe(snapshot(all.slice(0, 40)))
      expect(snapshot(domain.instances(seed + 1, DAYS))).not.toBe(snapshot(all))
    })

    it('asks each template in a different phrasing every day', () => {
      for (const t of domain.templates) {
        const days = all.filter((i) => i.template === t.id)
        expect(new Set(days.map((i) => i.form)).size).toBe(DAYS)
        expect(new Set(days.map((i) => i.ask)).size).toBe(DAYS)
      }
    })

    it('never uses an identifying value in two instances', () => {
      const owner = new Map<string, string>()
      const shared: string[] = []
      for (const inst of all) {
        expect(inst.drawn.length).toBeGreaterThan(0)
        for (const value of inst.drawn) {
          const key = value.toLowerCase()
          const before = owner.get(key)
          if (before !== undefined && before !== inst.id) {
            shared.push(`${value} in ${before} and ${inst.id}`)
          }
          owner.set(key, inst.id)
        }
      }
      expect(shared).toEqual([])
    })

    it('draws every identifying value its world holds, so the check above sees all of them', () => {
      const undrawn = all.flatMap((inst) => {
        const drawn = new Set(inst.drawn.map((v) => v.toLowerCase()))
        const identities = inst.identities()
        expect(identities.length).toBeGreaterThan(3)
        return identities.filter((v) => !drawn.has(v.toLowerCase())).map((v) => `${inst.id}: ${v}`)
      })
      expect(undrawn).toEqual([])
    })

    it('fills every slot of an ask from drawn values or the fixed vocabulary', () => {
      const stray = all.flatMap((inst) => {
        const drawn = inst.drawn.map((v) => v.toLowerCase())
        return Object.entries(inst.slots)
          .filter(([, raw]) => {
            const value = raw.toLowerCase()
            const known = domain.vocabulary.has(value) || /^\d+(\.\d+)?$/.test(value)
            return !known && !drawn.some((d) => value.includes(d))
          })
          .map(([slot, raw]) => `${inst.id}: {${slot}} = ${raw}`)
      })
      expect(stray).toEqual([])
    })

    it('passes every reference solution, with no tool refusing a call', () => {
      const failures = all.flatMap((inst) => {
        const { calls, reply } = inst.solve()
        const { session, errors } = play(inst, calls)
        const check = session.check(reply)
        return errors.length === 0 && check.pass ? [] : [{ id: inst.id, errors, reason: check.reason }]
      })
      expect(failures).toEqual([])
    })

    it('fails every empty run', () => {
      const passed = all.filter((inst) => inst.open().check('').pass).map((i) => i.id)
      expect(passed).toEqual([])
    })

    it('fails when the last acting call is dropped', () => {
      const acting = all.filter((inst) => actingCalls(domain, inst.solve().calls).length > 0)
      expect(acting).toHaveLength(16 * DAYS)
      const passed = acting.filter((inst) => {
        const { calls, reply } = inst.solve()
        const last = actingCalls(domain, calls).at(-1)
        return play(
          inst,
          calls.filter((_, i) => i !== last),
        ).session.check(reply).pass
      })
      expect(passed.map((i) => i.id)).toEqual([])
    })

    it('fails when a decoy acting call is added, and the decoy really acts', () => {
      const problems = all.flatMap((inst) => {
        const { calls, reply } = inst.solve()
        const { session } = play(inst, calls)
        const before = session.effects.length
        const decoy = inst.decoy()
        const result = session.call(decoy.tool, decoy.args)
        if (isError(result) || session.effects.length !== before + 1) {
          return [`${inst.id}: the decoy did not act (${JSON.stringify(result)})`]
        }
        return session.check(reply).pass ? [`${inst.id}: passed with the decoy`] : []
      })
      expect(problems).toEqual([])
    })

    it('fails when a decoy takes the place of the last acting call', () => {
      const passed = all.filter((inst) => {
        const { calls, reply } = inst.solve()
        const last = actingCalls(domain, calls).at(-1)
        const swapped = calls.map((c, i) => (i === last ? inst.decoy() : c))
        return last !== undefined && play(inst, swapped).session.check(reply).pass
      })
      expect(passed.map((i) => i.id)).toEqual([])
    })

    it('fails when the last acting call is made again on the same record with other values', () => {
      let acted = 0
      const passed = all.filter((inst) => {
        const { calls, reply } = inst.solve()
        const last = calls[actingCalls(domain, calls).at(-1) ?? -1]
        if (last === undefined) {
          return false
        }
        const { session } = play(inst, calls)
        const before = session.effects.length
        const again = otherValues(domain, last)
        session.call(again.tool, again.args)
        if (session.effects.length === before) {
          return false
        }
        acted += 1
        return session.check(reply).pass
      })
      expect(passed.map((i) => i.id)).toEqual([])
      expect(acted).toBeGreaterThanOrEqual(8 * DAYS)
    })

    it('states nothing in a reference answer that its reference calls did not return', () => {
      const blind = all.flatMap((inst) => {
        const { calls, reply } = inst.solve()
        if (actingCalls(domain, calls).length > 0) {
          return []
        }
        const session = inst.open()
        const results = calls.map((c) => session.call(c.tool, c.args))
        // All a reader of the results could say: their text, and how long each list in them is.
        const shown = [...results.map((r) => JSON.stringify(r)), ...results.flatMap(listLengths)].join('\n')
        const numbers = new Set(numbersIn(shown))
        const named = [...reply.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\/[\w./-]*\.txt\b/g)].map((m) => m[0])
        const unseen = [
          ...numbersIn(reply)
            .filter((n) => !numbers.has(n))
            .map(String),
          ...named.filter((value) => !shown.includes(value)),
        ]
        return unseen.length === 0 ? [] : [`${inst.id}: ${unseen.join(', ')}`]
      })
      expect(all.filter((inst) => actingCalls(domain, inst.solve().calls).length === 0)).toHaveLength(4 * DAYS)
      expect(blind).toEqual([])
    })

    it('fails a question answered without the fact it asked for', () => {
      const questions = all.filter((inst) => actingCalls(domain, inst.solve().calls).length === 0)
      expect(questions).toHaveLength(4 * DAYS)
      const passed = questions.filter((inst) => play(inst, inst.solve().calls).session.check('Done.').pass)
      expect(passed.map((i) => i.id)).toEqual([])
    })
  })
})

interface Asked {
  id: string
  form: number
  ask: string
}

/** The seed-1 asks of each domain's first three templates, written before the words setting existed. */
const PINNED = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'seed-1-asks.json'), 'utf8'),
) as Asked[]

const firstThree = (domain: Domain, instances: readonly Instance[]): Asked[] => {
  const first = new Set(domain.templates.slice(0, 3).map((t) => t.id))
  return instances.filter((i) => first.has(i.template)).map(({ id, form, ask }) => ({ id, form, ask }))
}

describe('the words a run asks in', () => {
  it('asks a default run, and a new-words run, exactly as it asked before the setting existed', () => {
    expect(PINNED).toHaveLength(36)
    expect(DOMAINS.flatMap((d) => firstThree(d, d.instances(1, DAYS)))).toEqual(PINNED)
    expect(DOMAINS.flatMap((d) => firstThree(d, d.instances(1, DAYS, 'new')))).toEqual(PINNED)
  })

  it('refuses any words but new or same', () => {
    for (const domain of DOMAINS) {
      for (const words of ['Same', 'NEW', 'reused', '']) {
        expect(() => domain.instances(1, 1, words as Words)).toThrow(/words must be new or same/)
      }
    }
  })

  const cases = DOMAINS.flatMap((d) => SEEDS.map((seed) => [d.name, seed, d] as const))
  describe.each(cases)('%s, seed %i', (_, seed, domain) => {
    const fresh = domain.instances(seed, DAYS, 'new')
    const same = domain.instances(seed, DAYS, 'same')

    it('asks each job in its day-1 phrasing every day under same, and in a new one each day under new', () => {
      for (const t of domain.templates) {
        const formsIn = (list: readonly Instance[]): number[] =>
          list.filter((i) => i.template === t.id).map((i) => i.form)
        const day1 = fresh.find((i) => i.template === t.id && i.day === 1)?.form
        expect({ template: t.id, forms: formsIn(same) }).toEqual({ template: t.id, forms: Array(DAYS).fill(day1) })
        expect(new Set(formsIn(fresh)).size).toBe(DAYS)
      }
    })

    it('changes only the phrasing under same: day 1 as before, every later day the same data as before', () => {
      const data = (list: readonly Instance[]) =>
        list.map(({ id, day, template, slots, world, drawn }) => ({ id, day, template, slots, world, drawn }))
      expect(data(same)).toEqual(data(fresh))
      const day1 = (list: readonly Instance[]): Asked[] =>
        list.filter((i) => i.day === 1).map(({ id, form, ask }) => ({ id, form, ask }))
      expect(day1(same)).toEqual(day1(fresh))
    })

    it('asks every job under same with data no other job holds, so no two asks are alike', () => {
      const owners = new Map<string, Set<string>>()
      for (const inst of same) {
        for (const value of inst.drawn) {
          const key = value.toLowerCase()
          owners.set(key, new Set([...(owners.get(key) ?? []), inst.id]))
        }
      }
      expect([...owners].filter(([, ids]) => ids.size > 1)).toEqual([])
      expect(new Set(same.map((i) => i.ask)).size).toBe(same.length)
    })
  })
})

const instancesOf = (domain: string, template: string): Instance[] =>
  SEEDS.flatMap((seed) => domainNamed(domain).instances(seed, DAYS)).filter((i) => i.template === template)

describe('an ask that reads one way', () => {
  it('fails a newest-order answer with the wrong status, even when it says the order was placed', () => {
    const passed = instancesOf('support-ops', 'talk-latest-status').filter((inst) => {
      const [, id, status] = /newest order is (\S+), and it is (\w+)/.exec(inst.solve().reply) ?? []
      const wrong = ['processing', 'shipped', 'delivered'].find((s) => s !== status)
      const { session } = play(inst, inst.solve().calls)
      return session.check(`The newest order they placed is ${id}, and it is ${wrong}.`).pass
    })
    expect(passed.map((i) => i.id)).toEqual([])
  })

  it('asks to refund an item only where the order holds one of it', () => {
    const doubles = instancesOf('support-ops', 'refund-item').filter((inst) => {
      const order = (inst.world as SupportWorld).orders.find((o) => o.id === inst.slots.order)
      return order?.items.find((item) => item.name === inst.slots.item)?.qty !== 1
    })
    expect(doubles.map((i) => i.id)).toEqual([])
  })

  it('never puts a full stop right after a value a field must copy', () => {
    const stuck = ['owner-from-text', 'client-from-text'].flatMap((template) =>
      instancesOf('files-ops', template).filter((inst) => {
        const value = String(inst.solve().calls.at(-1)?.args.value)
        const read = inst.open().call('read_file', { path: inst.slots.file }) as { content: string }
        return read.content.includes(`${value}.`)
      }),
    )
    expect(stuck.map((i) => i.id)).toEqual([])
  })
})

const supportWorld = (inst: Instance): SupportWorld => inst.world as SupportWorld
const filesWorld = (inst: Instance): FilesWorld => inst.world as FilesWorld
const jobsWorld = (inst: Instance): JobsWorld => inst.world as JobsWorld

/** The vendor's largest received order, which is larger than every order still waiting on it. */
const biggerReceived = (inst: Instance) =>
  jobsWorld(inst)
    .orders.filter((o) => o.vendor_id === inst.slots.vendor && o.status === 'received')
    .sort((a, b) => b.total - a.total)[0]

/** The two figures a budget file states: this year's, and last year's beside it. */
const budgetOf = (inst: Instance): string => /The budget is (\$[\d,]+\.\d\d)/.exec(inst.solve().reply)?.[1] ?? ''
const lastYear = (inst: Instance): string =>
  /Last year: (\$[\d,]+\.\d\d)/.exec(
    filesWorld(inst).files.find((f) => f.path === inst.slots.file)?.content ?? '',
  )?.[1] ?? ''

const after = (wrong: unknown, inst: Instance): string => `${String(wrong)}, or rather: ${inst.solve().reply}`

/** For each question, a reply that names a wrong value of the asked kind, from the instance's own world, first. */
const HEDGES: readonly (readonly [string, string, (inst: Instance) => string])[] = [
  [
    'support-ops',
    'talk-order-total',
    (inst) => after(usd(supportWorld(inst).orders.find((o) => o.id === inst.slots.order)?.items[0]?.price ?? 0), inst),
  ],
  [
    'support-ops',
    'talk-latest-status',
    (inst) => {
      const newest = /O-\d+/.exec(inst.solve().reply)?.[0]
      const orders = supportWorld(inst).orders
      const owner = orders.find((o) => o.id === newest)?.customer_id
      return after(orders.find((o) => o.customer_id === owner && o.id !== newest)?.id, inst)
    },
  ],
  [
    'support-ops',
    'talk-postcode',
    (inst) => {
      const customers = supportWorld(inst).customers
      const target = customers.find((c) => c.email === inst.slots.email)
      const surname = target?.name.split(' ').at(-1) ?? ''
      return after(customers.find((c) => c !== target && c.name.endsWith(` ${surname}`))?.address.postcode, inst)
    },
  ],
  [
    'support-ops',
    'talk-order-items',
    (inst) => {
      const orders = supportWorld(inst).orders
      const mine = orders.find((o) => o.id === inst.slots.order)?.items.map((item) => item.name) ?? []
      return after(orders.flatMap((o) => o.items).find((item) => !mine.includes(item.name))?.name, inst)
    },
  ],
  ['files-ops', 'talk-budget', (inst) => after(lastYear(inst), inst)],
  ['files-ops', 'talk-count', (inst) => after(Number(/holds (\d+) files/.exec(inst.solve().reply)?.[1]) + 1, inst)],
  [
    'files-ops',
    'talk-search',
    (inst) => {
      const target = /It is (\S+)\./.exec(inst.solve().reply)?.[1]
      return after(
        filesWorld(inst).files.find((f) => f.content.startsWith('Summary of the') && f.path !== target)?.path,
        inst,
      )
    },
  ],
  [
    'files-ops',
    'talk-shared-with',
    (inst) => {
      const other = filesWorld(inst).files.find((f) => f.path !== inst.slots.file && f.shared.length > 0)
      return `${inst.solve().reply} And ${String(other?.shared[0]?.email)}.`
    },
  ],
  ['long-jobs', 'talk-largest-order', (inst) => after(biggerReceived(inst)?.id, inst)],
  [
    'long-jobs',
    'talk-dearest-item',
    (inst) => after([...jobsWorld(inst).items].sort((a, b) => b.price - a.price)[0]?.name, inst),
  ],
  [
    'long-jobs',
    'talk-who-asked-largest',
    (inst) => {
      const bigger = biggerReceived(inst)
      return after(jobsWorld(inst).requests.find((r) => r.id === bigger?.request_id)?.requester.email, inst)
    },
  ],
  [
    'long-jobs',
    'talk-held-items',
    (inst) => {
      const w = jobsWorld(inst)
      const statusOf = (item: string): string | undefined =>
        w.vendors.find((v) => v.id === w.items.find((i) => i.name === item)?.vendor_id)?.status
      const lines = w.requests.find((r) => r.id === inst.slots.request)?.lines ?? []
      return after(lines.find((l) => statusOf(l.item) === 'active')?.item, inst)
    },
  ],
]

describe('a question answered with the look-alike first', () => {
  it('fails every question answered with a wrong value of the asked kind named first', () => {
    const questions = DOMAINS.flatMap((d) =>
      d
        .instances(1, 1)
        .filter((i) => actingCalls(d, i.solve().calls).length === 0)
        .map((i) => `${d.name}/${i.template}`),
    )
    expect(HEDGES.map(([d, t]) => `${d}/${t}`).sort()).toEqual(questions.sort())
    // talk-order-total takes its total anywhere in the reply since 2026-10-29: its hedge is not held to first.
    const passed = HEDGES.filter(
      ([domain, template]) => `${domain}/${template}` !== 'support-ops/talk-order-total',
    ).flatMap(([domain, template, hedge]) =>
      instancesOf(domain, template)
        .filter((inst) => play(inst, inst.solve().calls).session.check(hedge(inst)).pass)
        .map((inst) => inst.id),
    )
    expect(passed).toEqual([])
  })

  it('fails a budget answer that swaps this year and last year', () => {
    const budgets = instancesOf('files-ops', 'talk-budget')
    expect(budgets.every((inst) => budgetOf(inst) !== '' && lastYear(inst) !== '')).toBe(true)
    const passed = budgets.filter(
      (inst) => inst.open().check(`The budget is ${lastYear(inst)}; last year it was ${budgetOf(inst)}.`).pass,
    )
    expect(passed.map((i) => i.id)).toEqual([])
  })

  it('passes a budget answer that gives last year after this year', () => {
    const failed = instancesOf('files-ops', 'talk-budget').filter(
      (inst) => !inst.open().check(`The budget is ${budgetOf(inst)}; last year it was ${lastYear(inst)}.`).pass,
    )
    expect(failed.map((i) => i.id)).toEqual([])
  })
})
