import { describe, expect, it } from 'vitest'
import { playJobWithLibrary } from '../harness/library-client.ts'
import type { Deps, Event, Job, Reply } from '../harness/playbook-client.ts'
import type { Answer } from '../harness/run.ts'

/** A playbook with no step: the job is the agent's from the first turn, so its calls go through pass. */
const PLAYBOOK = { job_id: 'job-1', ask: 'ask', source: 'cold', needs_model: false, steps: [] }

const ok = (body: Record<string, unknown>): Answer => ({ ok: true, body, spent: [], latencyMs: 3, retries: 0 })

const completion = (content: string): Record<string, unknown> => ({
  id: 'c1',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
})

const job = (): Job => ({
  ask: 'ask',
  tools: [{ type: 'function', function: { name: 'get_order' } }],
  jobId: 'job-1',
  allowModel: true,
  messages: [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'ask' },
  ],
  maxSteps: 5,
})

interface Posted {
  path: string
  body: Record<string, unknown>
  headers: Record<string, string> | undefined
}

/** Deps whose door answers each path from a script, recording what it was sent; its chat is the agent's own. */
const depsFor = (
  door: (path: string, body: Record<string, unknown>) => Answer,
): { deps: Deps; posted: Posted[]; chats: number[] } => {
  const posted: Posted[] = []
  const chats: number[] = []
  const deps: Deps = {
    post: async (path, body, headers) => {
      posted.push({ path, body: body as Record<string, unknown>, headers })
      return door(path, body as Record<string, unknown>)
    },
    chat: async (messages): Promise<Reply> => {
      chats.push(messages.length)
      return { kind: 'words', words: 'agent words', by: 'big-model', answer: ok(completion('agent words')) }
    },
    call: () => ({}),
    failed: () => false,
    nonce: () => 'n',
    now: () => '2026-11-03T00:00:00.000Z',
    large: 'big-model',
  }
  return { deps, posted, chats }
}

const doorEvents = (events: Event[], route: string) =>
  events.flatMap((e) => (e.kind === 'door' && e.route === route ? [e] : []))

describe('the library client over pass', () => {
  it("posts the agent's call to pass and uses the served completion", async () => {
    const { deps, posted, chats } = depsFor((path) =>
      path === 'playbooks'
        ? ok(PLAYBOOK)
        : path.endsWith('/pass')
          ? ok({ kind: 'served', answer: completion('the door wrote this'), filled_by: 'small', spent: [] })
          : ok({}),
    )
    const trace = await playJobWithLibrary(job(), { ...deps, providerKey: 'sk-provider-secret' })
    const pass = posted.find((p) => p.path === 'playbooks/job-1/pass')
    expect(pass?.body).toMatchObject({ model: 'big-model', tools: job().tools })
    expect((pass?.body.messages as unknown[]).length).toBe(2)
    // The door sees the fingerprint of the provider key and never the key.
    expect(pass?.headers?.['x-reactor-provider-fingerprint']).toMatch(/\S/)
    expect(JSON.stringify(posted)).not.toContain('sk-provider-secret')
    expect(chats).toEqual([])
    expect(trace.ended).toBe('done')
    expect(trace.reply).toBe('the door wrote this')
    expect(doorEvents(trace.events, 'playbooks/pass')).toMatchObject([{ said: 'served' }])
    expect(trace.events.find((e) => e.kind === 'reply')).toMatchObject({
      reply: { kind: 'words', served: 'small' },
    })
  })

  it('runs a run_model round with the runner and posts the answer', async () => {
    const prompts: string[] = []
    const { deps, posted, chats } = depsFor((path, body) => {
      if (path === 'playbooks') {
        return ok(PLAYBOOK)
      }
      if (path.endsWith('/pass')) {
        return ok({
          kind: 'run_model',
          model: 'small',
          prompt: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, temperature: 0 },
          token: 'tok-1',
          spent: [],
        })
      }
      if (path.endsWith('/answer')) {
        expect(body).toMatchObject({ token: 'tok-1', text: 'ran words', usage: { tokens_in: 7, tokens_out: 2 } })
        return ok({ kind: 'served', answer: completion('ran words'), filled_by: 'small', spent: [] })
      }
      return ok({})
    })
    const trace = await playJobWithLibrary(job(), {
      ...deps,
      runner: async (prompt, model) => {
        prompts.push(`${model}:${String(prompt.messages[0]?.content)}`)
        return { text: 'ran words', usage: { tokens_in: 7, tokens_out: 2 } }
      },
    })
    expect(prompts).toEqual(['small:hi'])
    expect(posted.map((p) => p.path)).toEqual([
      'playbooks',
      'playbooks/job-1/pass',
      'playbooks/job-1/answer',
      'playbooks/report',
    ])
    expect(chats).toEqual([])
    // The round is a door line on its own route, with the model the runner ran it on and the count it gave; the pass
    // line says a round was asked, and the round's line carries the verdict the pass settled on, as the pass's own.
    expect(doorEvents(trace.events, 'playbooks/pass')).toMatchObject([{ said: 'run_model' }])
    expect(doorEvents(trace.events, 'playbooks/answer')).toMatchObject([
      { said: 'served', settles: 'playbooks/pass', ran: { model: 'small', usage: { tokens_in: 7, tokens_out: 2 } } },
    ])
    expect(trace.reply).toBe('ran words')
  })

  it("records the verdict a playbook's or a fill's rounds settled on as that route's own, with its step", async () => {
    // A plan that took a small round, then a fill the door wrote on a large round (the 2026-11-04 rerun's get_order):
    // the first post of each says run_model, and its settling round says what the route answered.
    const blank = { name: 'order_id', value: null, local: false, filled_by: null }
    const planned = {
      job_id: 'job-1',
      ask: 'ask',
      source: 'plan',
      needs_model: false,
      steps: [{ step_no: 1, tool: 'get_order', blanks: [blank] }],
    }
    const filled = { step_no: 1, tool: 'get_order', blanks: [{ ...blank, value: 'A-1', filled_by: 'model' }] }
    const round = (model: 'small' | 'large', token: string) => ({
      kind: 'run_model',
      model,
      prompt: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, temperature: 1 },
      token,
      spent: [],
    })
    const { deps, posted } = depsFor((path, body) => {
      if (path === 'playbooks') {
        return ok(round('small', 'tok-p'))
      }
      if (path === 'playbooks/fill') {
        return ok(round('large', 'tok-f'))
      }
      if (path.endsWith('/answer')) {
        return body.token === 'tok-p'
          ? ok(planned)
          : ok({ kind: 'filled', step: filled, filled_by: 'large', spent: [] })
      }
      return ok({})
    })
    const trace = await playJobWithLibrary(job(), {
      ...deps,
      runner: async () => ({ text: 'ran words', usage: { tokens_in: 7, tokens_out: 2 } }),
    })
    expect(posted.map((p) => p.path)).toEqual([
      'playbooks',
      'playbooks/job-1/answer',
      'playbooks/fill',
      'playbooks/job-1/answer',
      'playbooks/report',
    ])
    expect(doorEvents(trace.events, 'playbooks')).toMatchObject([{ said: 'run_model' }])
    expect(doorEvents(trace.events, 'playbooks/fill')).toMatchObject([
      { said: 'run_model', step_no: 1, tool: 'get_order' },
    ])
    expect(doorEvents(trace.events, 'playbooks/answer')).toMatchObject([
      { said: 'plan', settles: 'playbooks', step_no: null, tool: null, ran: { model: 'small' } },
      { said: 'filled', settles: 'playbooks/fill', step_no: 1, tool: 'get_order', ran: { model: 'large' } },
    ])
    expect(trace.events.filter((e) => e.kind === 'tool')).toMatchObject([{ tool: 'get_order', filled_by: 'large' }])
  })

  it('keeps the call a tool refused and its words on the event, as the bare client does', async () => {
    // The 11-06 rerun's escalate-named d2: the door filled the step from the ask, the tool refused it, and the record
    // said only that one call failed, not what was sent.
    const blank = { name: 'team', value: null, local: false, filled_by: null }
    const planned = {
      job_id: 'job-1',
      ask: 'ask',
      source: 'plan',
      needs_model: false,
      steps: [{ step_no: 1, tool: 'escalate_ticket', blanks: [blank] }],
    }
    const filled = {
      step_no: 1,
      tool: 'escalate_ticket',
      blanks: [{ ...blank, value: 'the billing team', filled_by: 'ask' }],
    }
    const { deps } = depsFor((path) =>
      path === 'playbooks'
        ? ok(planned)
        : path === 'playbooks/fill'
          ? ok({ kind: 'filled', step: filled, filled_by: 'ask', spent: [] })
          : ok({}),
    )
    const trace = await playJobWithLibrary(job(), {
      ...deps,
      call: () => ({ error: 'team must be one of billing, shipping, technical' }),
      failed: (result) => typeof (result as { error?: unknown }).error === 'string',
    })
    expect(trace).toMatchObject({ ended: 'stopped', why: 'a failed result' })
    expect(trace.events.filter((e) => e.kind === 'tool')).toEqual([
      {
        kind: 'tool',
        step_no: 1,
        tool: 'escalate_ticket',
        by: 'door',
        filled_by: 'ask',
        model: 'none',
        shape: 'failed',
        refused: { call: { team: 'the billing team' }, error: 'team must be one of billing, shipping, technical' },
      },
    ])
  })

  it('falls to its own chat on needs_model and records the step', async () => {
    const { deps, chats } = depsFor((path) =>
      path === 'playbooks'
        ? ok(PLAYBOOK)
        : path.endsWith('/pass')
          ? ok({ kind: 'needs_model', reason: 'no playbook step has it', spent: [] })
          : ok({}),
    )
    const trace = await playJobWithLibrary(job(), deps)
    expect(chats).toEqual([2])
    expect(trace.reply).toBe('agent words')
    expect(doorEvents(trace.events, 'playbooks/pass')).toMatchObject([{ said: 'needs_model' }])
    const reply = trace.events.find((e) => e.kind === 'reply')
    expect(reply).toMatchObject({ reply: { kind: 'words', by: 'big-model' } })
    expect(reply).not.toHaveProperty('reply.served')
  })
})
