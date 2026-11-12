import type { Picker, Rng } from '../shared.ts'
import { WORDS, cents, defineDomain, dollars, listOf, need, person as drawPerson, surnameOf } from '../shared.ts'
import { TEMPLATES } from './templates.ts'
import type {
  Item,
  JobsWorld,
  Order,
  OrderStatus,
  Person,
  PurchaseRequest,
  Vendor,
  VendorStatus,
  Want,
} from './tools.ts'
import { ACTING, ITEM_NAMES, SIZES, SYSTEM, TOOLS, jobsIdentities, jobsTable, retotal } from './tools.ts'

const KINDS = listOf('Supply Trading Wholesale Goods Depot')

/** One purchasing desk: an empty store, and the ways a job fills it. */
export interface Desk {
  world: JobsWorld
  vendor: (status?: VendorStatus, id?: string) => Vendor
  /** Catalog items a vendor sells, each under a name no other item of this desk uses. */
  stock: (vendor: Vendor, count: number) => Item[]
  /** The item's name plus a size word, sold by another vendor at a higher price. */
  lookalike: (of: Item, seller: Vendor) => Item
  request: (wants: readonly Want[], requester?: Person, id?: string) => PurchaseRequest
  /** A request one digit from another, by someone with the same surname. */
  namesake: (of: PurchaseRequest, wants: readonly Want[]) => PurchaseRequest
  /** The vendor's part of a request as an order: every line of the request this vendor sells. */
  order: (vendor: Vendor, request: PurchaseRequest, status: OrderStatus, id?: string) => Order
}

export interface JobsDraw {
  rng: Rng
  desk: () => Desk
  /** One line per item, each at a drawn qty. */
  wants: (items: readonly Item[], lo?: number, hi?: number) => Want[]
  /** A fresh id one digit from another. */
  near: (id: string) => string
}

const title = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`

const day = (offset: number): string => new Date(Date.UTC(2026, 0, 5 + offset)).toISOString().slice(0, 10)

const jobsDraws = (rng: Rng, pick: Picker): JobsDraw => {
  const numbered = (prefix: string, digits: number): string =>
    pick.fresh(() => `${prefix}-${rng.int(10 ** (digits - 1), 10 ** digits - 1)}`)

  const near = (base: string): string =>
    pick.fresh(() => {
      const [prefix, digits] = base.split('-') as [string, string]
      const at = rng.int(1, digits.length - 1)
      const swapped = (Number(digits[at]) + rng.int(1, 9)) % 10
      return `${prefix}-${digits.slice(0, at)}${swapped}${digits.slice(at + 1)}`
    })

  const person = (surname?: string): Person => {
    let drawn = drawPerson(rng, surname)
    pick.fresh(() => {
      drawn = drawPerson(rng, surname)
      return drawn.name
    })
    return { name: drawn.name, email: pick.fresh(() => drawn.email) }
  }

  const desk = (): Desk => {
    const world: JobsWorld = {
      vendors: [],
      items: [],
      requests: [],
      orders: [],
      outbox: [],
      next_ids: [0, 1, 2, 3].map(() => numbered('PO', 5)),
    }
    const unused = rng.shuffle(ITEM_NAMES)

    const vendor = (status: VendorStatus = 'active', id?: string): Vendor => {
      let pair = ['', '']
      // The email names the vendor's two words, so a fresh email is a fresh name too.
      const email = pick.fresh(() => {
        pair = rng.sample(WORDS, 2)
        return `orders@${pair.join('-')}.test`
      })
      const name = pick.fresh(() => `${pair.map(title).join(' ')} ${rng.pick(KINDS)}`)
      const made: Vendor = { id: id ?? numbered('V', 4), name, email, status }
      world.vendors.push(made)
      return made
    }

    const stock = (seller: Vendor, count: number): Item[] =>
      Array.from({ length: count }, () => {
        const made: Item = {
          sku: numbered('SK', 5),
          name: need(unused.shift(), 'an unused item name'),
          vendor_id: seller.id,
          price: dollars(rng.int(350, 18000)),
        }
        world.items.push(made)
        return made
      })

    const lookalike = (of: Item, seller: Vendor): Item => {
      const made: Item = {
        sku: numbered('SK', 5),
        name: `${of.name} ${rng.pick(SIZES)}`,
        vendor_id: seller.id,
        price: dollars(cents(of.price) + rng.int(200, 6000)),
      }
      world.items.push(made)
      return made
    }

    const request = (wants: readonly Want[], requester?: Person, id?: string): PurchaseRequest => {
      const made: PurchaseRequest = {
        id: id ?? numbered('RQ', 5),
        requester: requester ?? person(),
        lines: wants.map((w) => ({ ...w })),
      }
      world.requests.push(made)
      return made
    }

    const order = (seller: Vendor, of: PurchaseRequest, status: OrderStatus, id?: string): Order => {
      const lines = of.lines.flatMap((w) => {
        const item = world.items.find((i) => i.name === w.item && i.vendor_id === seller.id)
        return item === undefined
          ? []
          : [
              {
                sku: item.sku,
                item: item.name,
                qty: w.qty,
                price: item.price,
                received: status === 'received' ? w.qty : 0,
              },
            ]
      })
      if (lines.length === 0) {
        throw new Error(`${seller.id} sells nothing on ${of.id}`)
      }
      const made: Order = {
        id: id ?? numbered('PO', 5),
        vendor_id: seller.id,
        request_id: of.id,
        status,
        placed_on: status === 'draft' ? null : day(rng.int(0, 60)),
        lines,
        total: 0,
        note: '',
      }
      retotal(made)
      world.orders.push(made)
      return made
    }

    return {
      world,
      vendor,
      stock,
      lookalike,
      request,
      namesake: (of, wants) => request(wants, person(surnameOf(of.requester.name)), near(of.id)),
      order,
    }
  }

  return {
    rng,
    desk,
    wants: (items, lo = 1, hi = 9) => items.map((i) => ({ item: i.name, qty: rng.int(lo, hi) })),
    near,
  }
}

export const longJobs = defineDomain({
  name: 'long-jobs',
  system: SYSTEM,
  tools: TOOLS,
  acting: ACTING,
  vocabulary: ITEM_NAMES,
  templates: TEMPLATES,
  draws: jobsDraws,
  table: jobsTable,
  identities: jobsIdentities,
  // Its longest job is 15 tool calls and a reply: 16 steps, which the default 25 leaves little room to read in.
  maxSteps: 40,
})
