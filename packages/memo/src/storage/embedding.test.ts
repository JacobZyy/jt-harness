import assert from 'node:assert/strict'
import { test } from 'node:test'
import { embedTexts } from './embedding.ts'
import { vectorSchema } from './contract.ts'
import { safeError } from '../config.ts'

const config = {
  baseUrl: 'https://example.invalid/v1', apiKey: 'test-only', timeoutMs: 200,
  space: { id: 'test', provider: 'test', model: 'test', dimensions: 2, input_version: 'content-v1' as const },
}

test('Embedding binds one text per call and refuses ambiguous or invalid provider results', async () => {
  const calls: number[] = []
  const originalFetch = globalThis.fetch
  let respond = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.input.length, 1)
    calls.push(Number(body.input[0].split(' ')[1]))
    assert.equal(init?.redirect, 'error')
    return Response.json({ model: 'test', data: [{ index: 0, embedding: [calls.at(-1)! + 1, 0.1] }] })
  }
  globalThis.fetch = ((...args) => respond(...args)) as typeof fetch
  try {
    const result = await embedTexts(Array.from({ length: 12 }, (_, index) => `text ${index}`), config)
    assert.deepEqual(calls, Array.from({ length: 12 }, (_, index) => index))
    assert.equal(result[9][0], 10)
    for (const bad of [
      { model: 'other', data: [{ index: 0, embedding: [1, 0] }] },
      { model: 'test', data: [] },
      { model: 'test', data: [{ index: 1, embedding: [1, 0] }] },
      { model: 'test', data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [2, 0] }] },
      { model: 'test', data: [{ index: 0, embedding: [1] }] },
      { model: 'test', data: [{ index: 0, embedding: [0, 0] }] },
      { model: 'test', data: [{ index: 0, embedding: [1e40, 0] }] },
    ]) {
      respond = async () => Response.json(bad)
      await assert.rejects(embedTexts(['text'], config))
    }
    respond = async () => Response.json({ secret: 'provider-detail' }, { status: 429 })
    await assert.rejects(embedTexts(['text'], config), error => {
      assert.match(String(error), /HTTP 429/)
      assert(!String(error).includes('provider-detail'))
      return true
    })
    assert.throws(() => vectorSchema.parse([Number.NaN, 1]))
    assert.throws(() => vectorSchema.parse([1e-100, 0]))
  } finally { globalThis.fetch = originalFetch }
})

test('transport failures identify the Embedding stage and retain the cause; caller cancellation stays cancellation', async () => {
  const network = new TypeError('fetch failed', { cause: new Error('connect timeout; Bearer test-only') })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw network }) as unknown as typeof fetch
  try {
    await assert.rejects(embedTexts(['fact'], config), error => {
      assert(error instanceof Error)
      assert.equal(error.cause, network)
      assert.match(error.message, /Embedding 请求失败.*connect timeout/)
      assert(!safeError(error).includes('test-only'))
      return true
    })
    const reason = new Error('operator interrupted')
    await assert.rejects(embedTexts(['fact'], config, AbortSignal.abort(reason)), error => error === reason)
  } finally { globalThis.fetch = originalFetch }
})
