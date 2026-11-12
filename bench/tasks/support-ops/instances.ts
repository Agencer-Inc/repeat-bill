import type { Picker, Rng } from '../shared.ts'
import { defineDomain, dollars, listOf, need, person, surnameOf } from '../shared.ts'
import { TEMPLATES } from './templates.ts'
import type { Address, Customer, Item, Order, SupportWorld, Ticket } from './tools.ts'
import { ACTING, CATALOG, STATUSES, SYSTEM, TEAMS, TOOLS, retotal, supportIdentities, supportTable } from './tools.ts'

const CITIES = listOf('Leeds Porto Austin Lyon Osaka Tampere Cork Graz Malmo Ghent Bergen Utrecht')
const STREETS = listOf('Elm Harbor Mill Station Orchard Chapel Bridge Market Castle Victoria Park Quarry Canal')
const STREET_KINDS = listOf('Street Road Lane Avenue Way')

/** A customer to act for, one with the same surname, and an unrelated one; orders and open tickets for each. */
export interface Shop {
  world: SupportWorld
  target: Customer
  namesake: Customer
  /** The target's newest order, and the one before it. */
  order: Order
  older: Order
  /** The target's open tickets: about `order`, and about `older`. */
  ticket: Ticket
  second: Ticket
  /** The namesake's newest order and its ticket, each id one digit from the target's. */
  lookalikeOrder: Order
  lookalikeTicket: Ticket
}

export interface SupportDraw {
  rng: Rng
  shop: () => Shop
  address: () => Address
  tracking: () => string
  /** A fresh code to quote in a note, like `ref 4821`. */
  code: (label: string) => string
}

const day = (offset: number): string => new Date(Date.UTC(2026, 0, 5 + offset)).toISOString().slice(0, 10)

const supportDraws = (rng: Rng, pick: Picker): SupportDraw => {
  const numbered = (prefix: string, digits: number): string =>
    pick.fresh(() => `${prefix}-${rng.int(10 ** (digits - 1), 10 ** digits - 1)}`)

  const near = (base: string): string =>
    pick.fresh(() => {
      const [prefix, digits] = base.split('-') as [string, string]
      const at = rng.int(1, digits.length - 1)
      const swapped = (Number(digits[at]) + rng.int(1, 9)) % 10
      return `${prefix}-${digits.slice(0, at)}${swapped}${digits.slice(at + 1)}`
    })

  const address = (): Address => ({
    street: pick.fresh(() => `${rng.int(2, 980)} ${rng.pick(STREETS)} ${rng.pick(STREET_KINDS)}`),
    city: rng.pick(CITIES),
    postcode: pick.fresh(() => String(rng.int(10000, 99999))),
  })

  const customer = (surname?: string): Customer => {
    let drawn = person(rng, surname)
    pick.fresh(() => {
      drawn = person(rng, surname)
      return drawn.name
    })
    return { id: numbered('C', 4), name: drawn.name, email: pick.fresh(() => drawn.email), address: address() }
  }

  const tracking = (): string => pick.fresh(() => `1Z${rng.int(100000, 999999)}${rng.int(1000, 9999)}`)

  const orders = (owner: Customer, count: number, firstId?: string): Order[] => {
    const offsets = rng.sample([...Array(270).keys()], count).sort((a, b) => b - a)
    return offsets.map((offset, i) => {
      const items: Item[] = rng.sample(CATALOG, rng.int(2, 3)).map((name) => ({
        name,
        qty: rng.next() < 0.75 ? 1 : 2,
        price: dollars(rng.int(450, 12999)),
      }))
      const status = rng.pick(STATUSES)
      const order: Order = {
        id: i === 0 && firstId !== undefined ? firstId : numbered('O', 5),
        customer_id: owner.id,
        placed_on: day(offset),
        status,
        items,
        total: 0,
        refunded: 0,
        tracking: status === 'processing' ? null : tracking(),
      }
      retotal(order)
      return order
    })
  }

  const ticket = (world: SupportWorld, owner: Customer, order: Order | null, ticketId?: string): Ticket => {
    const made: Ticket = {
      id: ticketId ?? numbered('T', 5),
      customer_id: owner.id,
      order_id: order?.id ?? null,
      subject: order === null ? 'A question' : `About order ${order.id}`,
      body:
        order === null
          ? `Hello, I have a question about my account. Thanks, ${owner.name}`
          : `Hello, I have a question about my order ${order.id}. Thanks, ${owner.name}`,
      status: 'open',
      team: null,
      notes: [],
      replies: [],
    }
    world.tickets.push(made)
    return made
  }

  const shop = (): Shop => {
    const target = customer()
    const namesake = customer(surnameOf(target.name))
    const other = customer()
    const world: SupportWorld = { customers: rng.shuffle([target, namesake, other]), orders: [], tickets: [] }
    const mine = orders(target, 3)
    const order = need(mine[0], 'a newest order')
    const older = need(mine[1], 'an older order')
    const theirs = orders(namesake, 2, near(order.id))
    const lookalikeOrder = need(theirs[0], 'a namesake order')
    world.orders = rng.shuffle([...mine, ...theirs, ...orders(other, 2)])
    const first = ticket(world, target, order)
    const second = ticket(world, target, older)
    const lookalikeTicket = ticket(world, namesake, lookalikeOrder, near(first.id))
    ticket(world, other, null)
    world.tickets = rng.shuffle(world.tickets)
    return { world, target, namesake, order, older, ticket: first, second, lookalikeOrder, lookalikeTicket }
  }

  return {
    rng,
    shop,
    address,
    tracking,
    code: (label) => pick.fresh(() => `${label} ${rng.int(1000, 9999)}`),
  }
}

export const supportOps = defineDomain({
  name: 'support-ops',
  system: SYSTEM,
  tools: TOOLS,
  acting: ACTING,
  vocabulary: [...TEAMS, ...CITIES, ...CATALOG],
  templates: TEMPLATES,
  draws: supportDraws,
  table: supportTable,
  identities: supportIdentities,
})
