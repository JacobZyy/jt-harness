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

async function withImmediateRetryTimers(run: (delays: number[]) => Promise<void>) {
  const original = globalThis.setTimeout, delays: number[] = []
  globalThis.setTimeout = ((...[handler, milliseconds, ...args]: Parameters<typeof setTimeout>) => {
    delays.push(Number(milliseconds))
    return original(handler, 0, ...args)
  }) as typeof setTimeout
  try { await run(delays) } finally { globalThis.setTimeout = original }
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
    respond = async () => Response.json({ secret: 'provider-detail' }, { status: 401 })
    await assert.rejects(embedTexts(['text'], config), error => {
      assert.match(String(error), /HTTP 401/)
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
    await withImmediateRetryTimers(async () => assert.rejects(embedTexts(['fact'], config), error => {
      assert(error instanceof Error)
      assert.equal(error.cause, network)
      assert.match(error.message, /Embedding 请求失败.*connect timeout/)
      assert(!safeError(error).includes('test-only'))
      return true
    }))
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
    return Response.json({ secret: 'not-for-logs' }, { status: 401 })
  }) as typeof fetch
  try {
    await assert.rejects(embedTexts(['one', 'two', 'never attempted'], config, undefined, async attempt => { attempts.push(attempt) }), /HTTP 401/)
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

test('recoverable failures stop after five retries and retain every real HTTP attempt without credentials or text', async () => {
  const originalFetch = globalThis.fetch, attempts: EmbeddingAttempt[] = []
  let calls = 0
  const text = 'private memory body'
  globalThis.fetch = (async () => {
    calls++
    return Response.json({ secret: text, apiKey: config.apiKey }, { status: 503, headers: { 'x-request-id': `request-${calls}`, 'retry-after': '0' } })
  }) as typeof fetch
  try {
    await withImmediateRetryTimers(async delays => {
      await assert.rejects(embedTexts([text, 'not attempted'], config, undefined, async attempt => { attempts.push(attempt) }), /HTTP 503/)
      assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000])
    })
    assert.equal(calls, 6)
    assert.deepEqual(attempts.map(attempt => attempt.request_attempt), [1, 2, 3, 4, 5, 6])
    assert(attempts.every(attempt => attempt.text_index === 0 && attempt.http_status === 503 && attempt.error_type === 'http'))
    assert.deepEqual(attempts.map(attempt => attempt.request_id), ['request-1', 'request-2', 'request-3', 'request-4', 'request-5', 'request-6'])
    assert.equal(attempts.at(-1)!.retry_delay_ms, null)
    assert(attempts.every(attempt => attempt.duration_ms >= 0 && attempt.completed_at >= attempt.started_at))
    assert(!JSON.stringify(attempts).includes(text))
    assert(!JSON.stringify(attempts).includes(config.apiKey))
  } finally { globalThis.fetch = originalFetch }
})

test('network and rate-limit retries can succeed without repeating an earlier successful text', async () => {
  const originalFetch = globalThis.fetch, attempts: EmbeddingAttempt[] = []
  const submitted: string[] = []
  let secondCalls = 0
  globalThis.fetch = (async (_url, init) => {
    const text = JSON.parse(String(init?.body)).input[0]
    submitted.push(text)
    if (text === 'second') {
      secondCalls++
      if (secondCalls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) })
      if (secondCalls === 2) return Response.json({}, { status: 429, headers: { 'retry-after': '120', 'request-id': 'rate-limit-request' } })
    }
    return Response.json({ model: 'test', data: [{ index: 0, embedding: [1, 0.1] }], usage: { prompt_tokens: 7, total_tokens: 7 } })
  }) as typeof fetch
  try {
    await withImmediateRetryTimers(async delays => {
      assert.equal((await embedTexts(['first', 'second'], config, undefined, async attempt => { attempts.push(attempt) })).length, 2)
      assert.deepEqual(delays, [500, 30_000])
    })
    assert.deepEqual(submitted, ['first', 'second', 'second', 'second'])
    assert.deepEqual(attempts.map(attempt => [attempt.text_index, attempt.request_attempt, attempt.status]), [[0, 1, 'complete'], [1, 1, 'failed'], [1, 2, 'failed'], [1, 3, 'complete']])
    assert.equal(attempts[1].error_code, 'ECONNRESET')
    assert.equal(attempts[2].request_id, 'rate-limit-request')
    assert.equal(attempts[3].usage.prompt_tokens, 7)
  } finally { globalThis.fetch = originalFetch }
})

test('caller cancellation stops requests and retry backoff immediately', async () => {
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout, controller = new AbortController(), reason = new Error('operator interrupted')
  const attempts: EmbeddingAttempt[] = []
  let calls = 0, waiting = false
  globalThis.fetch = (async () => { calls++; throw new TypeError('fetch failed') }) as typeof fetch
  globalThis.setTimeout = ((...[handler, milliseconds, ...args]: Parameters<typeof setTimeout>) => {
    waiting = true
    queueMicrotask(() => controller.abort(reason))
    return originalTimer(handler, milliseconds, ...args)
  }) as typeof setTimeout
  try {
    const started = performance.now()
    await assert.rejects(embedTexts(['first'], config, controller.signal, async attempt => { attempts.push(attempt) }), error => error === reason)
    assert(waiting)
    assert(performance.now() - started < 250)
    assert.equal(calls, 1)
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].request_attempt, 1)
    await assert.rejects(embedTexts(['never sent'], config, AbortSignal.abort(reason)), error => error === reason)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer }
})

test('request timeouts retry, but authentication, malformed JSON and invalid request configuration do not', async () => {
  const originalFetch = globalThis.fetch
  const attempts: EmbeddingAttempt[] = []
  let calls = 0
  globalThis.fetch = (async (_url, init) => {
    calls++
    if (calls === 1) await new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
    return Response.json({ model: 'test', data: [{ index: 0, embedding: [1, 0.1] }] })
  }) as typeof fetch
  try {
    await withImmediateRetryTimers(async () => {
      await embedTexts(['timeout'], { ...config, timeoutMs: 5 }, undefined, async attempt => { attempts.push(attempt) })
    })
    assert.equal(calls, 2)
    assert.equal(attempts[0].error_type, 'timeout')
    for (const status of [400, 401, 403, 404]) {
      calls = 0
      globalThis.fetch = (async () => { calls++; return Response.json({ secret: 'provider body' }, { status }) }) as typeof fetch
      await assert.rejects(embedTexts(['fact'], config), new RegExp(`HTTP ${status}`))
      assert.equal(calls, 1)
    }
    calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('private-provider-response', { status: 200 }) }) as typeof fetch
    await assert.rejects(embedTexts(['fact'], config, undefined, async attempt => { attempts.push(attempt) }), /不是有效 JSON/)
    assert.equal(calls, 1)
    assert(!JSON.stringify(attempts).includes('private-provider-response'))
    calls = 0
    globalThis.fetch = (async () => { calls++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('invalid URL'), { code: 'ERR_INVALID_URL' }) }) }) as typeof fetch
    await assert.rejects(embedTexts(['fact'], config))
    assert.equal(calls, 1)
  } finally { globalThis.fetch = originalFetch }
})

test('the sixth request may succeed after five retries for 500 and 429 responses', async () => {
  const originalFetch = globalThis.fetch, attempts: EmbeddingAttempt[] = []
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls <= 5) return Response.json({}, { status: calls % 2 ? 500 : 429 })
    return Response.json({ model: 'test', data: [{ index: 0, embedding: [1, .1] }] })
  }) as typeof fetch
  try {
    await withImmediateRetryTimers(async delays => {
      assert.equal((await embedTexts(['fact'], config, undefined, async attempt => { attempts.push(attempt) })).length, 1)
      assert.equal(delays.length, 5)
    })
    assert.equal(calls, 6)
    assert.equal(attempts.length, 6)
    assert.equal(attempts[5].status, 'complete')
    assert.equal(attempts[5].request_attempt, 6)
    assert.equal(attempts[5].retry_delay_ms, null)
  } finally { globalThis.fetch = originalFetch }
})

test('a disconnected response body is retried and diagnosed without retaining the input or credentials', async () => {
  const originalFetch = globalThis.fetch, attempts: EmbeddingAttempt[] = []
  const text = 'private input body'
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) {
      const body = new ReadableStream({ start(controller) {
        controller.error(Object.assign(new Error(`read failed ${text} Bearer ${config.apiKey}`), { code: 'ECONNRESET' }))
      } })
      return new Response(body, { status: 200, headers: { 'x-request-id': 'disconnected-body' } })
    }
    return Response.json({ model: 'test', data: [{ index: 0, embedding: [1, .1] }] })
  }) as typeof fetch
  try {
    await withImmediateRetryTimers(async () => {
      await embedTexts([text], config, undefined, async attempt => { attempts.push(attempt) })
    })
    assert.equal(calls, 2)
    assert.equal(attempts[0].http_status, 200)
    assert.equal(attempts[0].error_type, 'network')
    assert.equal(attempts[0].error_code, 'ECONNRESET')
    assert.equal(attempts[0].request_id, 'disconnected-body')
    assert.equal(attempts[1].status, 'complete')
    assert(!JSON.stringify(attempts).includes(text))
    assert(!JSON.stringify(attempts).includes(config.apiKey))
  } finally { globalThis.fetch = originalFetch }
})
