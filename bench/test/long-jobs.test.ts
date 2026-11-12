import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOMAINS, domainNamed } from '../tasks/domains.ts'
import type { JobsWorld } from '../tasks/long-jobs/tools.ts'
import { ITEM_NAMES, SIZES, wordsOf } from '../tasks/long-jobs/tools.ts'
import type { Call, Instance } from '../tasks/shared.ts'
import { DAYS, need } from '../tasks/shared.ts'

const SEEDS = [1, 2]

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..')

const domain = domainNamed('long-jobs')

const isError = (result: unknown): boolean => typeof result === 'object' && result !== null && 'error' in result

const play = (inst: Instance, calls: readonly Call[]) => {
  const session = inst.open()
  return { session, results: calls.map((c) => session.call(c.tool, c.args)) }
}

/** Arguments that carry an id or an address, which a model can only know from the ask or from a result. */
const ID_ARGS = ['order_id', 'vendor_id', 'request_id', 'sku', 'to']

/** A search's text is a catalog name a request line gave, so it is held to the same rule. */
const isSourced = (c: Call, key: string): boolean =>
  ID_ARGS.includes(key) || (c.tool === 'find_items' && key === 'text')

/** The sourced arguments that neither the ask nor an earlier call's result holds, and how many came from a result. */
const sourcing = (
  ask: string,
  calls: readonly Call[],
  results: readonly unknown[],
): { unseen: string[]; fromResults: number } => {
  const unseen: string[] = []
  let fromResults = 0
  calls.forEach((c, i) => {
    const shown = results
      .slice(0, i)
      .map((r) => JSON.stringify(r))
      .join('\n')
    for (const [key, value] of Object.entries(c.args)) {
      if (!isSourced(c, key) || typeof value !== 'string' || ask.includes(value)) {
        continue
      }
      if (shown.includes(value)) {
        fromResults += 1
      } else {
        unseen.push(`call ${i + 1} ${c.tool} ${key} ${value}`)
      }
    }
  })
  return { unseen, fromResults }
}

describe('long-jobs', () => {
  it('is the third domain, after the two it leaves as they were', () => {
    expect(DOMAINS.map((d) => d.name)).toEqual(['support-ops', 'files-ops', 'long-jobs'])
  })

  it('states every job in the README with the tool calls its reference solution takes', () => {
    const readme = readFileSync(join(BENCH, 'README.md'), 'utf8')
    const missing = domain
      .instances(1, 1)
      .map((inst) => `| \`${inst.template}\` | ${inst.solve().calls.length} |`)
      .filter((row) => !readme.includes(row))
    expect(missing).toEqual([])
  })

  it('names catalog items so that no word is in two names, and no size word is in any', () => {
    const owner = new Map<string, string>()
    const shared: string[] = []
    for (const name of ITEM_NAMES) {
      for (const word of wordsOf(name)) {
        const before = owner.get(word)
        if (before !== undefined) {
          shared.push(`${word} in ${before} and ${name}`)
        }
        owner.set(word, name)
      }
    }
    expect(shared).toEqual([])
    expect(SIZES.flatMap(wordsOf).filter((w) => owner.has(w))).toEqual([])
  })

  it('flags an id or a search no earlier result gave, and counts one an earlier result gave', () => {
    const ask = 'Raise request RQ-11111.'
    const calls: Call[] = [
      { tool: 'get_request', args: { request_id: 'RQ-11111' } },
      { tool: 'create_order', args: { vendor_id: 'V-2222', request_id: 'RQ-11111' } },
    ]
    expect(sourcing(ask, calls, [{ id: 'RQ-11111' }, {}])).toEqual({
      unseen: ['call 2 create_order vendor_id V-2222'],
      fromResults: 0,
    })
    expect(sourcing(ask, calls, [{ id: 'RQ-11111', vendor_id: 'V-2222' }, {}])).toEqual({ unseen: [], fromResults: 1 })
    const search: Call[] = [{ tool: 'find_items', args: { text: 'Desk Lamp' } }]
    expect(sourcing(ask, search, [{}])).toEqual({ unseen: ['call 1 find_items text Desk Lamp'], fromResults: 0 })
  })

  describe.each(SEEDS)('seed %i', (seed) => {
    const all = domain.instances(seed, DAYS)

    it('takes 8 to 15 tool calls in every reference solution, the same number every day', () => {
      const counts = new Map<string, number[]>()
      for (const inst of all) {
        counts.set(inst.template, [...(counts.get(inst.template) ?? []), inst.solve().calls.length])
      }
      expect(counts.size).toBe(20)
      const off = [...counts]
        .filter(([, n]) => n.some((c) => c < 8 || c > 15 || c !== n[0]))
        .map(([template, n]) => `${template}: ${n.join(', ')}`)
      expect(off).toEqual([])
    })

    it('passes every reference through its own checker with no tool refusing, and fails it once the decoy acts', () => {
      const problems = all.flatMap((inst) => {
        const { calls, reply } = inst.solve()
        const { session, results } = play(inst, calls)
        const refused = results.filter(isError)
        if (refused.length > 0) {
          return [`${inst.id}: refused ${JSON.stringify(refused)}`]
        }
        const check = session.check(reply)
        if (!check.pass) {
          return [`${inst.id}: ${check.reason}`]
        }
        const decoy = inst.decoy()
        if (isError(session.call(decoy.tool, decoy.args))) {
          return [`${inst.id}: the decoy was refused`]
        }
        return session.check(reply).pass ? [`${inst.id}: passed with the decoy`] : []
      })
      expect(problems).toEqual([])
    })

    it('takes every id and search it passes to a tool from the ask or an earlier result, at least one from a result', () => {
      const problems = all.flatMap((inst) => {
        const { calls } = inst.solve()
        const { unseen, fromResults } = sourcing(inst.ask, calls, play(inst, calls).results)
        return [
          ...unseen.map((u) => `${inst.id}: ${u}`),
          ...(fromResults === 0 ? [`${inst.id}: no id came from a result`] : []),
        ]
      })
      expect(problems).toEqual([])
    })

    it('fails a mailing job whose emails reach the right people but leave out what was asked', () => {
      const mailing = all.filter((inst) => inst.solve().calls.some((c) => c.tool === 'send_email'))
      expect(mailing).toHaveLength(11 * DAYS)
      const passed = mailing.filter((inst) => {
        const { calls, reply } = inst.solve()
        const blank = calls.map((c) =>
          c.tool === 'send_email' ? { tool: c.tool, args: { ...c.args, text: 'Done.' } } : c,
        )
        return play(inst, blank).session.check(reply).pass
      })
      expect(passed.map((i) => i.id)).toEqual([])
    })

    it('fails an email that also carries an order number other than its own', () => {
      const cases = all.filter((inst) =>
        ['raise-and-tell', 'receive-and-tell', 'raise-tell-vendors', 'chase-late'].includes(inst.template),
      )
      expect(cases).toHaveLength(4 * DAYS)
      const passed = cases.filter((inst) => {
        const { calls, reply } = inst.solve()
        const w = inst.world as JobsWorld
        const ids = [...new Set([...w.orders.map((o) => o.id), ...w.next_ids])]
        const mixed = calls.map((c) =>
          c.tool === 'send_email' ? { tool: c.tool, args: { ...c.args, text: `Orders ${ids.join(', ')}.` } } : c,
        )
        return play(inst, mixed).session.check(reply).pass
      })
      expect(passed.map((i) => i.id)).toEqual([])
    })

    it('fails an email that names every item when only some are owed or left off', () => {
      const cases = all.filter((inst) =>
        ['receive-note-chase', 'raise-under-limit', 'raise-skip-held'].includes(inst.template),
      )
      expect(cases).toHaveLength(3 * DAYS)
      const passed = cases.filter((inst) => {
        const { calls, reply } = inst.solve()
        const w = inst.world as JobsWorld
        const names =
          inst.slots.order === undefined
            ? (w.requests.find((r) => r.id === inst.slots.request)?.lines ?? []).map((l) => l.item)
            : (w.orders.find((o) => o.id === inst.slots.order)?.lines ?? []).map((l) => l.item)
        const every = `Items: ${names.join(', ')}.`
        const listed = calls.map((c) =>
          c.tool === 'send_email' ? { tool: c.tool, args: { ...c.args, text: every } } : c,
        )
        return play(inst, listed).session.check(reply).pass
      })
      expect(passed.map((i) => i.id)).toEqual([])
    })

    it('fails a held-items answer that also names an item whose vendor is active', () => {
      const passed = all
        .filter((inst) => inst.template === 'talk-held-items')
        .filter((inst) => {
          const w = inst.world as JobsWorld
          const statusOf = (name: string): string | undefined =>
            w.vendors.find((v) => v.id === w.items.find((i) => i.name === name)?.vendor_id)?.status
          const names = (w.requests.find((r) => r.id === inst.slots.request)?.lines ?? []).map((l) => l.item)
          const said = [
            ...names.filter((n) => statusOf(n) === 'on hold'),
            ...names.filter((n) => statusOf(n) === 'active'),
          ]
          return play(inst, inst.solve().calls).session.check(`${said.join(' and ')} come from a vendor on hold.`).pass
        })
      expect(passed.map((i) => i.id)).toEqual([])
    })

    it('reads an item named in the singular or the plural', () => {
      const otherNumber = (name: string): string =>
        name.endsWith('s') ? name.slice(0, -1) : name.endsWith('x') ? `${name}es` : `${name}s`
      const failed = all
        .filter((inst) => ['talk-dearest-item', 'talk-held-items'].includes(inst.template))
        .filter((inst) => {
          const { calls, reply } = inst.solve()
          const w = inst.world as JobsWorld
          const names = (w.requests.find((r) => r.id === inst.slots.request)?.lines ?? []).map((l) => l.item)
          const said = names.reduce((words, n) => words.replace(n, otherNumber(n)), reply)
          return !play(inst, calls).session.check(said).pass
        })
      expect(failed.map((i) => i.id)).toEqual([])
    })

    it('finds exactly one catalog item named as each request line names it', () => {
      const problems = all.flatMap((inst) => {
        const session = inst.open()
        return (inst.world as JobsWorld).requests.flatMap((r) =>
          r.lines.flatMap((l) => {
            const found = session.call('find_items', { text: l.item }) as { name: string }[]
            return found.filter((f) => f.name === l.item).length === 1 ? [] : [`${inst.id}: ${l.item}`]
          }),
        )
      })
      expect(problems).toEqual([])
    })
  })

  it('reads a name that takes es in the plural', () => {
    const cases = Array.from({ length: 40 }, (_, i) => i + 1)
      .flatMap((seed) => domain.instances(seed, DAYS))
      .filter((inst) => ['talk-dearest-item', 'talk-held-items'].includes(inst.template))
      .filter((inst) => inst.solve().reply.includes('Shipping Box'))
    expect(cases.length).toBeGreaterThan(0)
    const failed = cases.filter((inst) => {
      const { calls, reply } = inst.solve()
      return !play(inst, calls).session.check(reply.replace('Shipping Box', 'Shipping Boxes')).pass
    })
    expect(failed.map((i) => i.id)).toEqual([])
  })

  // Each catalog name as English writes more than one; a name already plural, or with no plural, stays.
  // Written out by hand, because the plural tests above derive plurals by the s rule and cannot see an irregular one.
  const PLURAL: Record<(typeof ITEM_NAMES)[number], string> = {
    'Desk Lamp': 'Desk Lamps',
    'Paper Ream': 'Paper Reams',
    'Ink Cartridge': 'Ink Cartridges',
    Stapler: 'Staplers',
    'Whiteboard Marker': 'Whiteboard Markers',
    'Monitor Arm': 'Monitor Arms',
    'Office Chair': 'Office Chairs',
    'Filing Cabinet': 'Filing Cabinets',
    'Label Printer': 'Label Printers',
    'Shipping Box': 'Shipping Boxes',
    'Packing Tape': 'Packing Tape',
    'Bubble Wrap': 'Bubble Wrap',
    'Safety Gloves': 'Safety Gloves',
    'Hard Hat': 'Hard Hats',
    'Coffee Beans': 'Coffee Beans',
    'Water Filter': 'Water Filters',
    'Extension Cord': 'Extension Cords',
    'Laptop Stand': 'Laptop Stands',
    Keyboard: 'Keyboards',
    'Mouse Pad': 'Mouse Pads',
    Headset: 'Headsets',
    Webcam: 'Webcams',
    Toner: 'Toners',
    'Envelope Pack': 'Envelope Packs',
    'Sticky Notes': 'Sticky Notes',
    'Binder Clips': 'Binder Clips',
    'Floor Fan': 'Floor Fans',
    'Space Heater': 'Space Heaters',
    'Trash Bags': 'Trash Bags',
    'Hand Soap': 'Hand Soap',
    'Towel Rolls': 'Towel Rolls',
    'Step Ladder': 'Step Ladders',
    'Tool Kit': 'Tool Kits',
    'Cable Ties': 'Cable Ties',
    'Power Strip': 'Power Strips',
    'Storage Bin': 'Storage Bins',
    'Name Badges': 'Name Badges',
    Notebook: 'Notebooks',
    Calculator: 'Calculators',
    Scissors: 'Scissors',
    'Pencil Case': 'Pencil Cases',
    'Door Wedge': 'Door Wedges',
    'Cork Board': 'Cork Boards',
    'Wall Clock': 'Wall Clocks',
    Bandages: 'Bandages',
  }

  it('reads every catalog item named in its English plural', () => {
    const cases = Array.from({ length: 40 }, (_, i) => i + 1)
      .flatMap((seed) => domain.instances(seed, DAYS))
      .filter((inst) => ['talk-dearest-item', 'talk-held-items'].includes(inst.template))
    const reached = new Set(cases.flatMap((inst) => ITEM_NAMES.filter((n) => inst.solve().reply.includes(n))))
    expect(ITEM_NAMES.filter((n) => !reached.has(n))).toEqual([])
    const failed = cases.filter((inst) => {
      const { calls, reply } = inst.solve()
      const said = ITEM_NAMES.reduce((words, n) => words.replace(n, PLURAL[n]), reply)
      return !play(inst, calls).session.check(said).pass
    })
    expect(failed.map((i) => i.id)).toEqual([])
  })

  it('refuses at its tools what a purchasing desk refuses, and hands out new order ids in turn', () => {
    const inst = need(
      domain.instances(1, 1).find((i) => i.template === 'raise-split'),
      'a raise-split task',
    )
    const world = inst.world as JobsWorld
    const r = need(
      world.requests.find((x) => x.id === inst.slots.request),
      'its request',
    )
    const item = need(
      world.items.find((i) => i.name === r.lines[0]?.item),
      'an item it asks for',
    )
    const foreign = need(
      world.items.find((i) => i.vendor_id !== item.vendor_id),
      "another vendor's item",
    )
    const [first, second, third, fourth] = world.next_ids
    const session = inst.open()
    const steps: [string, Record<string, unknown>, unknown][] = [
      ['find_items', { text: ' - ' }, { error: 'text must hold at least one word' }],
      ['create_order', { vendor_id: item.vendor_id, request_id: r.id }, { order_id: first, status: 'draft' }],
      ['submit_order', { order_id: first }, { error: `${first} has no lines to submit` }],
      ['add_line', { order_id: first, sku: foreign.sku, qty: 1 }, { error: expect.stringContaining('not by') }],
      ['add_line', { order_id: first, sku: item.sku, qty: 1.5 }, { error: 'qty must be a whole number' }],
      ['add_line', { order_id: first, sku: item.sku, qty: 2 }, { lines: [{ sku: item.sku, qty: 2 }] }],
      ['add_line', { order_id: first, sku: item.sku, qty: 1 }, { lines: [{ sku: item.sku, qty: 3 }] }],
      ['receive_line', { order_id: first, sku: item.sku, qty: 1 }, { error: `${first} has not been submitted` }],
      ['submit_order', { order_id: first }, { status: 'submitted' }],
      [
        'receive_line',
        { order_id: first, sku: foreign.sku, qty: 1 },
        { error: `no line for ${foreign.sku} on ${first}` },
      ],
      ['add_line', { order_id: first, sku: item.sku, qty: 1 }, { error: expect.stringContaining('only a draft') }],
      ['receive_line', { order_id: first, sku: item.sku, qty: 4 }, { error: expect.stringContaining('only 3 of') }],
      ['receive_line', { order_id: first, sku: item.sku, qty: 3 }, { outstanding: 0, status: 'received' }],
      ['receive_line', { order_id: first, sku: item.sku, qty: 1 }, { error: `${first} is already received` }],
      ['submit_order', { order_id: first }, { error: `${first} is already received` }],
      ['create_order', { vendor_id: item.vendor_id, request_id: r.id }, { order_id: second }],
      ['get_vendor', { vendor_id: 'V-0000' }, { error: 'no vendor V-0000' }],
      ['get_request', { request_id: 'RQ-00000' }, { error: 'no request RQ-00000' }],
      ['get_order', { order_id: 'PO-00000' }, { error: 'no order PO-00000' }],
      ['create_order', { vendor_id: item.vendor_id, request_id: r.id }, { order_id: third }],
      ['create_order', { vendor_id: item.vendor_id, request_id: r.id }, { order_id: fourth }],
      ['create_order', { vendor_id: item.vendor_id, request_id: r.id }, { order_id: 'PO-00005' }],
      ['send_email', { to: 'not an address', text: 'hello' }, { error: 'to must be one email address' }],
    ]
    for (const [tool, args, want] of steps) {
      expect({ tool, args, got: session.call(tool, args) }).toMatchObject({ tool, args, got: want })
    }
    expect(session.effects.map((e) => `${e.tool} ${e.target}`)).toEqual([
      `create_order ${first}`,
      `add_line ${first}`,
      `add_line ${first}`,
      `submit_order ${first}`,
      `receive_line ${first}`,
      `create_order ${second}`,
      `create_order ${third}`,
      `create_order ${fourth}`,
      'create_order PO-00005',
    ])
  })
})
