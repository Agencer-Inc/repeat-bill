import type { Args, Effect, ToolSpec } from '../shared.ts'
import { ToolError, amount, cents, choice, dollars, listOf, need, text, tool } from '../shared.ts'

/** Everything the shop sells; an order's items are drawn from it. */
export const CATALOG = listOf(`
  Ceramic-Mug Linen-Apron Desk-Lamp Wool-Scarf Steel-Bottle Cotton-Tote Notebook-Set Travel-Pillow
  Phone-Stand Garden-Gloves Tea-Tin Candle-Trio Yoga-Mat Bike-Light Rain-Jacket Picture-Frame Wall-Clock
  Bath-Towel Cutting-Board Water-Filter Laptop-Sleeve Pen-Set Throw-Blanket Plant-Pot Coffee-Grinder
  Hiking-Socks Sun-Hat Lunch-Box Spice-Rack Reading-Glasses Door-Mat Desk-Organizer Wooden-Tray
  Glass-Carafe Canvas-Backpack Bird-Feeder Puzzle-Box Leather-Wallet Umbrella Thermos
`).map((name) => name.replace('-', ' '))

export const STATUSES = ['processing', 'shipped', 'delivered'] as const

export interface Address {
  street: string
  city: string
  postcode: string
}

export interface Customer {
  id: string
  name: string
  email: string
  address: Address
}

export interface Item {
  name: string
  qty: number
  price: number
}

export interface Order {
  id: string
  customer_id: string
  placed_on: string
  status: (typeof STATUSES)[number]
  items: Item[]
  total: number
  refunded: number
  tracking: string | null
}

export const TEAMS = ['billing', 'shipping', 'technical'] as const
export type Team = (typeof TEAMS)[number]

export interface Ticket {
  id: string
  customer_id: string
  order_id: string | null
  subject: string
  body: string
  status: 'open' | 'closed' | 'escalated'
  team: Team | null
  notes: string[]
  replies: string[]
}

export interface SupportWorld {
  customers: Customer[]
  orders: Order[]
  tickets: Ticket[]
}

export const SYSTEM = [
  "You are the assistant on a shop's support desk. A member of staff asks you to do a job.",
  'Use the tools to look things up and to act; never guess an id, an amount or an address.',
  'Ids look like C-1234 for a customer, O-12345 for an order and T-12345 for a ticket.',
  'Money is in US dollars, and an order line costs its price times its qty.',
  'When the job is done, or cannot be done, answer the member of staff in one or two sentences,',
  'and include any fact they asked for.',
].join(' ')

const id = (description: string) => ({ type: 'string' as const, description })

export const TOOLS: readonly ToolSpec[] = [
  tool('get_ticket', 'Read a support ticket: its customer, the order it is about, subject, body, status and notes.', {
    ticket_id: id('Ticket id, like T-12345.'),
  }),
  tool('find_customer', 'Find customers by exact email address or by part of their name, with their addresses.', {
    query: id('An email address, or part of a name.'),
  }),
  tool('get_order', 'Read an order: items, prices, total, status, tracking number and amount refunded so far.', {
    order_id: id('Order id, like O-12345.'),
  }),
  tool('list_orders', "List a customer's orders, newest first.", { customer_id: id('Customer id, like C-1234.') }),
  tool('refund_order', 'Refund an amount on an order, up to what is left to refund.', {
    order_id: id('Order id.'),
    amount: { type: 'number', description: 'Dollars to refund, for example 12.50.' },
  }),
  tool('update_address', "Replace a customer's postal address.", {
    customer_id: id('Customer id.'),
    street: id('Street line, like 12 Mill Road.'),
    city: id('City.'),
    postcode: id('Postcode.'),
  }),
  tool('add_note', 'Add an internal note to a ticket. The customer does not see it.', {
    ticket_id: id('Ticket id.'),
    text: id('The note.'),
  }),
  tool('close_ticket', 'Close a ticket.', { ticket_id: id('Ticket id.') }),
  tool('escalate_ticket', 'Hand a ticket to a specialist team.', {
    ticket_id: id('Ticket id.'),
    team: { type: 'string', description: 'The team that should own it.', enum: TEAMS },
  }),
  tool('send_reply', 'Send a reply to the customer on a ticket.', {
    ticket_id: id('Ticket id.'),
    text: id('The reply the customer reads.'),
  }),
]

export const ACTING = ['refund_order', 'update_address', 'add_note', 'close_ticket', 'escalate_ticket', 'send_reply']

export const orderIn = (world: SupportWorld, orderId: string): Order =>
  need(
    world.orders.find((o) => o.id === orderId),
    `order ${orderId}`,
  )

export const ticketIn = (world: SupportWorld, ticketId: string): Ticket =>
  need(
    world.tickets.find((t) => t.id === ticketId),
    `ticket ${ticketId}`,
  )

export const customerIn = (world: SupportWorld, customerId: string): Customer =>
  need(
    world.customers.find((c) => c.id === customerId),
    `customer ${customerId}`,
  )

export const retotal = (order: Order): void => {
  order.total = dollars(order.items.reduce((sum, item) => sum + cents(item.price) * item.qty, 0))
}

/** Newest first; dates are ISO, so text order is date order. */
export const ordersOf = (world: SupportWorld, customerId: string): Order[] =>
  world.orders.filter((o) => o.customer_id === customerId).sort((a, b) => b.placed_on.localeCompare(a.placed_on))

const lookUp = <T>(found: T | undefined, what: string): T => {
  if (found === undefined) {
    throw new ToolError(`no ${what}`)
  }
  return found
}

export const supportTable = (state: SupportWorld, effects: Effect[]): Record<string, (args: Args) => unknown> => {
  const order = (args: Args): Order => {
    const key = text(args, 'order_id')
    return lookUp(
      state.orders.find((o) => o.id === key),
      `order ${key}`,
    )
  }
  const ticket = (args: Args): Ticket => {
    const key = text(args, 'ticket_id')
    return lookUp(
      state.tickets.find((t) => t.id === key),
      `ticket ${key}`,
    )
  }
  const customer = (args: Args): Customer => {
    const key = text(args, 'customer_id')
    return lookUp(
      state.customers.find((c) => c.id === key),
      `customer ${key}`,
    )
  }
  const record = (tool: string, args: Args, target: string): void => {
    effects.push({ tool, args: structuredClone(args), target })
  }

  return {
    get_ticket: (args) => ticket(args),
    find_customer: (args) => {
      const query = text(args, 'query').toLowerCase()
      return state.customers
        .filter((c) => c.email === query || c.name.toLowerCase().includes(query))
        .map(({ id: customerId, name, email, address }) => ({ id: customerId, name, email, address }))
    },
    get_order: (args) => order(args),
    list_orders: (args) =>
      ordersOf(state, customer(args).id).map((o) => ({
        id: o.id,
        placed_on: o.placed_on,
        status: o.status,
        total: o.total,
      })),
    refund_order: (args) => {
      const o = order(args)
      const asked = cents(amount(args, 'amount'))
      const left = cents(o.total) - cents(o.refunded)
      if (asked > left) {
        throw new ToolError(`only ${dollars(left).toFixed(2)} is left to refund on ${o.id}`)
      }
      o.refunded = dollars(cents(o.refunded) + asked)
      record('refund_order', args, o.id)
      return { order_id: o.id, refunded_now: dollars(asked), refunded_total: o.refunded }
    },
    update_address: (args) => {
      const c = customer(args)
      c.address = { street: text(args, 'street'), city: text(args, 'city'), postcode: text(args, 'postcode') }
      record('update_address', args, c.id)
      return { customer_id: c.id, address: c.address }
    },
    add_note: (args) => {
      const t = ticket(args)
      t.notes.push(text(args, 'text'))
      record('add_note', args, t.id)
      return { ticket_id: t.id, notes: t.notes.length }
    },
    close_ticket: (args) => {
      const t = ticket(args)
      if (t.status === 'closed') {
        throw new ToolError(`${t.id} is already closed`)
      }
      t.status = 'closed'
      record('close_ticket', args, t.id)
      return { ticket_id: t.id, status: t.status }
    },
    escalate_ticket: (args) => {
      const t = ticket(args)
      const team = choice(args, 'team', TEAMS)
      if (t.status === 'closed') {
        throw new ToolError(`${t.id} is closed`)
      }
      t.status = 'escalated'
      t.team = team
      record('escalate_ticket', args, t.id)
      return { ticket_id: t.id, status: t.status, team }
    },
    send_reply: (args) => {
      const t = ticket(args)
      t.replies.push(text(args, 'text'))
      record('send_reply', args, t.id)
      return { ticket_id: t.id, sent: true }
    },
  }
}

/** The identifying values in a support world, read from its records. */
export const supportIdentities = (world: SupportWorld): string[] => [
  ...world.customers.flatMap((c) => [c.id, c.name, c.email, c.address.street, c.address.postcode]),
  ...world.orders.flatMap((o) => (o.tracking === null ? [o.id] : [o.id, o.tracking])),
  ...world.tickets.map((t) => t.id),
]
