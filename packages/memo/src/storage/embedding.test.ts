import assert from 'node:assert/strict'
import { test } from 'node:test'
import { embedTexts } from './embedding.ts'
import type { EmbeddingAttempt } from './embedding.ts'
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

test('Embedding sanitizes credentials at transport boundary without changing caller input', async () => {
  const originalFetch = globalThis.fetch
  const input = 'Bearer test-bearer-token password=secret-value 中文😀'
  let sent = ''
  globalThis.fetch = (async (_url, init) => {
    sent = JSON.parse(String(init?.body)).input[0]
    return Response.json({ model: 'test', data: [{ index: 0, embedding: [1, 0.1] }] })
  }) as typeof fetch
  try {
    await embedTexts([input], config)
    assert.equal(input, 'Bearer test-bearer-token password=secret-value 中文😀')
    assert(!sent.includes('test-bearer-token'))
    assert(!sent.includes('secret-value'))
    assert(sent.includes('中文😀'))
  } finally { globalThis.fetch = originalFetch }
})

test('Embedding records actual provider usage for every attempted text, including partial failure and invalid vectors', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  const attempts: EmbeddingAttempt[] = []
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) return Response.json({ model: 'test', data: [{ index: 0, embedding: [1, 0.1] }], usage: { prompt_tokens: 12, total_tokens: 12 } })
    return Response.json({ secret: 'not-for-logs' }, { status: 429 })
  }) as typeof fetch
  try {
    await assert.rejects(embedTexts(['one', 'two', 'never attempted'], config, undefined, async attempt => { attempts.push(attempt) }), /HTTP 429/)
    assert.equal(calls, 2)
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts.map(attempt => [attempt.text_index, attempt.status, attempt.usage]), [
      [0, 'complete', { prompt_tokens: 12, total_tokens: 12 }],
      [1, 'failed', { prompt_tokens: null, total_tokens: null }],
    ])
    assert(!JSON.stringify(attempts).includes('not-for-logs'))
    globalThis.fetch = (async () => Response.json({ model: 'test', data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 4, total_tokens: 4 } })) as typeof fetch
    await assert.rejects(embedTexts(['invalid'], config, undefined, async attempt => { attempts.push(attempt) }))
    assert.equal(attempts.at(-1)!.status, 'failed')
    assert.equal(attempts.at(-1)!.usage.prompt_tokens, 4)
    globalThis.fetch = (async () => Response.json({ model: 'test', data: [{ index: 0, embedding: [1, 0.1] }] })) as typeof fetch
    await embedTexts(['no reported usage'], config, undefined, async attempt => { attempts.push(attempt) })
    assert.deepEqual(attempts.at(-1)!.usage, { prompt_tokens: null, total_tokens: null })
  } finally { globalThis.fetch = originalFetch }
})
