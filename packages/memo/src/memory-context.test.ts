import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  boundMemoryEntries, boundedMemoryContext, isRecalledMemory, sanitizeMemoryText, sanitizeMemoryValue,
  truncateUnicode, unicodeLength, withMemoryContext,
} from './memory-context.ts'

test('memory context marks recalled data and detects its own envelope', () => {
  const source = { entries: [{ id: 'entry-1', preview: '历史资料' }], notice: '原始提示' }
  const output = withMemoryContext(source, 'cli')
  assert.equal((source as Record<string, unknown>).memory_context, undefined)
  assert.equal(output.notice.includes('原始提示'), true)
  assert.equal(isRecalledMemory(output), true)
  assert.equal(withMemoryContext(output, 'cli').notice, output.notice)
  assert.equal(isRecalledMemory({ memory_context: { kind: 'other' } }), false)
})

test('sanitization removes credentials while preserving ordinary Unicode text', () => {
  const value = 'Bearer test-bearer-token {"api_key":"test-api-key","password":"a\\"b secret tail"} password=secret-value\n中文😀'
  const safe = sanitizeMemoryText(value)
  assert(!safe.includes('test-bearer-token'))
  assert(!safe.includes('test-api-key'))
  assert(!safe.includes('secret-value'))
  assert(!safe.includes('secret value'))
  assert(!safe.includes('secret tail'))
  assert(safe.includes('中文😀'))
  const object = { value, nested: ['private-key=another-secret'] }
  const clone = sanitizeMemoryValue(object)
  assert.equal(object.value, value)
  assert(!JSON.stringify(clone).includes('another-secret'))
  assert.deepEqual(sanitizeMemoryValue({ token_count: 1234, api_key: 'abc123456789' }), { token_count: 1234, api_key: '[REDACTED]' })
})

test('bounded recall output trims previews and reports dropped entries', () => {
  const result = boundMemoryEntries({
    query: '中文😀',
    entries: Array.from({ length: 50 }, (_, index) => ({ id: String(index), preview: `secret=${'x'.repeat(800)} 中文😀` })),
  }, { maxChars: 1200, next: 'jth memo read <entry-id> --level evidence' })
  const json = JSON.stringify(result, null, 2)
  assert(unicodeLength(json) <= 1200)
  assert.equal(result.truncated, true)
  assert(typeof result.dropped === 'number' || result.entries.length < 50)
  assert.equal(result.next, 'jth memo read <entry-id> --level evidence')
  assert.equal(isRecalledMemory(result), true)
})

test('bounded recall output drops oversized base fields within small budgets', () => {
  for (const maxChars of [12000, 400]) {
    const result = boundMemoryEntries({ query: '超长'.repeat(20_000), entries: [] }, {
      maxChars, next: 'jth memo read <entry-id> --level evidence',
    })
    assert(unicodeLength(JSON.stringify(result, null, 2)) <= maxChars)
    assert.equal(isRecalledMemory(result), true)
    assert.equal(result.truncated, true)
  }
  for (const maxChars of [200, 170]) {
    assert.throws(() => boundMemoryEntries({ query: 'x'.repeat(1000), entries: [] }, { maxChars, next: 'jth memo read <entry-id> --level evidence' }), RangeError)
  }
})

test('hook context stays within Unicode budget and remains JSON', () => {
  const text = boundedMemoryContext({ instructions: '需要历史依据。', cues: [{ id: '1', preview: '中文😀'.repeat(500) }] }, 1600)
  assert(unicodeLength(text) <= 1600)
  const parsed = JSON.parse(text)
  assert.equal(parsed.memory_context.kind, 'jth_memory_context')
  assert.equal(parsed.memory_context.trust, 'untrusted')
  assert.equal(parsed.truncated, true)
  assert.equal(truncateUnicode('中文😀', 3), '中文😀')
  assert.equal(unicodeLength('中文😀'), 3)
  const compact = JSON.parse(boundedMemoryContext({ instructions: 'x'.repeat(10_000), cues: [] }, 1600))
  assert.equal(compact.truncated, true)
  assert(unicodeLength(JSON.stringify(compact)) <= 1600)
  assert.throws(() => boundedMemoryContext({ instructions: 'x'.repeat(10_000), cues: [] }, 100), RangeError)
})
