// A plain tool-calling agent, as a customer writes one: the OpenAI SDK's chat.completions in a loop until the model
// answers in words. Nothing of Reactor is in here; arm B hands it a wrapped client, which is the one line a customer
// changes. Usage is summed from what each response reports, its `cached_tokens` included.
export const runAgent = async ({ client, model, system, ask, tools, call, maxSteps = 25, extra = {} }) => {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: ask },
  ]
  const usage = { calls: 0, prompt: 0, completion: 0, cached_tokens: 0, unreported: 0 }
  for (let step = 1; step <= maxSteps; step++) {
    const res = await client.chat.completions.create({ model, messages, tools, parallel_tool_calls: false, ...extra })
    usage.calls += 1
    if (res.usage) {
      usage.prompt += res.usage.prompt_tokens ?? 0
      usage.completion += res.usage.completion_tokens ?? 0
      usage.cached_tokens += res.usage.prompt_tokens_details?.cached_tokens ?? 0
    } else {
      usage.unreported += 1
    }
    const message = res.choices[0].message
    messages.push(message)
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return { reply: message.content ?? '', steps: step, capped: false, usage }
    }
    for (const toolCall of message.tool_calls) {
      let args
      try {
        args = JSON.parse(toolCall.function.arguments || '{}')
      } catch {
        args = {}
      }
      let result
      try {
        result = await call(toolCall.function.name, args)
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) }
      }
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result ?? null) })
    }
  }
  return { reply: null, steps: maxSteps, capped: true, usage }
}
