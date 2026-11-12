import type { Args, Call, Template } from '../shared.ts'
import {
  allOf,
  amountsIn,
  cents,
  dollars,
  firstIs,
  firstNamed,
  need,
  onlyEffects,
  same,
  says,
  saysAmount,
  usd,
  verdict,
} from '../shared.ts'
import type { SupportDraw } from './instances.ts'
import type { Address, Item, SupportWorld, Team } from './tools.ts'
import { CATALOG, STATUSES, TEAMS, customerIn, orderIn, retotal, ticketIn } from './tools.ts'

type SupportTemplate = Template<SupportWorld, SupportDraw>

const call = (tool: string, args: Args): Call => ({ tool, args })

const money = (value: number): string => value.toFixed(2)

const refundedIs = (state: SupportWorld, orderId: string, expected: number): string | null => {
  const got = orderIn(state, orderId).refunded
  return cents(got) === cents(expected) ? null : `${orderId} has ${usd(got)} refunded, not ${usd(expected)}`
}

const statusIs = (state: SupportWorld, ticketId: string, status: string, team?: Team): string | null => {
  const t = ticketIn(state, ticketId)
  if (t.status !== status) {
    return `${ticketId} is ${t.status}, not ${status}`
  }
  return team === undefined || t.team === team ? null : `${ticketId} went to ${t.team}, not ${team}`
}

const oneReply = (state: SupportWorld, ticketId: string, needle: (body: string) => boolean, what: string) => {
  const replies = ticketIn(state, ticketId).replies
  if (replies.length !== 1) {
    return `${ticketId} has ${replies.length} replies, not 1`
  }
  return needle(need(replies[0], 'a reply')) ? null : `the reply on ${ticketId} does not give ${what}`
}

const oneNote = (state: SupportWorld, ticketId: string, needle: string): string | null => {
  const notes = ticketIn(state, ticketId).notes
  if (notes.length !== 1) {
    return `${ticketId} has ${notes.length} notes, not 1`
  }
  return says(need(notes[0], 'a note'), needle) ? null : `the note on ${ticketId} does not say ${needle}`
}

const addressIs = (state: SupportWorld, customerId: string, want: Address): string | null => {
  const got = customerIn(state, customerId).address
  const ok = same(got.street, want.street) && same(got.city, want.city) && same(got.postcode, want.postcode)
  return ok ? null : `${customerId} lives at ${got.street}, ${got.city} ${got.postcode}`
}

const answers = (ok: boolean, what: string): string | null => (ok ? null : `the reply does not give ${what}`)

/** The kinds of value a question asks for, as they appear in a reply. */
const ORDER_ID = /\bO-\d+\b/g
const POSTCODE = /(?<![\w-])\d{5}(?![\w-])/g
const STATUS = new RegExp(`\\b(?:${STATUSES.join('|')})\\b`, 'g')

const refundFull: SupportTemplate = {
  id: 'refund-full',
  goal: 'Refund one order in full.',
  forms: [
    'Please refund order {order} in full.',
    'Order {order} needs a full refund.',
    'Can you give the customer all their money back for {order}?',
    'Issue a complete refund on {order}, please.',
    'Refund the whole of order {order}.',
    'The customer is owed the entire amount for {order}; refund it.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    return {
      world: s.world,
      slots: { order: o.id },
      solve: () => ({
        calls: [call('get_order', { order_id: o.id }), call('refund_order', { order_id: o.id, amount: o.total })],
        reply: `Refunded ${usd(o.total)} on ${o.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(onlyEffects(effects, [['refund_order', o.id]]), refundedIs(state, o.id, o.total)),
      decoy: () => call('refund_order', { order_id: s.lookalikeOrder.id, amount: s.lookalikeOrder.total }),
    }
  },
}

const refundItem: SupportTemplate = {
  id: 'refund-item',
  goal: 'Refund one item of an order, which holds exactly one of it.',
  forms: [
    'Refund just the {item} on order {order}.',
    'On {order}, the {item} came back. Refund that item only.',
    'Order {order}: please refund the {item} and nothing else.',
    'The customer returned the {item} from {order}; give them its money back.',
    'Refund the {item} line of order {order}, not the rest of it.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    const [item, rest] = d.rng.sample(o.items, 2) as [Item, Item]
    // One of it on the order, so "refund the {item}" can only mean that one line.
    item.qty = 1
    if (cents(rest.price) * rest.qty === cents(item.price)) {
      rest.price = dollars(cents(rest.price) + 1)
    }
    retotal(o)
    const line = dollars(cents(item.price) * item.qty)
    return {
      world: s.world,
      slots: { order: o.id, item: item.name },
      solve: () => ({
        calls: [call('get_order', { order_id: o.id }), call('refund_order', { order_id: o.id, amount: line })],
        reply: `Refunded ${usd(line)} for the ${item.name}.`,
      }),
      check: ({ state, effects }) =>
        verdict(onlyEffects(effects, [['refund_order', o.id]]), refundedIs(state, o.id, line)),
      decoy: () => call('refund_order', { order_id: o.id, amount: dollars(cents(rest.price) * rest.qty) }),
    }
  },
}

const refundLatestByEmail: SupportTemplate = {
  id: 'refund-latest-by-email',
  goal: 'Find a customer by email and refund their newest order in full.',
  forms: [
    'The customer at {email} wants their most recent order refunded in full.',
    'Refund the latest order placed by {email}, all of it.',
    '{email} asked for a full refund on their newest order. Please do it.',
    'Find the last order from {email} and refund it completely.',
    'Give {email} a full refund on the order they placed most recently.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    return {
      world: s.world,
      slots: { email: s.target.email },
      solve: () => ({
        calls: [
          call('find_customer', { query: s.target.email }),
          call('list_orders', { customer_id: s.target.id }),
          call('refund_order', { order_id: o.id, amount: o.total }),
        ],
        reply: `Refunded ${usd(o.total)} on ${o.id}, the newest order.`,
      }),
      check: ({ state, effects }) =>
        verdict(onlyEffects(effects, [['refund_order', o.id]]), refundedIs(state, o.id, o.total)),
      decoy: () => call('refund_order', { order_id: s.older.id, amount: s.older.total }),
    }
  },
}

const addressUpdate: SupportTemplate = {
  id: 'address-update',
  goal: "Replace a customer's address with the one given in the ask.",
  forms: [
    'The customer {email} has moved. Their new address is {street}, {city} {postcode}. Please update it.',
    'Update the address for {email} to {street}, {city}, {postcode}.',
    'New address for the customer with email {email}: {street}, {city} {postcode}.',
    "Change {email}'s address on file to {street}, {city} {postcode}.",
    'Please record that {email} now lives at {street}, {city} {postcode}.',
  ],
  make: (d) => {
    const s = d.shop()
    const next = d.address()
    return {
      world: s.world,
      slots: { email: s.target.email, ...next },
      solve: () => ({
        calls: [
          call('find_customer', { query: s.target.email }),
          call('update_address', { customer_id: s.target.id, ...next }),
        ],
        reply: `Updated the address for ${s.target.name}.`,
      }),
      check: ({ state, effects }) =>
        verdict(onlyEffects(effects, [['update_address', s.target.id]]), addressIs(state, s.target.id, next)),
      decoy: () => call('update_address', { customer_id: s.namesake.id, ...next }),
    }
  },
}

const noteAndClose: SupportTemplate = {
  id: 'note-and-close',
  goal: 'Add a given note to a ticket, then close it.',
  forms: [
    'Add the note "{note}" to ticket {ticket}, then close it.',
    'Close {ticket}, leaving this note on it first: {note}',
    'Ticket {ticket} is done. Note "{note}" and close it.',
    'Please put "{note}" as a note on {ticket} and close the ticket.',
    'Write the note "{note}" on {ticket} and mark it closed.',
  ],
  make: (d) => {
    const s = d.shop()
    const t = s.ticket
    const code = d.code('ref')
    const note = `Resolved by phone, ${code}`
    return {
      world: s.world,
      slots: { ticket: t.id, note },
      solve: () => ({
        calls: [call('add_note', { ticket_id: t.id, text: note }), call('close_ticket', { ticket_id: t.id })],
        reply: `Noted and closed ${t.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['add_note', t.id],
            ['close_ticket', t.id],
          ]),
          oneNote(state, t.id, code),
          statusIs(state, t.id, 'closed'),
        ),
      decoy: () => call('close_ticket', { ticket_id: s.lookalikeTicket.id }),
    }
  },
}

const escalateNamed: SupportTemplate = {
  id: 'escalate-named',
  goal: 'Escalate a ticket to the team named in the ask.',
  forms: [
    'Escalate ticket {ticket} to the {team} team.',
    'Send {ticket} up to {team}.',
    '{ticket} needs the {team} team; escalate it.',
    'Please hand ticket {ticket} over to {team} as an escalation.',
    'Escalate {ticket}. It belongs with {team}.',
  ],
  make: (d) => {
    const s = d.shop()
    const t = s.ticket
    const team = d.rng.pick(TEAMS)
    return {
      world: s.world,
      slots: { ticket: t.id, team },
      solve: () => ({
        calls: [call('escalate_ticket', { ticket_id: t.id, team })],
        reply: `Escalated ${t.id} to ${team}.`,
      }),
      check: ({ state, effects }) =>
        verdict(onlyEffects(effects, [['escalate_ticket', t.id]]), statusIs(state, t.id, 'escalated', team)),
      decoy: () => call('escalate_ticket', { ticket_id: s.lookalikeTicket.id, team }),
    }
  },
}

const TOPICS: Record<Team, readonly string[]> = {
  billing: [
    'I was charged twice for order {order}. Please put it right.',
    'The amount taken from my card for order {order} is more than the order total.',
    'My invoice for order {order} shows a charge I never agreed to.',
  ],
  shipping: [
    'My parcel for order {order} has still not arrived.',
    'Order {order} was delivered to the wrong house.',
    'The tracking for order {order} has not moved in a week.',
  ],
  technical: [
    'I cannot log in to see order {order}; the page shows an error.',
    'Your app closes itself every time I open order {order}.',
    'The password reset email never comes, so I cannot see order {order}.',
  ],
}

const escalateByTopic: SupportTemplate = {
  id: 'escalate-by-topic',
  goal: 'Read a ticket and escalate it to the team its problem belongs to.',
  forms: [
    'Read ticket {ticket} and escalate it to whichever team should handle it.',
    'Ticket {ticket} needs escalating. Work out the right team from what it says.',
    'Look at {ticket} and send it to the team that deals with that kind of problem.',
    'Which team should own {ticket}? Escalate it to them.',
    'Please route ticket {ticket} to the correct team as an escalation.',
  ],
  make: (d) => {
    const s = d.shop()
    const t = s.ticket
    const team = d.rng.pick(TEAMS)
    const wrong = need(
      TEAMS.find((x) => x !== team),
      'another team',
    )
    t.subject = 'Help with my order'
    t.body = `Hello, ${d.rng.pick(TOPICS[team]).replace('{order}', s.order.id)} ${s.target.name}`
    return {
      world: s.world,
      slots: { ticket: t.id },
      solve: () => ({
        calls: [call('get_ticket', { ticket_id: t.id }), call('escalate_ticket', { ticket_id: t.id, team })],
        reply: `Escalated ${t.id} to ${team}.`,
      }),
      check: ({ state, effects }) =>
        verdict(onlyEffects(effects, [['escalate_ticket', t.id]]), statusIs(state, t.id, 'escalated', team)),
      decoy: () => call('escalate_ticket', { ticket_id: t.id, team: wrong }),
    }
  },
}

const replyTracking: SupportTemplate = {
  id: 'reply-tracking',
  goal: "Reply on a ticket with the tracking number of the ticket's order.",
  forms: [
    'Ticket {ticket} asks where their parcel is. Reply on the ticket with the tracking number.',
    'Send the customer on {ticket} their tracking number.',
    'Answer {ticket} with the tracking number for their order.',
    'The customer on ticket {ticket} wants to track their order. Reply to them with it.',
    'Please reply to {ticket} giving the parcel tracking number.',
  ],
  make: (d) => {
    const s = d.shop()
    const t = s.ticket
    for (const o of [s.order, s.lookalikeOrder]) {
      o.status = 'shipped'
      o.tracking ??= d.tracking()
    }
    const tracking = need(s.order.tracking ?? undefined, 'a tracking number')
    t.body = `Hello, where is my parcel for order ${s.order.id}? ${s.target.name}`
    return {
      world: s.world,
      slots: { ticket: t.id },
      solve: () => ({
        calls: [
          call('get_ticket', { ticket_id: t.id }),
          call('get_order', { order_id: s.order.id }),
          call('send_reply', { ticket_id: t.id, text: `Your parcel's tracking number is ${tracking}.` }),
        ],
        reply: `Sent ${tracking} on ${t.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [['send_reply', t.id]]),
          oneReply(state, t.id, (body) => says(body, tracking), 'the tracking number'),
        ),
      decoy: () => call('send_reply', { ticket_id: t.id, text: `Tracking: ${s.lookalikeOrder.tracking ?? ''}` }),
    }
  },
}

const talkOrderTotal: SupportTemplate = {
  id: 'talk-order-total',
  goal: "Say an order's total.",
  forms: [
    'What did order {order} come to?',
    'How much was order {order} in total?',
    'Tell me the total of {order}.',
    'What is the order total on {order}?',
    'I need the total amount for order {order}.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    return {
      world: s.world,
      slots: { order: o.id },
      solve: () => ({
        calls: [call('get_order', { order_id: o.id })],
        reply: `Order ${o.id} came to ${usd(o.total)}.`,
      }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          // The total anywhere in the reply: its sentence is style, not the check's (2026-10-29).
          answers(
            amountsIn(reply).some((n) => cents(n) === cents(o.total)),
            `the total ${money(o.total)}`,
          ),
        ),
      decoy: () => call('refund_order', { order_id: o.id, amount: o.total }),
    }
  },
}

const talkLatestStatus: SupportTemplate = {
  id: 'talk-latest-status',
  goal: "Say a customer's newest order id and its status.",
  forms: [
    'Which order did {email} place most recently, and what is its status?',
    'For the customer {email}: what is their newest order and where does it stand?',
    'Give me the latest order id for {email} and its status.',
    'What is the status of the last order {email} placed? Include the order id.',
    "Look up {email}'s most recent order and tell me its id and status.",
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    return {
      world: s.world,
      slots: { email: s.target.email },
      solve: () => ({
        calls: [call('find_customer', { query: s.target.email }), call('list_orders', { customer_id: s.target.id })],
        reply: `The newest order is ${o.id}, and it is ${o.status}.`,
      }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(allOf(reply, ORDER_ID), (id) => id === o.id),
            `the order id ${o.id} first`,
          ),
          answers(
            firstIs(allOf(reply.toLowerCase(), STATUS), (s) => s === o.status),
            `the status ${o.status} first`,
          ),
        ),
      decoy: () => call('add_note', { ticket_id: s.ticket.id, text: `Newest order ${o.id}` }),
    }
  },
}

const talkPostcode: SupportTemplate = {
  id: 'talk-postcode',
  goal: "Say the postcode on a customer's account.",
  forms: [
    'What postcode do we have on file for {email}?',
    'Tell me the postcode of the customer {email}.',
    'Which postcode is on the account for {email}?',
    'Look up {email} and give me their postcode.',
    'I need the postcode for the customer at {email}.',
  ],
  make: (d) => {
    const s = d.shop()
    const postcode = s.target.address.postcode
    return {
      world: s.world,
      slots: { email: s.target.email },
      solve: () => ({
        calls: [call('find_customer', { query: s.target.email })],
        reply: `Their postcode is ${postcode}.`,
      }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(allOf(reply, POSTCODE), (p) => p === postcode),
            `the postcode ${postcode} first`,
          ),
        ),
      decoy: () => call('update_address', { customer_id: s.target.id, ...s.namesake.address }),
    }
  },
}

const refundAndReply: SupportTemplate = {
  id: 'refund-and-reply',
  goal: 'Refund an order in full and tell the customer the amount on their ticket.',
  forms: [
    'Refund order {order} in full and tell the customer on ticket {ticket} how much was refunded.',
    'Fully refund {order}, then reply on {ticket} with the refunded amount.',
    'Please give a full refund for {order} and let the customer know the amount through ticket {ticket}.',
    'Refund all of {order}. Reply to {ticket} saying how much went back to them.',
    'Order {order} gets a complete refund; confirm the amount to the customer on {ticket}.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    const t = s.ticket
    return {
      world: s.world,
      slots: { order: o.id, ticket: t.id },
      solve: () => ({
        calls: [
          call('get_order', { order_id: o.id }),
          call('refund_order', { order_id: o.id, amount: o.total }),
          call('send_reply', { ticket_id: t.id, text: `We have refunded ${usd(o.total)} for order ${o.id}.` }),
        ],
        reply: `Refunded and told the customer on ${t.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['refund_order', o.id],
            ['send_reply', t.id],
          ]),
          refundedIs(state, o.id, o.total),
          oneReply(state, t.id, (body) => saysAmount(body, o.total), 'the refunded amount'),
        ),
      decoy: () => call('refund_order', { order_id: s.lookalikeOrder.id, amount: s.lookalikeOrder.total }),
    }
  },
}

const refundFromTicket: SupportTemplate = {
  id: 'refund-from-ticket',
  goal: 'Refund in full the order a ticket is about, then close the ticket.',
  forms: [
    'Ticket {ticket} is about a damaged item. Refund the order it mentions in full and close the ticket.',
    'Read {ticket}, refund the whole order it is about, then close it.',
    'The customer on {ticket} got a broken delivery. Give a full refund on that order and close the ticket.',
    'Please handle {ticket}: a full refund for its order, then close it.',
    'Close ticket {ticket} once you have fully refunded the order it refers to.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    const t = s.ticket
    t.body = `Hello, order ${o.id} arrived broken. I would like my money back, please. ${s.target.name}`
    return {
      world: s.world,
      slots: { ticket: t.id },
      solve: () => ({
        calls: [
          call('get_ticket', { ticket_id: t.id }),
          call('get_order', { order_id: o.id }),
          call('refund_order', { order_id: o.id, amount: o.total }),
          call('close_ticket', { ticket_id: t.id }),
        ],
        reply: `Refunded ${usd(o.total)} on ${o.id} and closed ${t.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['refund_order', o.id],
            ['close_ticket', t.id],
          ]),
          refundedIs(state, o.id, o.total),
          statusIs(state, t.id, 'closed'),
        ),
      decoy: () => call('refund_order', { order_id: s.older.id, amount: s.older.total }),
    }
  },
}

const addressFromTicket: SupportTemplate = {
  id: 'address-from-ticket',
  goal: "Put the new address a ticket gives on the customer's account, then close the ticket.",
  forms: [
    "Ticket {ticket} has the customer's new address. Update their account with it and close the ticket.",
    "Read {ticket}, put the new address it gives on the customer's account, then close it.",
    'The customer on {ticket} moved; their new address is in the ticket. Update it and close the ticket.',
    'Please apply the address change in ticket {ticket} and close it.',
    'Update the address on file from what ticket {ticket} says, then mark the ticket closed.',
  ],
  make: (d) => {
    const s = d.shop()
    const t = s.ticket
    const next = d.address()
    t.order_id = null
    t.subject = 'New address'
    t.body = `Hello, I have moved. My new address is ${next.street}, ${next.city} ${next.postcode}. Please update my account. ${s.target.name}`
    return {
      world: s.world,
      slots: { ticket: t.id },
      solve: () => ({
        calls: [
          call('get_ticket', { ticket_id: t.id }),
          call('update_address', { customer_id: s.target.id, ...next }),
          call('close_ticket', { ticket_id: t.id }),
        ],
        reply: `Updated the address and closed ${t.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['update_address', s.target.id],
            ['close_ticket', t.id],
          ]),
          addressIs(state, s.target.id, next),
          statusIs(state, t.id, 'closed'),
        ),
      decoy: () => call('update_address', { customer_id: s.namesake.id, ...next }),
    }
  },
}

const goodwillRefund: SupportTemplate = {
  id: 'goodwill-refund',
  goal: 'Refund a stated part of an order.',
  forms: [
    'Give {name} a goodwill refund of ${amount} on order {order}.',
    'Refund ${amount} on {order} as a goodwill gesture for {name}.',
    'Please refund {name} ${amount} against order {order}.',
    'Order {order}: refund ${amount} to {name}, as a courtesy.',
    'Put through a ${amount} partial refund on {order} for {name}.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    const part = dollars(d.rng.int(300, Math.floor(cents(o.total) / 3)))
    return {
      world: s.world,
      slots: { name: s.target.name, amount: money(part), order: o.id },
      solve: () => ({
        calls: [call('refund_order', { order_id: o.id, amount: part })],
        reply: `Refunded ${usd(part)} on ${o.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(onlyEffects(effects, [['refund_order', o.id]]), refundedIs(state, o.id, part)),
      decoy: () => call('refund_order', { order_id: o.id, amount: dollars(cents(part) * 2) }),
    }
  },
}

const escalateWithNote: SupportTemplate = {
  id: 'escalate-with-note',
  goal: 'Add a given note to a ticket and escalate it to a named team.',
  forms: [
    'Escalate ticket {ticket} to {team} and add the note "{note}".',
    'Add "{note}" as a note on {ticket}, then escalate it to the {team} team.',
    'Send {ticket} to {team} with this note: {note}',
    'Please note "{note}" on {ticket} and escalate it to {team}.',
    '{ticket} goes to {team}. Leave the note "{note}" on it too.',
  ],
  make: (d) => {
    const s = d.shop()
    const t = s.ticket
    const team = d.rng.pick(TEAMS)
    const code = d.code('case')
    const note = `Customer called back, ${code}`
    return {
      world: s.world,
      slots: { ticket: t.id, team, note },
      solve: () => ({
        calls: [call('add_note', { ticket_id: t.id, text: note }), call('escalate_ticket', { ticket_id: t.id, team })],
        reply: `Noted and escalated ${t.id} to ${team}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['add_note', t.id],
            ['escalate_ticket', t.id],
          ]),
          oneNote(state, t.id, code),
          statusIs(state, t.id, 'escalated', team),
        ),
      decoy: () => call('escalate_ticket', { ticket_id: s.lookalikeTicket.id, team }),
    }
  },
}

const replyRefundedSoFar: SupportTemplate = {
  id: 'reply-refunded-so-far',
  goal: "Reply on a ticket with how much has been refunded on the ticket's order so far.",
  forms: [
    'On ticket {ticket}, reply telling the customer how much has been refunded on their order so far.',
    'Let the customer on {ticket} know the total refunded on their order to date.',
    'Reply to {ticket} with the amount we have refunded on the order it is about.',
    'The customer on {ticket} asks how much they have had back. Reply with the refunded total.',
    'Answer ticket {ticket}: how much has been refunded on that order?',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    const t = s.ticket
    o.refunded = dollars(d.rng.int(100, cents(o.total) - 100))
    t.body = `Hello, how much of order ${o.id} have you refunded so far? ${s.target.name}`
    return {
      world: s.world,
      slots: { ticket: t.id },
      solve: () => ({
        calls: [
          call('get_ticket', { ticket_id: t.id }),
          call('get_order', { order_id: o.id }),
          call('send_reply', { ticket_id: t.id, text: `So far we have refunded ${usd(o.refunded)} on ${o.id}.` }),
        ],
        reply: `Told the customer ${usd(o.refunded)}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [['send_reply', t.id]]),
          oneReply(state, t.id, (body) => saysAmount(body, o.refunded), 'the refunded amount'),
        ),
      decoy: () => call('send_reply', { ticket_id: t.id, text: `Your order came to ${usd(o.total)}.` }),
    }
  },
}

const talkOrderItems: SupportTemplate = {
  id: 'talk-order-items',
  goal: 'Name every item on an order.',
  forms: [
    'Which items are on order {order}?',
    'List what was bought on {order}.',
    'What products are in order {order}?',
    'Tell me the items in {order}.',
    'What did the customer order on {order}? Just the item names.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    const names = o.items.map((item) => item.name)
    return {
      world: s.world,
      slots: { order: o.id },
      solve: () => ({
        calls: [call('get_order', { order_id: o.id })],
        reply: `Order ${o.id} has ${names.join(', ')}.`,
      }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(names.includes(firstNamed(reply, CATALOG) ?? ''), 'an item of this order first'),
          ...names.map((name) => answers(says(reply, name), `the item ${name}`)),
        ),
      decoy: () => call('close_ticket', { ticket_id: s.ticket.id }),
    }
  },
}

const refundCheapest: SupportTemplate = {
  id: 'refund-cheapest',
  goal: 'Refund the cheapest item on an order.',
  forms: [
    'Refund the cheapest item on order {order}.',
    'On {order}, refund whichever item cost the least.',
    'Order {order}: give the customer back the price of its lowest-priced item.',
    'Refund the least expensive item on {order}.',
    'Find the cheapest thing on order {order} and refund it.',
  ],
  make: (d) => {
    const s = d.shop()
    const o = s.order
    const seen = new Set<number>()
    for (const item of o.items) {
      item.qty = 1
      while (seen.has(cents(item.price))) {
        item.price = dollars(cents(item.price) + 1)
      }
      seen.add(cents(item.price))
    }
    retotal(o)
    const prices = o.items.map((item) => item.price).sort((a, b) => a - b)
    const cheapest = need(prices[0], 'a cheapest price')
    const dearest = need(prices.at(-1), 'a dearest price')
    return {
      world: s.world,
      slots: { order: o.id },
      solve: () => ({
        calls: [call('get_order', { order_id: o.id }), call('refund_order', { order_id: o.id, amount: cheapest })],
        reply: `Refunded ${usd(cheapest)}, the cheapest item.`,
      }),
      check: ({ state, effects }) =>
        verdict(onlyEffects(effects, [['refund_order', o.id]]), refundedIs(state, o.id, cheapest)),
      decoy: () => call('refund_order', { order_id: o.id, amount: dearest }),
    }
  },
}

const closeTwo: SupportTemplate = {
  id: 'close-two',
  goal: 'Close two named tickets.',
  forms: [
    'Close tickets {one} and {two}; both are resolved.',
    'Both {one} and {two} are sorted. Please close them.',
    'Mark {one} and {two} as closed.',
    'Please close {two} and {one}.',
    '{one} and {two} can both be closed now.',
  ],
  make: (d) => {
    const s = d.shop()
    const [one, two] = [s.ticket, s.second]
    return {
      world: s.world,
      slots: { one: one.id, two: two.id },
      solve: () => ({
        calls: [call('close_ticket', { ticket_id: one.id }), call('close_ticket', { ticket_id: two.id })],
        reply: `Closed ${one.id} and ${two.id}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['close_ticket', one.id],
            ['close_ticket', two.id],
          ]),
          statusIs(state, one.id, 'closed'),
          statusIs(state, two.id, 'closed'),
        ),
      decoy: () => call('close_ticket', { ticket_id: s.lookalikeTicket.id }),
    }
  },
}

export const TEMPLATES: readonly SupportTemplate[] = [
  refundFull,
  refundItem,
  refundLatestByEmail,
  addressUpdate,
  noteAndClose,
  escalateNamed,
  escalateByTopic,
  replyTracking,
  talkOrderTotal,
  talkLatestStatus,
  talkPostcode,
  refundAndReply,
  refundFromTicket,
  addressFromTicket,
  goodwillRefund,
  escalateWithNote,
  replyRefundedSoFar,
  talkOrderItems,
  refundCheapest,
  closeTwo,
]
