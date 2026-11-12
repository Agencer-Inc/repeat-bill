import type { IncomingHttpHeaders } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Call, Domain, Instance, Words } from '../tasks/shared.ts'

export interface FakeOptions {
  domain: Domain
  seed: number
  days: number
  /** The words the run asks in; the fake knows only the asks of that setting. */
  words?: Words
  /** The model name a large step answers as, from the name asked. Defaults to the name asked. */
  largeAs?: (asked: string) => string
  /** Answer these tool steps as the small model with no usage, the way a door serving a step does. */
  small?: { name: string; when: (inst: Instance, step: number) => boolean }
  /** Tasks whose last acting call is swapped for the decoy (or that add it, if they do not act). */
  wrong?: ReadonlySet<string>
  /** Tasks that never stop calling a tool. */
  endless?: ReadonlySet<string>
  /** Statuses to answer the first requests with, in order, before answering normally. */
  statuses?: number[]
  /** The engine's calls under a step, named on the answer in `x-reactor-spent` as the door names them; none by default. */
  spent?: (step: number) => { model: string; tokens_in: number; tokens_out: number; purpose: string }[]
}

export interface Seen {
  url: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

export interface Fake {
  /** The base URL, ending in /v1. */
  url: string
  seen: Seen[]
  close: () => Promise<void>
}

/** Usage a large step reports: grows with the conversation, so each step's cost differs. */
export const usageAt = (step: number): { prompt_tokens: number; completion_tokens: number } => ({
  prompt_tokens: 1000 + 150 * step,
  completion_tokens: 40 + step,
})

const scriptFor = (domain: Domain, inst: Instance, wrong: boolean): Call[] => {
  const { calls } = inst.solve()
  if (!wrong) {
    return calls
  }
  const last = calls.map((c) => domain.acting.has(c.tool)).lastIndexOf(true)
  return last === -1 ? [...calls, inst.decoy()] : calls.map((c, i) => (i === last ? inst.decoy() : c))
}

export const startFake = async (opts: FakeOptions): Promise<Fake> => {
  const byAsk = new Map(opts.domain.instances(opts.seed, opts.days, opts.words).map((i) => [i.ask, i]))
  const statuses = [...(opts.statuses ?? [])]
  const seen: Seen[] = []
  let calls = 0

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(payload))
      }
      const url = req.url ?? ''
      if (req.method !== 'POST' || new URL(url, 'http://fake').pathname !== '/v1/chat/completions') {
        send(404, { error: { message: 'not found' } })
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      seen.push({ url, headers: req.headers, body })
      const status = statuses.shift()
      if (status !== undefined) {
        send(status, { error: { message: `scripted ${status}` } })
        return
      }
      const messages = body.messages as { role: string; content: unknown }[]
      const ask = messages.find((m) => m.role === 'user')?.content
      const inst = typeof ask === 'string' ? byAsk.get(ask) : undefined
      if (inst === undefined) {
        send(400, { error: { message: 'no task with that ask' } })
        return
      }
      const step = messages.filter((m) => m.role === 'assistant').length
      const script = scriptFor(opts.domain, inst, opts.wrong?.has(inst.id) ?? false)
      const endless = opts.endless?.has(inst.id) ?? false
      const next = endless ? script[0] : script[step]
      const asked = String(body.model)
      calls += 1
      const spent = opts.spent?.(step) ?? []
      const spentHeader: Record<string, string> = spent.length > 0 ? { 'x-reactor-spent': JSON.stringify(spent) } : {}
      if (next === undefined) {
        send(
          200,
          {
            id: `chatcmpl-${calls}`,
            object: 'chat.completion',
            model: opts.largeAs?.(asked) ?? asked,
            choices: [{ index: 0, message: { role: 'assistant', content: inst.solve().reply }, finish_reason: 'stop' }],
            usage: { ...usageAt(step), total_tokens: 0 },
          },
          spentHeader,
        )
        return
      }
      const toolCall = {
        id: `call_${calls}`,
        type: 'function',
        function: { name: next.tool, arguments: JSON.stringify(next.args) },
      }
      const served = opts.small?.when(inst, step) ?? false
      send(
        200,
        {
          id: `chatcmpl-${calls}`,
          object: 'chat.completion',
          model: served ? opts.small?.name : (opts.largeAs?.(asked) ?? asked),
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: [toolCall] },
              finish_reason: 'tool_calls',
            },
          ],
          ...(served ? {} : { usage: { ...usageAt(step), total_tokens: 0 } }),
        },
        spentHeader,
      )
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}
