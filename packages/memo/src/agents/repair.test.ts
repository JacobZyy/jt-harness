import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { runValidatedMemoryAgent, checkAgentCompletion } from './runtime.ts'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'

test('validation repair preserves evidence, retries once and never retries a failed DSH launch', async () => {
  const input = { messages: [{ id: 'real', text: '实际证据' }] }, seen: unknown[] = []
  const validate = (value: string) => { const result = JSON.parse(value); if (result.id !== 'real') throw new Error('来源 ID 不存在'); return result }
  const run = async (material: unknown) => {
    seen.push(material)
    return { response: JSON.stringify({ id: seen.length === 1 ? 'invented' : 'real' }), run: { session_id: String(seen.length), provider: 'test', model: 'test' } }
  }
  const options = { provider: 'test', model: 'test', timeoutMs: 1000 }, prompt = new URL('./agent.md', import.meta.url)
  const result = await runValidatedMemoryAgent(input, options, prompt, z.object({ id: z.string() }), validate, {}, run)
  assert.equal(result.value.id, 'real')
  assert.deepEqual((seen[1] as typeof input).messages, input.messages)
  let attempts = 0
  await assert.rejects(runValidatedMemoryAgent(input, options, prompt, z.object({}), validate, {}, async () => {
    attempts++; return { response: '{"id":"invented"}', run: result.run }
  }), /来源 ID/)
  assert.equal(attempts, 2)
  attempts = 0
  await assert.rejects(runValidatedMemoryAgent(input, options, prompt, z.object({}), validate, {}, async () => { attempts++; throw new Error('spawn failed') }), /spawn failed/)
  assert.equal(attempts, 1)
})

test('token-limited generations retain their returned text before reporting execution failure', async () => {
  const output = { response: '{"memories":["仍有价值的截断文本"', run: { session_id: 'interrupted', provider: 'test', model: 'test' } }
  const events: string[] = []
  await assert.rejects(checkAgentCompletion({ events: [{ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }] } as unknown as RunResult, output, {
    onOutput: async retained => { assert.equal(retained.response, output.response); events.push('retained') },
    onInvalidOutput: async (_retained, error) => { assert.match(error, /max-tokens/); events.push('diagnosed') },
  }), /未完成/)
  assert.deepEqual(events, ['retained', 'diagnosed'])
})
