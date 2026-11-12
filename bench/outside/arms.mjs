// The arms of the outside test, each a client and a model.
// Every arm has its own provider key, from its own provider project, so each arm's spend is its own line on the bill.
//
//   A  the agent on the large model, direct
//   B  the same agent, its client wrapped by Reactor: the one changed line
//   C  the agent on the small model alone, direct (does the cheap model do the work by itself?)
//   F  the agent through OpenRouter's router, held to the same two models (would a router do the same?)
//
// Keys are read from the environment by name and never printed.
import process from 'node:process'
import OpenAI from 'openai'

const need = (name) => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

/** The provider's base URL, for a fake in a smoke test; unset, the SDK's own (OpenAI). */
const baseURL = process.env.OUTSIDE_PROVIDER_URL || undefined

export const ARMS = {
  A: () => ({
    client: new OpenAI({ apiKey: need('OPENAI_KEY_A'), baseURL }),
    model: need('LARGE_MODEL'),
  }),
  B: async () => {
    const { default: reactor } = await import('@agencer/reactor')
    const provider = new OpenAI({ apiKey: need('OPENAI_KEY_B'), baseURL })
    const options = { key: need('REACTOR_API_KEY'), small: need('SMALL_MODEL') }
    if (process.env.REACTOR_BASE_URL) {
      options.baseUrl = process.env.REACTOR_BASE_URL
    }
    return { client: reactor.wrap(provider, options), model: need('LARGE_MODEL') }
  },
  C: () => ({
    client: new OpenAI({ apiKey: need('OPENAI_KEY_C'), baseURL }),
    model: need('SMALL_MODEL'),
  }),
  // The router's model name and its plugin, held to our two models. Check both against OpenRouter's router page
  // before a run (as planned: model 'typesafe/jev-router', plugin 'jev-router'); JEV_MODEL and JEV_PLUGINS override them.
  F: () => ({
    client: new OpenAI({ apiKey: need('OPENROUTER_API_KEY'), baseURL: 'https://openrouter.ai/api/v1' }),
    model: process.env.JEV_MODEL || 'typesafe/jev-router',
    extra: {
      plugins: process.env.JEV_PLUGINS
        ? JSON.parse(process.env.JEV_PLUGINS)
        : [{ id: 'jev-router', models: [`openai/${need('LARGE_MODEL')}`, `openai/${need('SMALL_MODEL')}`] }],
    },
  }),
}
