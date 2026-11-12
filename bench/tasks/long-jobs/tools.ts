import type { Args, Effect, ToolSpec } from '../shared.ts'
import { ToolError, amount, cents, dollars, need, text, tool } from '../shared.ts'

/** Catalog item names. No word is in two of them, so a search for one name finds no other name's item. */
export const ITEM_NAMES = [
  'Desk Lamp',
  'Paper Ream',
  'Ink Cartridge',
  'Stapler',
  'Whiteboard Marker',
  'Monitor Arm',
  'Office Chair',
  'Filing Cabinet',
  'Label Printer',
  'Shipping Box',
  'Packing Tape',
  'Bubble Wrap',
  'Safety Gloves',
  'Hard Hat',
  'Coffee Beans',
  'Water Filter',
  'Extension Cord',
  'Laptop Stand',
  'Keyboard',
  'Mouse Pad',
  'Headset',
  'Webcam',
  'Toner',
  'Envelope Pack',
  'Sticky Notes',
  'Binder Clips',
  'Floor Fan',
  'Space Heater',
  'Trash Bags',
  'Hand Soap',
  'Towel Rolls',
  'Step Ladder',
  'Tool Kit',
  'Cable Ties',
  'Power Strip',
  'Storage Bin',
  'Name Badges',
  'Notebook',
  'Calculator',
  'Scissors',
  'Pencil Case',
  'Door Wedge',
  'Cork Board',
  'Wall Clock',
  'Bandages',
] as const

/** A look-alike is an item's name plus one of these words, so a search for the name finds both. */
export const SIZES = ['Large', 'Compact', 'Deluxe', 'Twin', 'Bulk'] as const

export const VENDOR_STATUSES = ['active', 'on hold'] as const
export type VendorStatus = (typeof VENDOR_STATUSES)[number]

export const ORDER_STATUSES = ['draft', 'submitted', 'received'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** The day the desk works on; an order submitted in a task is placed on it. */
export const TODAY = '2026-03-09'

export interface Vendor {
  id: string
  name: string
  email: string
  status: VendorStatus
}

export interface Item {
  sku: string
  name: string
  vendor_id: string
  price: number
}

export interface Person {
  name: string
  email: string
}

export interface Want {
  item: string
  qty: number
}

export interface PurchaseRequest {
  id: string
  requester: Person
  lines: Want[]
}

export interface Line {
  sku: string
  item: string
  qty: number
  price: number
  received: number
}

export interface Order {
  id: string
  vendor_id: string
  request_id: string
  status: OrderStatus
  placed_on: string | null
  lines: Line[]
  total: number
  note: string
}

export interface Mail {
  to: string
  text: string
}

export interface JobsWorld {
  vendors: Vendor[]
  items: Item[]
  requests: PurchaseRequest[]
  orders: Order[]
  outbox: Mail[]
  /** The ids create_order hands out, in order. No tool shows them. */
  next_ids: string[]
}

export const SYSTEM = [
  "You are the assistant on a company's purchasing desk. A member of staff asks you to do a job.",
  'Use the tools to look things up and to act; never guess an id, a price, a quantity or an email address.',
  'Ids look like RQ-12345 for a purchase request, PO-12345 for a purchase order, V-1234 for a vendor',
  'and SK-12345 for a catalog item. The lines of a request name catalog items exactly.',
  "A purchase order is for one vendor and one request, and holds only that vendor's items. It is a draft",
  'until it is submitted to the vendor, and it is received once every line has come in.',
  'Money is in US dollars, and an order line costs its price times its qty.',
  'When the job is done, or cannot be done, answer the member of staff in one or two sentences,',
  'and include any fact they asked for.',
].join(' ')

const id = (description: string) => ({ type: 'string' as const, description })

export const TOOLS: readonly ToolSpec[] = [
  tool('get_request', 'Read a purchase request: who asked for it, and its lines, each a catalog item name and a qty.', {
    request_id: id('Request id, like RQ-12345.'),
  }),
  tool(
    'find_items',
    'Find catalog items whose name holds every word of the text, ignoring case: sku, name, vendor and unit price.',
    { text: id('Words of an item name, like desk lamp.') },
  ),
  tool('get_vendor', 'Read a vendor: name, email address, and status, active or on hold.', {
    vendor_id: id('Vendor id, like V-1234.'),
  }),
  tool(
    'list_orders',
    "List a vendor's purchase orders, newest first: id, status and date placed. No lines, no totals.",
    {
      vendor_id: id('Vendor id.'),
    },
  ),
  tool(
    'get_order',
    'Read a purchase order: vendor, request, status, date placed, lines with qty, price and qty received, total and note.',
    { order_id: id('Order id, like PO-12345.') },
  ),
  tool('create_order', 'Open a new draft purchase order with a vendor for a request. Returns the new order id.', {
    vendor_id: id('Vendor id.'),
    request_id: id('Request id.'),
  }),
  tool(
    'add_line',
    "Add a catalog item to a draft order at the item's price. The order's vendor must sell it; adding an item already on the order adds to its qty.",
    {
      order_id: id('Order id.'),
      sku: id('Catalog item sku, like SK-12345.'),
      qty: { type: 'number', description: 'How many, a whole number.' },
    },
  ),
  tool('submit_order', 'Submit a draft order that has at least one line, sending it to the vendor.', {
    order_id: id('Order id.'),
  }),
  tool(
    'receive_line',
    'Record units of one line of a submitted order as received, up to what is outstanding. The order is received once every line is in.',
    {
      order_id: id('Order id.'),
      sku: id('The sku of the line.'),
      qty: { type: 'number', description: 'How many came in, a whole number.' },
    },
  ),
  tool('send_email', 'Send an email.', { to: id('One email address.'), text: id('The email.') }),
]

export const ACTING = ['create_order', 'add_line', 'submit_order', 'receive_line', 'send_email']

export const orderIn = (world: JobsWorld, orderId: string): Order =>
  need(
    world.orders.find((o) => o.id === orderId),
    `order ${orderId}`,
  )

export const retotal = (order: Order): void => {
  order.total = dollars(order.lines.reduce((sum, line) => sum + cents(line.price) * line.qty, 0))
}

const placed = (o: Order): number => (o.placed_on === null ? 0 : 1)

/** Newest first, drafts (not yet placed) before them; dates are ISO, so text order is date order. */
export const ordersOf = (world: JobsWorld, vendorId: string): Order[] =>
  world.orders
    .filter((o) => o.vendor_id === vendorId)
    .sort(
      (a, b) =>
        placed(a) - placed(b) || (b.placed_on ?? '').localeCompare(a.placed_on ?? '') || a.id.localeCompare(b.id),
    )

/** The lower-cased words of a name or a search. */
export const wordsOf = (words: string): string[] =>
  words
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)

const lookUp = <T>(found: T | undefined, what: string): T => {
  if (found === undefined) {
    throw new ToolError(`no ${what}`)
  }
  return found
}

const whole = (args: Args, key: string): number => {
  const n = amount(args, key)
  if (!Number.isInteger(n)) {
    throw new ToolError(`${key} must be a whole number`)
  }
  return n
}

export const jobsTable = (state: JobsWorld, effects: Effect[]): Record<string, (args: Args) => unknown> => {
  const vendor = (args: Args): Vendor => {
    const key = text(args, 'vendor_id')
    return lookUp(
      state.vendors.find((v) => v.id === key),
      `vendor ${key}`,
    )
  }
  const request = (args: Args): PurchaseRequest => {
    const key = text(args, 'request_id')
    return lookUp(
      state.requests.find((r) => r.id === key),
      `request ${key}`,
    )
  }
  const order = (args: Args): Order => {
    const key = text(args, 'order_id')
    return lookUp(
      state.orders.find((o) => o.id === key),
      `order ${key}`,
    )
  }
  const record = (tool: string, args: Args, target: string): void => {
    effects.push({ tool, args: structuredClone(args), target })
  }
  let minted = 0

  return {
    get_request: (args) => request(args),
    find_items: (args) => {
      const words = wordsOf(text(args, 'text'))
      if (words.length === 0) {
        throw new ToolError('text must hold at least one word')
      }
      return state.items
        .filter((item) => words.every((w) => wordsOf(item.name).includes(w)))
        .map(({ sku, name, vendor_id, price }) => ({ sku, name, vendor_id, price }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    get_vendor: (args) => vendor(args),
    list_orders: (args) =>
      ordersOf(state, vendor(args).id).map((o) => ({ id: o.id, status: o.status, placed_on: o.placed_on })),
    get_order: (args) => order(args),
    create_order: (args) => {
      const v = vendor(args)
      const r = request(args)
      minted += 1
      const made: Order = {
        id: state.next_ids.shift() ?? `PO-${String(minted).padStart(5, '0')}`,
        vendor_id: v.id,
        request_id: r.id,
        status: 'draft',
        placed_on: null,
        lines: [],
        total: 0,
        note: '',
      }
      state.orders.push(made)
      record('create_order', args, made.id)
      return { order_id: made.id, status: made.status }
    },
    add_line: (args) => {
      const o = order(args)
      if (o.status !== 'draft') {
        throw new ToolError(`${o.id} is ${o.status}; only a draft order takes new lines`)
      }
      const sku = text(args, 'sku')
      const item = lookUp(
        state.items.find((i) => i.sku === sku),
        `catalog item ${sku}`,
      )
      if (item.vendor_id !== o.vendor_id) {
        throw new ToolError(`${item.sku} is sold by ${item.vendor_id}, not by ${o.vendor_id}, the vendor of ${o.id}`)
      }
      const qty = whole(args, 'qty')
      const held = o.lines.find((l) => l.sku === item.sku)
      if (held === undefined) {
        o.lines.push({ sku: item.sku, item: item.name, qty, price: item.price, received: 0 })
      } else {
        held.qty += qty
      }
      retotal(o)
      record('add_line', args, o.id)
      return {
        order_id: o.id,
        lines: o.lines.map(({ sku: lineSku, item: name, qty: n, price }) => ({
          sku: lineSku,
          item: name,
          qty: n,
          price,
        })),
        total: o.total,
      }
    },
    submit_order: (args) => {
      const o = order(args)
      if (o.status !== 'draft') {
        throw new ToolError(`${o.id} is already ${o.status}`)
      }
      if (o.lines.length === 0) {
        throw new ToolError(`${o.id} has no lines to submit`)
      }
      o.status = 'submitted'
      o.placed_on = TODAY
      record('submit_order', args, o.id)
      return { order_id: o.id, status: o.status, placed_on: o.placed_on, total: o.total }
    },
    receive_line: (args) => {
      const o = order(args)
      if (o.status !== 'submitted') {
        throw new ToolError(o.status === 'draft' ? `${o.id} has not been submitted` : `${o.id} is already received`)
      }
      const sku = text(args, 'sku')
      const line = lookUp(
        o.lines.find((l) => l.sku === sku),
        `line for ${sku} on ${o.id}`,
      )
      const qty = whole(args, 'qty')
      const outstanding = line.qty - line.received
      if (qty > outstanding) {
        throw new ToolError(`only ${outstanding} of ${line.item} is outstanding on ${o.id}`)
      }
      line.received += qty
      if (o.lines.every((l) => l.received === l.qty)) {
        o.status = 'received'
      }
      record('receive_line', args, o.id)
      return { order_id: o.id, sku, received: line.received, outstanding: line.qty - line.received, status: o.status }
    },
    send_email: (args) => {
      const to = text(args, 'to').toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        throw new ToolError('to must be one email address')
      }
      state.outbox.push({ to, text: text(args, 'text') })
      record('send_email', args, to)
      return { sent: true, to }
    },
  }
}

/** The identifying values in a desk, read from its records. */
export const jobsIdentities = (world: JobsWorld): string[] => [
  ...world.vendors.flatMap((v) => [v.id, v.name, v.email]),
  ...world.items.map((i) => i.sku),
  ...world.requests.flatMap((r) => [r.id, r.requester.name, r.requester.email]),
  ...world.orders.map((o) => o.id),
  ...world.next_ids,
]
