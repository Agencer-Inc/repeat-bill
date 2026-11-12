import type { Price, PriceBook } from '../harness/prices.ts'
import { costOf } from '../harness/prices.ts'
import type { Domain } from '../tasks/shared.ts'
import { DAYS } from '../tasks/shared.ts'

export const CHARS_PER_TOKEN = 4

export interface DomainSize {
  domain: string
  tasks: number
  steps: number
  /** Per step: day, tokens in, tokens out, and whether the step is a tool call. */
  per_step: { day: number; in: number; out: number; tool: boolean }[]
}

const tokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

/** Plays each task's reference solution through its sandbox and measures every request and answer. */
export const sizeOf = (domain: Domain, seed: number): DomainSize => {
  const instances = domain.instances(seed, DAYS)
  const perStep: DomainSize['per_step'] = []
  for (const inst of instances) {
    const session = inst.open()
    const { calls, reply } = inst.solve()
    const messages: unknown[] = [
      { role: 'system', content: domain.system },
      { role: 'user', content: inst.ask },
    ]
    calls.forEach((call, i) => {
      const asked = JSON.stringify({ messages, tools: domain.tools })
      const answer = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: `call_${i}`, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } },
        ],
      }
      perStep.push({ day: inst.day, in: tokens(asked), out: tokens(JSON.stringify(answer)), tool: true })
      messages.push(answer, {
        role: 'tool',
        tool_call_id: `call_${i}`,
        content: JSON.stringify(session.call(call.tool, call.args)),
      })
    })
    perStep.push({
      day: inst.day,
      in: tokens(JSON.stringify({ messages, tools: domain.tools })),
      out: tokens(reply),
      tool: false,
    })
  }
  return { domain: domain.name, tasks: instances.length, steps: perStep.length, per_step: perStep }
}

export interface Estimate {
  domain: string
  model: string
  plain_usd: number
  /** Every tool step after day 1 answered by the small model at no visible cost: the lowest the reactor arm reads. */
  reactor_floor_usd: number
}

export const estimateFor = (size: DomainSize, model: string, price: Price): Estimate => {
  const cost = (steps: DomainSize['per_step']): number => steps.reduce((sum, s) => sum + costOf(price, s.in, s.out), 0)
  return {
    domain: size.domain,
    model,
    plain_usd: cost(size.per_step),
    reactor_floor_usd: cost(size.per_step.filter((s) => s.day === 1 || !s.tool)),
  }
}

/** The models a run can use as its large model: every priced chat model (an output price above 0). */
export const chatModels = (book: PriceBook): string[] =>
  Object.entries(book.models)
    .filter(([, p]) => p.out_per_mtok > 0)
    .map(([model]) => model)

export const estimateTable = (domains: readonly Domain[], book: PriceBook, seed: number): string => {
  const sizes = domains.map((d) => sizeOf(d, seed))
  const rows = chatModels(book).flatMap((model) => {
    const price = book.models[model] as Price
    return sizes.map((size) => {
      const e = estimateFor(size, model, price)
      return `| ${model} | ${size.domain} | ${size.steps} | $${e.plain_usd.toFixed(2)} | $${e.reactor_floor_usd.toFixed(2)} to $${e.plain_usd.toFixed(2)} |`
    })
  })
  return [
    `| Large model | Domain | Steps | Plain arm | Reactor arm |`,
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}
