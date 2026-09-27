// deno test --allow-env supabase/functions/_shared/agent_guard_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { type AgentProxyBody, checkAgentRequest } from './agent_guard.ts'

const env = { allowedModels: ['claude-sonnet-4-6'] }

function baseBody(): AgentProxyBody {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a helpful assistant.',
    tools: [],
    messages: [{ role: 'user', content: 'Hello' }],
  }
}

Deno.test('a valid body passes', () => {
  assertEquals(checkAgentRequest(baseBody(), env), null)
})

Deno.test('a disallowed model is refused', () => {
  const result = checkAgentRequest({ ...baseBody(), model: 'gpt-4' }, env)
  assertEquals(result?.code, 'MODEL_NOT_ALLOWED')
})

Deno.test('an oversize system prompt is refused', () => {
  const result = checkAgentRequest({ ...baseBody(), system: 'x'.repeat(20_001) }, env)
  assertEquals(result?.code, 'VALIDATION_ERROR')
})

Deno.test('an oversize non-image text total across messages is refused', () => {
  const body: AgentProxyBody = {
    ...baseBody(),
    system: undefined,
    messages: [{ role: 'user', content: 'x'.repeat(200_001) }],
  }
  const result = checkAgentRequest(body, env)
  assertEquals(result?.code, 'VALIDATION_ERROR')
})

Deno.test('an over-count image batch is refused', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  const body: AgentProxyBody = {
    ...baseBody(),
    messages: [{ role: 'user', content: [image, image, image, image, image] }],
  }
  const result = checkAgentRequest(body, env)
  assertEquals(result?.code, 'VALIDATION_ERROR')
})

Deno.test('an oversize image is refused', () => {
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5 * 1024 * 1024 + 1) },
  }
  const body: AgentProxyBody = { ...baseBody(), messages: [{ role: 'user', content: [image] }] }
  const result = checkAgentRequest(body, env)
  assertEquals(result?.code, 'VALIDATION_ERROR')
})

Deno.test('image base64 data is not counted toward the text budget', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(300_000) } }
  const body: AgentProxyBody = { ...baseBody(), messages: [{ role: 'user', content: [image] }] }
  assertEquals(checkAgentRequest(body, env), null)
})

Deno.test('an over-cap max_tokens is refused', () => {
  const result = checkAgentRequest({ ...baseBody(), max_tokens: 5000 }, env)
  assertEquals(result?.code, 'VALIDATION_ERROR')
})

Deno.test('an over-cap messages length is refused', () => {
  const body: AgentProxyBody = {
    ...baseBody(),
    messages: Array.from({ length: 61 }, () => ({ role: 'user', content: 'hi' })),
  }
  const result = checkAgentRequest(body, env)
  assertEquals(result?.code, 'VALIDATION_ERROR')
})

Deno.test('an over-cap tools length is refused', () => {
  const body: AgentProxyBody = {
    ...baseBody(),
    tools: Array.from({ length: 41 }, (_, i) => ({ name: `tool${i}` })),
  }
  const result = checkAgentRequest(body, env)
  assertEquals(result?.code, 'VALIDATION_ERROR')
})
