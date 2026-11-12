import type { Args, Call, Template } from '../shared.ts'
import {
  allOf,
  amountsIn,
  cents,
  dollars,
  firstIs,
  need,
  onlyEffects,
  same,
  says,
  saysAmount,
  usd,
  verdict,
} from '../shared.ts'
import type { Desk, JobsDraw } from './instances.ts'
import type { Item, JobsWorld, Order, OrderStatus, PurchaseRequest, Vendor, VendorStatus } from './tools.ts'
import { orderIn, ordersOf, retotal } from './tools.ts'

type JobsTemplate = Template<JobsWorld, JobsDraw>

const call = (tool: string, args: Args): Call => ({ tool, args })

/** A line as an order should hold it. */
interface Wanted {
  sku: string
  item: string
  qty: number
}

/** One vendor's share of a request. */
interface Part {
  vendor_id: string
  lines: Wanted[]
}

const vendorIn = (world: JobsWorld, vendorId: string): Vendor =>
  need(
    world.vendors.find((v) => v.id === vendorId),
    `vendor ${vendorId}`,
  )

/** A request's lines by the vendor that sells each item, vendors in the order the request first names them. */
const partsOf = (world: JobsWorld, r: PurchaseRequest): Part[] => {
  const parts: Part[] = []
  for (const want of r.lines) {
    const item = need(
      world.items.find((i) => i.name === want.item),
      `item ${want.item}`,
    )
    let part = parts.find((p) => p.vendor_id === item.vendor_id)
    if (part === undefined) {
      part = { vendor_id: item.vendor_id, lines: [] }
      parts.push(part)
    }
    part.lines.push({ sku: item.sku, item: item.name, qty: want.qty })
  }
  return parts
}

const onlyPart = (world: JobsWorld, r: PurchaseRequest): Part => need(partsOf(world, r)[0], `a vendor for ${r.id}`)

/** What is still to come on an order, line by line. */
const outstanding = (o: Order): Wanted[] =>
  o.lines.filter((l) => l.received < l.qty).map((l) => ({ sku: l.sku, item: l.item, qty: l.qty - l.received }))

const searches = (names: readonly string[]): Call[] => names.map((name) => call('find_items', { text: name }))

/** Read a request, then search the catalog for each of its lines. */
const readLines = (r: PurchaseRequest): Call[] => [
  call('get_request', { request_id: r.id }),
  ...searches(r.lines.map((l) => l.item)),
]

const fill = (orderId: string, lines: readonly Wanted[]): Call[] =>
  lines.map((l) => call('add_line', { order_id: orderId, sku: l.sku, qty: l.qty }))

const receive = (orderId: string, lines: readonly { sku: string; qty: number }[]): Call[] =>
  lines.map((l) => call('receive_line', { order_id: orderId, sku: l.sku, qty: l.qty }))

/** An order per part, with the ids create_order hands out in turn, filled, and submitted unless told not to. */
const place = (world: JobsWorld, r: PurchaseRequest, parts: readonly Part[], submit = true): Call[] =>
  parts.flatMap((p, k) => {
    const orderId = need(world.next_ids[k], 'a new order id')
    return [
      call('create_order', { vendor_id: p.vendor_id, request_id: r.id }),
      ...fill(orderId, p.lines),
      ...(submit ? [call('submit_order', { order_id: orderId })] : []),
    ]
  })

const mail = (to: string, text: string): Call => call('send_email', { to, text })

/** A note of what came in on a delivery: a count for every line. */
const dockNote = (o: Order, came: readonly number[]): string =>
  `Dock count for today's delivery: ${o.lines.map((l, i) => `${l.item}: ${need(came[i], 'a count')}`).join('; ')}.`

// ---------------------------------------------------------------------------
// Checker guards: each returns null when it holds, or the reason it does not.
// ---------------------------------------------------------------------------

const PLACING = ['create_order', 'add_line', 'submit_order'] as const

/** The orders a session opened, in the order it opened them. */
const openedIn = (start: JobsWorld, state: JobsWorld): Order[] =>
  state.orders.filter((o) => !start.orders.some((s) => s.id === o.id))

/** The acting calls a job may make on the orders it opens. */
const onOpened = (
  start: JobsWorld,
  state: JobsWorld,
  tools: readonly string[] = PLACING,
): (readonly [string, string])[] => openedIn(start, state).flatMap((o) => tools.map((t) => [t, o.id] as const))

/** The id of the order a session opened with a vendor, for the guards that read what was sent about it. */
const openedWith = (start: JobsWorld, state: JobsWorld, vendorId: string): string =>
  openedIn(start, state).find((o) => o.vendor_id === vendorId)?.id ?? 'no order'

const linesAre = (o: Order, want: readonly Wanted[]): string | null => {
  const shown = (lines: readonly { sku: string; qty: number }[]): string =>
    lines
      .map((l) => `${l.qty} of ${l.sku}`)
      .sort()
      .join(', ') || 'no lines'
  return shown(o.lines) === shown(want) ? null : `${o.id} holds ${shown(o.lines)}, not ${shown(want)}`
}

const statusIs = (state: JobsWorld, orderId: string, status: OrderStatus): string | null => {
  const got = orderIn(state, orderId).status
  return got === status ? null : `${orderId} is ${got}, not ${status}`
}

/** One order opened per part, for the request, each holding exactly its part's lines, at this status. */
const openedAre = (
  start: JobsWorld,
  state: JobsWorld,
  requestId: string,
  parts: readonly Part[],
  status: OrderStatus,
): string | null => {
  const opened = openedIn(start, state)
  if (opened.length !== parts.length) {
    return `${opened.length} orders were opened, not ${parts.length}`
  }
  for (const p of parts) {
    const o = opened.find((x) => x.vendor_id === p.vendor_id)
    const problem =
      o === undefined
        ? `no order was opened with ${p.vendor_id}`
        : o.request_id !== requestId
          ? `${o.id} is for ${o.request_id}, not ${requestId}`
          : o.status !== status
            ? `${o.id} is ${o.status}, not ${status}`
            : linesAre(o, p.lines)
    if (problem !== null) {
      return problem
    }
  }
  return null
}

/** Each line of the order has exactly this many received. */
const receivedAre = (state: JobsWorld, orderId: string, want: readonly number[]): string | null => {
  const o = orderIn(state, orderId)
  const off = o.lines.find((l, i) => l.received !== want[i])
  return off === undefined ? null : `${o.id} has ${off.received} of ${off.item} received`
}

/** Exactly one email went to the address, and it gives what was asked. */
const mailedOnce = (state: JobsWorld, to: string, gives: (body: string) => boolean, what: string): string | null => {
  const mails = state.outbox.filter((m) => m.to === to.toLowerCase())
  if (mails.length !== 1) {
    return `${to} got ${mails.length} emails, not 1`
  }
  return gives(need(mails[0], 'an email').text) ? null : `the email to ${to} does not give ${what}`
}

const answers = (ok: boolean, what: string): string | null => (ok ? null : `the reply does not give ${what}`)

/** The kinds of value a question asks for, as they appear in a reply. */
const ORDER_ID = /\bPO-\d+\b/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

/**
 * The catalog names in the words, in order: as named, without a final s, or with s or es added.
 * A longer name wins over the one it starts with.
 */
const itemsIn = (words: string, world: JobsWorld): string[] => {
  const stem = (name: string): string => (name.endsWith('s') ? name.slice(0, -1) : name)
  const names = world.items.map((i) => i.name).sort((a, b) => b.length - a.length)
  const pattern = new RegExp(
    `\\b(${names.map((n) => stem(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:e?s)?\\b`,
    'gi',
  )
  return [...words.matchAll(pattern)].map((m) =>
    need(
      names.find((n) => same(stem(n), m[1] ?? '')),
      `the item ${m[0]}`,
    ),
  )
}

/** An email that names this order and no other. */
const namesOnly =
  (orderId: string) =>
  (body: string): boolean => {
    const ids = allOf(body.toUpperCase(), ORDER_ID)
    return ids.length > 0 && ids.every((id) => id === orderId)
  }

/** An email that names every one of these items and no other catalog item. */
const namesItems =
  (world: JobsWorld, names: readonly string[]) =>
  (body: string): boolean => {
    const said = itemsIn(body, world)
    return names.every((n) => said.includes(n)) && said.every((n) => names.includes(n))
  }

// ---------------------------------------------------------------------------
// Desks the questions share
// ---------------------------------------------------------------------------

interface Waiting {
  desk: Desk
  vendor: Vendor
  /** Submitted and not yet received, as list_orders shows them; no two at the same total. */
  waiting: Order[]
  top: Order
}

const waitingDesk = (d: JobsDraw): Waiting => {
  const desk = d.desk()
  const vendor = desk.vendor()
  const items = desk.stock(vendor, 4)
  const priceOf = (name: string): number => cents(need(items.find((i) => i.name === name)?.price, name))
  const totals = new Set<number>()
  while (totals.size < 7) {
    const wants = d.wants(d.rng.sample(items, d.rng.int(1, 2)))
    const total = wants.reduce((sum, w) => sum + priceOf(w.item) * w.qty, 0)
    if (!totals.has(total)) {
      totals.add(total)
      desk.order(vendor, desk.request(wants), 'submitted')
    }
  }
  const waiting = ordersOf(desk.world, vendor.id)
  const top = need([...waiting].sort((a, b) => b.total - a.total)[0], 'a largest order')
  const dearest = need([...items].sort((a, b) => b.price - a.price)[0], 'a dearest item')
  const qty = Math.floor(cents(top.total) / cents(dearest.price)) + d.rng.int(1, 3)
  // Already received, and larger than every waiting order: the look-alike answer.
  desk.order(
    vendor,
    desk.namesake(
      need(
        desk.world.requests.find((r) => r.id === top.request_id),
        'the request of the largest order',
      ),
      [{ item: dearest.name, qty }],
    ),
    'received',
  )
  const cheapest = need([...items].sort((a, b) => a.price - b.price)[0], 'a cheapest item')
  desk.order(vendor, desk.request([{ item: cheapest.name, qty: 1 }]), 'draft')
  return { desk, vendor, waiting, top }
}

// ---------------------------------------------------------------------------
// The twenty jobs
// ---------------------------------------------------------------------------

const raiseSplit: JobsTemplate = {
  id: 'raise-split',
  goal: 'Raise a request whose items come from two vendors: one submitted order per vendor.',
  forms: [
    'Raise purchase orders for request {request} and submit them.',
    'Request {request} is approved. Order everything on it, one order per vendor, and submit the orders.',
    'Please turn request {request} into submitted purchase orders.',
    'Place the orders for request {request} and send them to the vendors.',
    'Get request {request} ordered: open the orders it needs, add its lines and submit them.',
  ],
  make: (d) => {
    const desk = d.desk()
    const one = desk.vendor()
    const two = desk.vendor()
    const seller = desk.vendor()
    const items = [...desk.stock(one, 2), ...desk.stock(two, 2)]
    for (const item of items) {
      desk.lookalike(item, seller)
    }
    const r = desk.request(d.wants(d.rng.shuffle(items)))
    desk.namesake(r, d.wants(desk.stock(seller, 2)))
    const world = desk.world
    const parts = partsOf(world, r)
    return {
      world,
      slots: { request: r.id },
      solve: () => ({
        calls: [...readLines(r), ...place(world, r, parts)],
        reply: `Submitted ${world.next_ids.slice(0, 2).join(' and ')} for ${r.id}.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(onlyEffects(effects, onOpened(start, state)), openedAre(start, state, r.id, parts, 'submitted')),
      decoy: () => call('create_order', { vendor_id: seller.id, request_id: r.id }),
    }
  },
}

/** A request for three items of one vendor, a look-alike of each sold by another, and a namesake's request. */
const oneVendorRequest = (d: JobsDraw) => {
  const desk = d.desk()
  const vendor = desk.vendor()
  const seller = desk.vendor()
  const items = desk.stock(vendor, 3)
  for (const item of items) {
    desk.lookalike(item, seller)
  }
  const r = desk.request(d.wants(items))
  const other = desk.namesake(r, d.wants(desk.stock(seller, 2)))
  return { desk, vendor, seller, items, r, other, part: onlyPart(desk.world, r) }
}

const raiseAndTell: JobsTemplate = {
  id: 'raise-and-tell',
  goal: 'Raise a request on one submitted order and email the requester its order number.',
  forms: [
    'Order everything on request {request}, submit the order, and email the requester the new order number.',
    'Raise request {request} as a purchase order, submit it, then email the person who asked for it the order number.',
    'Please place request {request} and email its requester the number of the order it went on.',
    'Request {request} is approved: put it on an order, submit it, and email the requester the PO number.',
    'Submit an order for everything request {request} asks for, and tell the requester its number by email.',
  ],
  make: (d) => {
    const { desk, vendor, r, other, part } = oneVendorRequest(d)
    const world = desk.world
    const orderId = need(world.next_ids[0], 'a new order id')
    const text = `Your request ${r.id} is on order ${orderId}.`
    return {
      world,
      slots: { request: r.id },
      solve: () => ({
        calls: [...readLines(r), ...place(world, r, [part]), mail(r.requester.email, text)],
        reply: `Submitted ${orderId} and told ${r.requester.name}.`,
      }),
      check: ({ start, state, effects }) => {
        const opened = openedWith(start, state, vendor.id)
        return verdict(
          onlyEffects(effects, [...onOpened(start, state), ['send_email', r.requester.email]]),
          openedAre(start, state, r.id, [part], 'submitted'),
          mailedOnce(state, r.requester.email, namesOnly(opened), `the order number ${opened} and no other`),
        )
      },
      decoy: () => mail(other.requester.email, text),
    }
  },
}

const draftAndTotal: JobsTemplate = {
  id: 'draft-and-total',
  goal: 'Put a request on a draft order, leave it unsubmitted, and email the requester its total.',
  forms: [
    'Put request {request} on a draft order but do not submit it; email the requester what the order comes to.',
    'Draft an order for request {request}, leave it unsubmitted, and email the person who asked for it the total.',
    'The requester of {request} wants to see the cost first. Build a draft order for it, do not submit it, and email them the total.',
    'Create a draft purchase order holding every line of request {request}, and email its requester the order total. Do not submit it.',
    'Request {request}: make the draft order, keep it as a draft, and send the requester its total by email.',
  ],
  make: (d) => {
    const { desk, items, r, part } = oneVendorRequest(d)
    const world = desk.world
    const orderId = need(world.next_ids[0], 'a new order id')
    const total = dollars(
      part.lines.reduce(
        (sum, l) =>
          sum +
          cents(
            need(
              items.find((i) => i.sku === l.sku),
              l.sku,
            ).price,
          ) *
            l.qty,
        0,
      ),
    )
    return {
      world,
      slots: { request: r.id },
      solve: () => ({
        calls: [
          ...readLines(r),
          ...place(world, r, [part], false),
          mail(r.requester.email, `The draft order ${orderId} for your request ${r.id} comes to ${usd(total)}.`),
        ],
        reply: `Drafted ${orderId} at ${usd(total)} and emailed the requester.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(effects, [...onOpened(start, state), ['send_email', r.requester.email]]),
          openedAre(start, state, r.id, [part], 'draft'),
          mailedOnce(state, r.requester.email, (body) => saysAmount(body, total), `the total ${usd(total)}`),
        ),
      decoy: () => call('submit_order', { order_id: orderId }),
    }
  },
}

const raiseTellVendors: JobsTemplate = {
  id: 'raise-tell-vendors',
  goal: 'Raise a request across two vendors, submit both orders, and email each vendor its order number.',
  forms: [
    'Place request {request}: submit an order with each vendor it needs, and email each vendor its order number.',
    'Order everything on request {request}, submit the orders, and let every vendor know its PO number by email.',
    'Please raise request {request} as submitted orders and email each vendor the number of the order it is getting.',
    'Request {request} is approved. Submit its orders and email every vendor involved the order number that is theirs.',
    'Get request {request} ordered and submitted, then email each vendor its own order number.',
  ],
  make: (d) => {
    const desk = d.desk()
    const one = desk.vendor()
    const two = desk.vendor()
    const seller = desk.vendor()
    const items = [...desk.stock(one, 2), ...desk.stock(two, 1)]
    for (const item of items) {
      desk.lookalike(item, seller)
    }
    const r = desk.request(d.wants(d.rng.shuffle(items)))
    desk.namesake(r, d.wants(desk.stock(seller, 1)))
    const world = desk.world
    const parts = partsOf(world, r)
    const told = parts.map((p, k) => ({
      vendor: vendorIn(world, p.vendor_id),
      orderId: need(world.next_ids[k], 'a new order id'),
    }))
    const text = (orderId: string): string => `Please supply our order ${orderId}, for request ${r.id}.`
    const first = need(told[0], 'a first vendor')
    const second = need(told[1], 'a second vendor')
    return {
      world,
      slots: { request: r.id },
      solve: () => ({
        calls: [
          ...readLines(r),
          ...place(world, r, parts),
          ...told.flatMap((t) => [
            call('get_vendor', { vendor_id: t.vendor.id }),
            mail(t.vendor.email, text(t.orderId)),
          ]),
        ],
        reply: `Submitted ${first.orderId} and ${second.orderId} and emailed both vendors.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ...onOpened(start, state),
            ...told.map((t) => ['send_email', t.vendor.email] as const),
          ]),
          openedAre(start, state, r.id, parts, 'submitted'),
          ...told.map((t) => {
            const opened = openedWith(start, state, t.vendor.id)
            return mailedOnce(state, t.vendor.email, namesOnly(opened), `its order number ${opened} and no other`)
          }),
        ),
      decoy: () => mail(first.vendor.email, text(second.orderId)),
    }
  },
}

const fillDraft: JobsTemplate = {
  id: 'fill-draft',
  goal: "Put a request's lines on the empty draft its vendor already has for it, and submit that draft.",
  forms: [
    "Request {request} already has an empty draft order with its vendor. Put the request's lines on that draft and submit it; do not open a new order.",
    "There is an empty draft order waiting for request {request}. Fill it with the request's lines and submit it.",
    'Use the existing draft order for request {request}, the empty one with its vendor: add the lines and submit it.',
    'Request {request} needs ordering, and its vendor already has an empty draft for it. Fill that draft and submit it.',
    'Do not open a new order for request {request}: find the empty draft its vendor has, add the lines, and submit it.',
  ],
  make: (d) => {
    const { desk, vendor, items, r, part } = oneVendorRequest(d)
    const draft = desk.order(vendor, r, 'draft')
    draft.lines = []
    retotal(draft)
    desk.order(vendor, desk.request(d.wants(d.rng.sample(items, 2))), 'submitted')
    desk.order(vendor, desk.request(d.wants(d.rng.sample(items, 2))), 'received')
    return {
      world: desk.world,
      slots: { request: r.id },
      solve: () => ({
        calls: [
          ...readLines(r),
          call('list_orders', { vendor_id: vendor.id }),
          ...fill(draft.id, part.lines),
          call('submit_order', { order_id: draft.id }),
        ],
        reply: `Filled and submitted ${draft.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['add_line', draft.id],
            ['submit_order', draft.id],
          ]),
          statusIs(state, draft.id, 'submitted'),
          linesAre(orderIn(state, draft.id), part.lines),
        ),
      decoy: () => call('create_order', { vendor_id: vendor.id, request_id: r.id }),
    }
  },
}

/** A submitted order, its request, and an order one digit off for a namesake's request. */
const submittedOrder = (d: JobsDraw, lines: number) => {
  const desk = d.desk()
  const vendor = desk.vendor()
  const items = desk.stock(vendor, lines)
  const r = desk.request(d.wants(items, 2, 9))
  const o = desk.order(vendor, r, 'submitted')
  const other = desk.namesake(r, d.wants(d.rng.sample(items, 2)))
  const lookalike = desk.order(vendor, other, 'submitted', d.near(o.id))
  return { desk, vendor, items, r, o, other, lookalike }
}

const receiveAndTell: JobsTemplate = {
  id: 'receive-and-tell',
  goal: 'Receive every line of an order that came in complete, and email the requester its order number.',
  forms: [
    'Order {order} arrived complete today. Receive every line, then email the person who requested it that the order is in, with its number.',
    'Everything on {order} came in. Mark it all received and let the requester know by email, giving the order number.',
    'Please receive order {order} in full, then email whoever asked for it that the order has arrived, with its number.',
    'The whole of {order} was delivered. Receive each line and tell the requester by email, naming the order.',
    'Receive all of {order}; it came in complete. Then email the requester that their order is here, giving its number.',
  ],
  make: (d) => {
    const { desk, r, o, other } = submittedOrder(d, 5)
    const text = `Order ${o.id} for your request ${r.id} has arrived.`
    return {
      world: desk.world,
      slots: { order: o.id },
      solve: () => ({
        calls: [
          call('get_order', { order_id: o.id }),
          ...receive(o.id, o.lines),
          call('get_request', { request_id: r.id }),
          mail(r.requester.email, text),
        ],
        reply: `Received ${o.id} in full and told ${r.requester.name}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['receive_line', o.id],
            ['send_email', r.requester.email],
          ]),
          statusIs(state, o.id, 'received'),
          mailedOnce(state, r.requester.email, namesOnly(o.id), `the order number ${o.id} and no other`),
        ),
      decoy: () => mail(other.requester.email, text),
    }
  },
}

const receiveNoteChase: JobsTemplate = {
  id: 'receive-note-chase',
  goal: "Receive what an order's dock note says came in, and email the vendor the items still owed.",
  forms: [
    "The delivery for {order} came in short. The dock wrote what arrived on the order's note: receive that, then email the vendor the items still owed, naming no other items.",
    "Receive what the dock counted for order {order} (it is in the order's note), and email the vendor only the items that are still owed.",
    'Order {order} was only partly delivered. Record what came in, as the note on the order says, and tell the vendor by email only what is still to come.',
    'Please receive {order} as the dock note on it says, then email its vendor just the items they still owe us.',
    'The dock note on {order} lists what arrived. Receive those amounts and email the vendor only the items we are still waiting for.',
  ],
  make: (d) => {
    const { desk, vendor, o, lookalike } = submittedOrder(d, 5)
    const short = new Set(d.rng.sample(o.lines, 2).map((l) => l.sku))
    const came = o.lines.map((l) => (short.has(l.sku) ? d.rng.int(1, l.qty - 1) : l.qty))
    o.note = dockNote(o, came)
    const owed = o.lines.flatMap((l, i) =>
      short.has(l.sku) ? [{ item: l.item, qty: l.qty - need(came[i], 'a count') }] : [],
    )
    const target = need(lookalike.lines[0], 'a line on the look-alike order')
    return {
      world: desk.world,
      slots: { order: o.id },
      solve: () => ({
        calls: [
          call('get_order', { order_id: o.id }),
          ...receive(
            o.id,
            o.lines.map((l, i) => ({ sku: l.sku, qty: need(came[i], 'a count') })),
          ),
          call('get_vendor', { vendor_id: vendor.id }),
          mail(
            vendor.email,
            `Order ${o.id} came in short. Still owed: ${owed.map((l) => `${l.qty} ${l.item}`).join(', ')}.`,
          ),
        ],
        reply: `Received what came in on ${o.id} and emailed ${vendor.name} what is owed.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['receive_line', o.id],
            ['send_email', vendor.email],
          ]),
          receivedAre(state, o.id, came),
          mailedOnce(
            state,
            vendor.email,
            namesItems(
              state,
              owed.map((l) => l.item),
            ),
            'every item still owed and no other',
          ),
        ),
      decoy: () => call('receive_line', { order_id: lookalike.id, sku: target.sku, qty: 1 }),
    }
  },
}

const receiveVendorDelivery: JobsTemplate = {
  id: 'receive-vendor-delivery',
  goal: 'Receive everything outstanding on every submitted order with a vendor.',
  forms: [
    'Everything we were waiting on from vendor {vendor} arrived today. Receive all of it.',
    'Vendor {vendor} delivered every order we were still waiting on from them. Mark everything received.',
    'Please receive all outstanding goods from {vendor}; it all came in this morning.',
    'A delivery from {vendor} covered everything they still owed us. Receive every outstanding line.',
    'Receive in full every order we have submitted to vendor {vendor} that has not come in yet.',
  ],
  make: (d) => {
    const desk = d.desk()
    const vendor = desk.vendor()
    const items = desk.stock(vendor, 4)
    const made = [0, 1, 2].map(() =>
      desk.order(vendor, desk.request(d.wants(d.rng.sample(items, 2), 2, 9)), 'submitted'),
    )
    const begun = need(d.rng.pick(made).lines[0], 'a line')
    begun.received = d.rng.int(1, begun.qty - 1)
    desk.order(vendor, desk.request(d.wants(d.rng.sample(items, 2))), 'received')
    const firstRequest = need(
      desk.world.requests.find((r) => r.id === made[0]?.request_id),
      'a request',
    )
    desk.order(vendor, desk.namesake(firstRequest, d.wants(d.rng.sample(items, 1))), 'draft')
    const like = desk.vendor('active', d.near(vendor.id))
    const theirs = desk.stock(like, 2)
    const lookalike = desk.order(like, desk.request(d.wants(theirs)), 'submitted')
    const target = need(lookalike.lines[0], 'a line on the look-alike order')
    const waiting = ordersOf(desk.world, vendor.id).filter((o) => o.status === 'submitted')
    return {
      world: desk.world,
      slots: { vendor: vendor.id },
      solve: () => ({
        calls: [
          call('list_orders', { vendor_id: vendor.id }),
          ...waiting.map((o) => call('get_order', { order_id: o.id })),
          ...waiting.flatMap((o) => receive(o.id, outstanding(o))),
        ],
        reply: `Received ${waiting.map((o) => o.id).join(', ')} in full.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(
            effects,
            waiting.map((o) => ['receive_line', o.id] as const),
          ),
          ...waiting.map((o) => statusIs(state, o.id, 'received')),
        ),
      decoy: () => call('receive_line', { order_id: lookalike.id, sku: target.sku, qty: 1 }),
    }
  },
}

const reorderSame: JobsTemplate = {
  id: 'reorder-same',
  goal: 'Place an order again, line for line, and email the requester the new order number.',
  forms: [
    'Place order {order} again: same vendor, same request, same lines. Submit it and email the requester the new order number.',
    'The team behind {order} needs the same again. Raise a copy of it, submit it, and email the requester its number.',
    'Repeat order {order} exactly with the same vendor, submit the new one, and let the requester know its number by email.',
    'Please reorder everything on {order}, for the same request, then email whoever asked for it the new order number.',
    'Make a new order matching {order} line for line, submit it, and email the requester the new PO number.',
  ],
  make: (d) => {
    const desk = d.desk()
    const vendor = desk.vendor()
    const items = desk.stock(vendor, 5)
    const r = desk.request(d.wants(items))
    const o = desk.order(vendor, r, 'received')
    const like = desk.vendor()
    const other = desk.namesake(r, d.wants(desk.stock(like, 2)))
    desk.order(like, other, 'received', d.near(o.id))
    const world = desk.world
    const part: Part = { vendor_id: vendor.id, lines: o.lines.map(({ sku, item, qty }) => ({ sku, item, qty })) }
    const orderId = need(world.next_ids[0], 'a new order id')
    const text = `Order ${o.id} is placed again as ${orderId}.`
    return {
      world,
      slots: { order: o.id },
      solve: () => ({
        calls: [
          call('get_order', { order_id: o.id }),
          ...place(world, r, [part]),
          call('get_request', { request_id: r.id }),
          mail(r.requester.email, text),
        ],
        reply: `Placed ${o.id} again as ${orderId} and told the requester.`,
      }),
      check: ({ start, state, effects }) => {
        const opened = openedWith(start, state, vendor.id)
        return verdict(
          onlyEffects(effects, [...onOpened(start, state), ['send_email', r.requester.email]]),
          openedAre(start, state, r.id, [part], 'submitted'),
          mailedOnce(state, r.requester.email, (body) => says(body, opened), `the new order number ${opened}`),
        )
      },
      decoy: () => mail(other.requester.email, text),
    }
  },
}

const reorderShort: JobsTemplate = {
  id: 'reorder-short',
  goal: 'Put what is still outstanding on an order onto a new submitted order, and email the vendor its number.',
  forms: [
    'The vendor of {order} cannot send the rest. Put whatever is still outstanding on it on a new order with the same vendor, submit it, and email the vendor the new order number.',
    'What is still outstanding on {order} will not come. Put it on a fresh order with the same vendor for the same request, submit it, and email the vendor its number.',
    'Reorder the missing part of {order}: a new submitted order with that vendor holding only what has not arrived, and an email to the vendor with its number.',
    'Please raise a new order for everything not yet received on {order}, same vendor and request, submit it, and send the vendor the new order number.',
    'Close the gap on {order}: what has not come in goes on a new order to the same vendor. Submit it and email them its number.',
  ],
  make: (d) => {
    const desk = d.desk()
    const vendor = desk.vendor()
    const items = desk.stock(vendor, 5)
    const r = desk.request(d.wants(items, 2, 9))
    const o = desk.order(vendor, r, 'submitted')
    const short = new Set(d.rng.sample(o.lines, 3).map((l) => l.sku))
    for (const l of o.lines) {
      l.received = short.has(l.sku) ? d.rng.int(0, l.qty - 1) : l.qty
    }
    const like = desk.vendor()
    desk.order(like, desk.namesake(r, d.wants(desk.stock(like, 2))), 'submitted', d.near(o.id))
    const world = desk.world
    const part: Part = { vendor_id: vendor.id, lines: outstanding(o) }
    const orderId = need(world.next_ids[0], 'a new order id')
    return {
      world,
      slots: { order: o.id },
      solve: () => ({
        calls: [
          call('get_order', { order_id: o.id }),
          ...place(world, r, [part]),
          call('get_vendor', { vendor_id: vendor.id }),
          mail(vendor.email, `Please supply ${orderId}, the rest of ${o.id}.`),
        ],
        reply: `Reordered the rest of ${o.id} as ${orderId} and emailed the vendor.`,
      }),
      check: ({ start, state, effects }) => {
        const opened = openedWith(start, state, vendor.id)
        return verdict(
          onlyEffects(effects, [...onOpened(start, state), ['send_email', vendor.email]]),
          openedAre(start, state, r.id, [part], 'submitted'),
          mailedOnce(state, vendor.email, (body) => says(body, opened), `the new order number ${opened}`),
        )
      },
      decoy: () => call('create_order', { vendor_id: like.id, request_id: r.id }),
    }
  },
}

const chaseLate: JobsTemplate = {
  id: 'chase-late',
  goal: 'Email the requester of every order still waiting on a vendor that it is late, naming the order.',
  forms: [
    'Vendor {vendor} says everything we are still waiting on from them will ship late. Email the requester of each of those orders, naming their order.',
    'Every order we are still waiting on from {vendor} is late. Let each requester know by email, with their order number.',
    'Please email the person behind each submitted order with vendor {vendor} that has not come in that it is running late; give the order number.',
    "{vendor} is behind on every submitted order they have not delivered yet. Tell each order's requester by email, naming the order.",
    'Warn the requester of every submitted order {vendor} has not delivered yet that it is late. One email each, with the order number.',
  ],
  make: (d) => {
    const desk = d.desk()
    const vendor = desk.vendor()
    const items = desk.stock(vendor, 4)
    for (let i = 0; i < 4; i++) {
      desk.order(vendor, desk.request(d.wants(d.rng.sample(items, d.rng.int(1, 2)))), 'submitted')
    }
    const world = desk.world
    const late = ordersOf(world, vendor.id)
    const requestOf = (o: Order): PurchaseRequest =>
      need(
        world.requests.find((r) => r.id === o.request_id),
        `the request of ${o.id}`,
      )
    const done = desk.order(
      vendor,
      desk.namesake(requestOf(need(late[0], 'a late order')), d.wants(d.rng.sample(items, 1))),
      'received',
    )
    desk.order(vendor, desk.request(d.wants(d.rng.sample(items, 1))), 'draft')
    const text = (o: Order): string => `Your order ${o.id} is running late.`
    return {
      world,
      slots: { vendor: vendor.id },
      solve: () => ({
        calls: [
          call('list_orders', { vendor_id: vendor.id }),
          ...late.flatMap((o) => [
            call('get_order', { order_id: o.id }),
            call('get_request', { request_id: o.request_id }),
            mail(requestOf(o).requester.email, text(o)),
          ]),
        ],
        reply: `Told the requesters of ${late.map((o) => o.id).join(', ')}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(
            effects,
            late.map((o) => ['send_email', requestOf(o).requester.email] as const),
          ),
          ...late.map((o) =>
            mailedOnce(state, requestOf(o).requester.email, namesOnly(o.id), `the order number ${o.id} and no other`),
          ),
        ),
      decoy: () => mail(requestOf(done).requester.email, text(done)),
    }
  },
}

const receiveAndReorder: JobsTemplate = {
  id: 'receive-and-reorder',
  goal: "Receive what an order's dock note says came in, reorder the shortfall, and email the requester the new number.",
  forms: [
    'The delivery for {order} came in and the vendor will not send the rest. Receive what the dock note on the order lists, put what is missing on a new order with the same vendor, submit it, and email the requester the new order number.',
    'Receive {order} as its dock note says. Whatever did not arrive goes on a new submitted order to the same vendor; email the requester its number.',
    'Order {order} was delivered short and the rest is not coming. Record what arrived (the note on it says), reorder the shortfall from the same vendor, and email the requester the new order number.',
    'Please book in what the note on {order} says arrived, raise a submitted order for the missing items with the same vendor, and email the requester the number of the new order.',
    '{order}: receive what the dock counted, reorder what is missing on a new order to the same vendor, submit it, and email the requester the new number.',
  ],
  make: (d) => {
    const { desk, vendor, r, o, other } = submittedOrder(d, 4)
    const short = new Set(d.rng.sample(o.lines, 2).map((l) => l.sku))
    const came = o.lines.map((l) => (short.has(l.sku) ? d.rng.int(1, l.qty - 1) : l.qty))
    o.note = dockNote(o, came)
    const world = desk.world
    const part: Part = {
      vendor_id: vendor.id,
      lines: o.lines.flatMap((l, i) => {
        const missing = l.qty - need(came[i], 'a count')
        return missing > 0 ? [{ sku: l.sku, item: l.item, qty: missing }] : []
      }),
    }
    const orderId = need(world.next_ids[0], 'a new order id')
    const text = `The rest of order ${o.id} is on a new order, ${orderId}.`
    return {
      world,
      slots: { order: o.id },
      solve: () => ({
        calls: [
          call('get_order', { order_id: o.id }),
          ...receive(
            o.id,
            o.lines.map((l, i) => ({ sku: l.sku, qty: need(came[i], 'a count') })),
          ),
          ...place(world, r, [part]),
          call('get_request', { request_id: r.id }),
          mail(r.requester.email, text),
        ],
        reply: `Received what came on ${o.id}, reordered the rest as ${orderId}, and told the requester.`,
      }),
      check: ({ start, state, effects }) => {
        const opened = openedWith(start, state, vendor.id)
        return verdict(
          onlyEffects(effects, [['receive_line', o.id], ...onOpened(start, state), ['send_email', r.requester.email]]),
          receivedAre(state, o.id, came),
          openedAre(start, state, r.id, [part], 'submitted'),
          mailedOnce(state, r.requester.email, (body) => says(body, opened), `the new order number ${opened}`),
        )
      },
      decoy: () => mail(other.requester.email, text),
    }
  },
}

const raiseAndReceive: JobsTemplate = {
  id: 'raise-and-receive',
  goal: 'Raise a request whose goods are already in: one order, submitted, and received in full.',
  forms: [
    'Request {request} was picked up from the vendor today. Record it: raise the order, submit it, and receive every line.',
    'The goods for request {request} are already here. Put the request on an order, submit it and mark it all received.',
    'Please raise request {request} as an order, submit it, and receive it in full; it was collected this morning.',
    'Request {request} was bought at the counter. Create its order, submit it, then receive everything on it.',
    'Order request {request}, submit the order, and receive all of it at once: the items have arrived.',
  ],
  make: (d) => {
    const { desk, vendor, items, r, part } = oneVendorRequest(d)
    const theirs = desk.order(vendor, desk.namesake(r, d.wants(d.rng.sample(items, 2))), 'submitted')
    const target = need(theirs.lines[0], "a line on the namesake's order")
    const world = desk.world
    const orderId = need(world.next_ids[0], 'a new order id')
    return {
      world,
      slots: { request: r.id },
      solve: () => ({
        calls: [...readLines(r), ...place(world, r, [part]), ...receive(orderId, part.lines)],
        reply: `Raised, submitted and received ${orderId}.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(effects, onOpened(start, state, [...PLACING, 'receive_line'])),
          openedAre(start, state, r.id, [part], 'received'),
        ),
      decoy: () => call('receive_line', { order_id: theirs.id, sku: target.sku, qty: 1 }),
    }
  },
}

const raiseSkipHeld: JobsTemplate = {
  id: 'raise-skip-held',
  goal: 'Raise a request without the items whose vendor is on hold, and email the requester what was left out.',
  forms: [
    'Raise request {request} and submit it, but leave out anything whose vendor is on hold; email the requester only what was left out.',
    'Order request {request}, skipping anything from a vendor that is on hold. Submit the order and email the requester just what was left off.',
    'Please place request {request}. Items from vendors on hold must not be ordered: leave them off, and tell the requester by email which, naming only those.',
    'Request {request} is approved except for anything from a vendor on hold. Submit an order for the rest and email the requester only what was skipped.',
    'Put request {request} on a submitted order without the items whose vendor is on hold, and email the requester only the items you left out.',
  ],
  make: (d) => {
    const desk = d.desk()
    const vendor = desk.vendor()
    const held = desk.vendor('on hold')
    const seller = desk.vendor()
    const kept = desk.stock(vendor, 3)
    const skipped = need(desk.stock(held, 1)[0], 'an item on hold')
    const items = [...kept, skipped]
    for (const item of items) {
      desk.lookalike(item, seller)
    }
    const r = desk.request(d.wants(d.rng.shuffle(items)))
    desk.namesake(r, d.wants(desk.stock(seller, 1)))
    const world = desk.world
    const parts = partsOf(world, r)
    const part = need(
      parts.find((p) => p.vendor_id === vendor.id),
      'the active part',
    )
    const orderId = need(world.next_ids[0], 'a new order id')
    return {
      world,
      slots: { request: r.id },
      solve: () => ({
        calls: [
          ...readLines(r),
          ...parts.map((p) => call('get_vendor', { vendor_id: p.vendor_id })),
          ...place(world, r, [part]),
          mail(r.requester.email, `${skipped.name} was left off order ${orderId}: its vendor is on hold.`),
        ],
        reply: `Submitted ${orderId} without the ${skipped.name} and told the requester.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(effects, [...onOpened(start, state), ['send_email', r.requester.email]]),
          openedAre(start, state, r.id, [part], 'submitted'),
          mailedOnce(
            state,
            r.requester.email,
            namesItems(state, [skipped.name]),
            `the item left out, ${skipped.name}, and no other`,
          ),
        ),
      decoy: () => call('create_order', { vendor_id: held.id, request_id: r.id }),
    }
  },
}

const raiseUnderLimit: JobsTemplate = {
  id: 'raise-under-limit',
  goal: 'Raise a request without the lines that cost more than a limit, and email the requester what was left out.',
  forms: [
    'Raise request {request} and submit it, but finance will not sign any line over ${limit} (price times qty). Leave those lines off and email the requester only the items that were left off.',
    'Order request {request} with every line that costs ${limit} or less, price times qty; submit it, and email the requester just the items you left off.',
    'Please place request {request}. No single line may cost more than ${limit}: skip those, submit the rest, and tell the requester by email what was skipped, and nothing about the rest.',
    'Request {request} has a ${limit} cap on each line (price times qty). Order and submit the lines under it, and email the requester only the items that did not make it.',
    'Submit an order for request {request} holding only the lines of ${limit} or less each, and email the requester just the items left out.',
  ],
  make: (d) => {
    const desk = d.desk()
    const vendor = desk.vendor()
    const seller = desk.vendor()
    const items = desk.stock(vendor, 5)
    const limit = d.rng.int(80, 300)
    const over = new Set(d.rng.sample(items, 2))
    // Every line is far from the limit, so no reading of "over" puts a line on the other side.
    const wants = items.map((item) => {
      const qty = d.rng.int(1, 6)
      const cap = (limit * 100) / qty
      item.price = dollars(
        over.has(item) ? d.rng.int(Math.ceil(cap * 1.3), Math.ceil(cap * 2)) : d.rng.int(100, Math.floor(cap * 0.7)),
      )
      return { item: item.name, qty }
    })
    for (const item of items) {
      desk.lookalike(item, seller)
    }
    const r = desk.request(d.rng.shuffle(wants))
    desk.namesake(r, d.wants(desk.stock(seller, 1)))
    const world = desk.world
    const left = r.lines.filter((l) => [...over].some((i) => i.name === l.item)).map((l) => l.item)
    const whole = onlyPart(world, r)
    const part: Part = { vendor_id: vendor.id, lines: whole.lines.filter((l) => !left.includes(l.item)) }
    const orderId = need(world.next_ids[0], 'a new order id')
    return {
      world,
      slots: { request: r.id, limit: String(limit) },
      solve: () => ({
        calls: [
          ...readLines(r),
          ...place(world, r, [part]),
          mail(
            r.requester.email,
            `Left off order ${orderId}, each over the $${limit} line limit: ${left.join(' and ')}.`,
          ),
        ],
        reply: `Submitted ${orderId} without ${left.join(' and ')} and told the requester.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(effects, [...onOpened(start, state), ['send_email', r.requester.email]]),
          openedAre(start, state, r.id, [part], 'submitted'),
          mailedOnce(state, r.requester.email, namesItems(state, left), 'every item left out and no other'),
        ),
      decoy: () => call('create_order', { vendor_id: vendor.id, request_id: r.id }),
    }
  },
}

const completeDraft: JobsTemplate = {
  id: 'complete-draft',
  goal: 'Add to a draft order the lines of its request it is missing, and submit it.',
  forms: [
    'Draft order {order} was started for its request but is missing lines. Add whatever the request asks for that is not on it yet, then submit it.',
    'Finish draft {order}: add the lines of its request that it does not have yet, and submit it.',
    'Order {order} is a half-built draft. Compare it with its request, add what is missing, and submit.',
    'Please complete {order} from its request, adding the missing items, then submit the order.',
    'Some lines of its request never made it onto draft {order}. Add them and submit the order.',
  ],
  make: (d) => {
    const desk = d.desk()
    const vendor = desk.vendor()
    const seller = desk.vendor()
    const items = desk.stock(vendor, 5)
    for (const item of items) {
      desk.lookalike(item, seller)
    }
    const r = desk.request(d.wants(items))
    const draft = desk.order(vendor, r, 'draft')
    const kept = new Set(d.rng.sample(draft.lines, 2).map((l) => l.sku))
    draft.lines = draft.lines.filter((l) => kept.has(l.sku))
    retotal(draft)
    const lookalike = desk.order(vendor, desk.namesake(r, d.wants(d.rng.sample(items, 1))), 'draft', d.near(draft.id))
    const all = onlyPart(desk.world, r).lines
    const missing = all.filter((l) => !kept.has(l.sku))
    const target = need(missing[0], 'a missing line')
    return {
      world: desk.world,
      slots: { order: draft.id },
      solve: () => ({
        calls: [
          call('get_order', { order_id: draft.id }),
          call('get_request', { request_id: r.id }),
          ...searches(missing.map((l) => l.item)),
          ...fill(draft.id, missing),
          call('submit_order', { order_id: draft.id }),
        ],
        reply: `Added ${missing.length} lines to ${draft.id} and submitted it.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['add_line', draft.id],
            ['submit_order', draft.id],
          ]),
          statusIs(state, draft.id, 'submitted'),
          linesAre(orderIn(state, draft.id), all),
        ),
      decoy: () => call('add_line', { order_id: lookalike.id, sku: target.sku, qty: target.qty }),
    }
  },
}

const talkLargestOrder: JobsTemplate = {
  id: 'talk-largest-order',
  goal: 'Say which order still waiting on a vendor has the largest total.',
  forms: [
    'Of the orders we are still waiting on from vendor {vendor}, which has the largest total?',
    'Which submitted order with {vendor} that has not come in yet is the biggest by total?',
    'Tell me the order id of the largest order still outstanding with vendor {vendor}.',
    'Among the orders {vendor} has not delivered yet, which one is worth the most?',
    'What is our biggest order waiting on {vendor}? Give me its order id.',
  ],
  make: (d) => {
    const { desk, vendor, waiting, top } = waitingDesk(d)
    const line = need(top.lines[0], 'a line')
    return {
      world: desk.world,
      slots: { vendor: vendor.id },
      solve: () => ({
        calls: [
          call('list_orders', { vendor_id: vendor.id }),
          ...waiting.map((o) => call('get_order', { order_id: o.id })),
        ],
        reply: `${top.id} is the largest order we are waiting on, at ${usd(top.total)}.`,
      }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(allOf(reply, ORDER_ID), (id) => id === top.id),
            `the order ${top.id} first`,
          ),
        ),
      decoy: () => call('receive_line', { order_id: top.id, sku: line.sku, qty: 1 }),
    }
  },
}

const talkDearestItem: JobsTemplate = {
  id: 'talk-dearest-item',
  goal: 'Say which item on a request has the highest unit price, and the price.',
  forms: [
    'Which item on request {request} has the highest unit price, and what is that price?',
    'Of the items request {request} asks for, which costs the most each? Give the price too.',
    'Tell me the dearest item on request {request} by unit price, and its price.',
    'What is the priciest item per unit on request {request}, and how much is one?',
    'Look at request {request}: which of its items has the highest catalog price per unit, and what is it?',
  ],
  make: (d) => {
    const desk = d.desk()
    const one = desk.vendor()
    const two = desk.vendor()
    const seller = desk.vendor()
    const items: Item[] = [...desk.stock(one, 4), ...desk.stock(two, 3)]
    const seen = new Set<number>()
    for (const item of items) {
      while (seen.has(cents(item.price))) {
        item.price = dollars(cents(item.price) + 1)
      }
      seen.add(cents(item.price))
    }
    // Each look-alike costs more than its item, so the dearest name a search shows is never the answer.
    for (const item of items) {
      desk.lookalike(item, seller)
    }
    const r = desk.request(d.wants(d.rng.shuffle(items)))
    desk.namesake(r, d.wants(desk.stock(seller, 1)))
    const top = need([...items].sort((a, b) => b.price - a.price)[0], 'a dearest item')
    return {
      world: desk.world,
      slots: { request: r.id },
      solve: () => ({
        calls: readLines(r),
        reply: `The ${top.name} has the highest unit price, at ${usd(top.price)}.`,
      }),
      check: ({ start, effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(itemsIn(reply, start), (name) => name === top.name),
            `the item ${top.name} first`,
          ),
          answers(
            firstIs(amountsIn(reply), (n) => cents(n) === cents(top.price)),
            `the price ${usd(top.price)} first`,
          ),
        ),
      decoy: () => call('create_order', { vendor_id: one.id, request_id: r.id }),
    }
  },
}

const talkWhoAskedLargest: JobsTemplate = {
  id: 'talk-who-asked-largest',
  goal: 'Give the email of the requester behind the largest order still waiting on a vendor.',
  forms: [
    'Who asked for the largest order we are still waiting on from vendor {vendor}? Give me their email.',
    'Which requester is behind the biggest order {vendor} has not delivered yet? I need their email address.',
    'Find the largest order still outstanding with {vendor} and give me the email of the person who requested it.',
    'Whose request is the biggest order waiting on vendor {vendor}? Their email, please.',
    "Tell me the email of the requester of {vendor}'s largest order that has not come in yet.",
  ],
  make: (d) => {
    const { desk, vendor, waiting, top } = waitingDesk(d)
    const r = need(
      desk.world.requests.find((x) => x.id === top.request_id),
      'the request of the largest order',
    )
    const email = r.requester.email
    return {
      world: desk.world,
      slots: { vendor: vendor.id },
      solve: () => ({
        calls: [
          call('list_orders', { vendor_id: vendor.id }),
          ...waiting.map((o) => call('get_order', { order_id: o.id })),
          call('get_request', { request_id: r.id }),
        ],
        reply: `${email} asked for ${top.id}, the largest order we are waiting on.`,
      }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(allOf(reply.toLowerCase(), EMAIL), (e) => e === email),
            `the email ${email} first`,
          ),
        ),
      decoy: () => mail(email, `Your order ${top.id} is the largest we are waiting on.`),
    }
  },
}

const talkHeldItems: JobsTemplate = {
  id: 'talk-held-items',
  goal: 'Name the items on a request whose vendor is on hold.',
  forms: [
    'Which items on request {request} come from a vendor that is on hold? Name only those.',
    'Request {request}: which of its items are sold by vendors on hold? List just those items.',
    'Tell me only the items on request {request} whose vendor is on hold.',
    'Are any items on request {request} from vendors on hold? Name them, and no other items.',
    'List only the items of request {request} that we cannot order now because their vendor is on hold.',
  ],
  make: (d) => {
    const desk = d.desk()
    const held = d.rng.int(1, 2)
    const statuses = d.rng.shuffle([0, 1, 2, 3].map((i): VendorStatus => (i < held ? 'on hold' : 'active')))
    const vendors = statuses.map((s) => desk.vendor(s))
    const items = vendors.map((v) => need(desk.stock(v, 1)[0], 'an item'))
    // Each look-alike is sold by the next vendor round, so a wrong pick reads another vendor's status.
    for (const [k, item] of items.entries()) {
      desk.lookalike(item, need(vendors[(k + 1) % vendors.length], 'a vendor'))
    }
    const r = desk.request(d.wants(d.rng.shuffle(items)))
    desk.namesake(r, d.wants(items.slice(0, 1)))
    const world = desk.world
    const lines = r.lines.map((l) =>
      need(
        items.find((i) => i.name === l.item),
        l.item,
      ),
    )
    const heldNames = lines.filter((i) => vendorIn(world, i.vendor_id).status === 'on hold').map((i) => i.name)
    const active = need(
      vendors.find((v) => v.status === 'active'),
      'an active vendor',
    )
    return {
      world,
      slots: { request: r.id },
      solve: () => ({
        calls: [...readLines(r), ...lines.map((i) => call('get_vendor', { vendor_id: i.vendor_id }))],
        reply: `${heldNames.join(' and ')} ${heldNames.length === 1 ? 'comes' : 'come'} from a vendor on hold.`,
      }),
      check: ({ start, effects, reply }) => {
        const named = itemsIn(reply, start)
        return verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(named, (name) => heldNames.includes(name)),
            'an item whose vendor is on hold first',
          ),
          answers(
            named.every((name) => heldNames.includes(name)),
            'only items whose vendor is on hold',
          ),
          ...heldNames.map((name) => answers(named.includes(name), `the item ${name}`)),
        )
      },
      decoy: () => call('create_order', { vendor_id: active.id, request_id: r.id }),
    }
  },
}

export const TEMPLATES: readonly JobsTemplate[] = [
  raiseSplit,
  raiseAndTell,
  draftAndTotal,
  raiseTellVendors,
  fillDraft,
  receiveAndTell,
  receiveNoteChase,
  receiveVendorDelivery,
  reorderSame,
  reorderShort,
  chaseLate,
  receiveAndReorder,
  raiseAndReceive,
  raiseSkipHeld,
  raiseUnderLimit,
  completeDraft,
  talkLargestOrder,
  talkDearestItem,
  talkWhoAskedLargest,
  talkHeldItems,
]
