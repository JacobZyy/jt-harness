import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { agentExtractionSchema, parseExtraction, submissionSchema } from '../contracts.ts'
import { entryMetadata } from './metadata.ts'

test('atomic metadata allows entity aliases and retains absolute validity evidence and source times', () => {
  const submission = submissionSchema.parse({
    schema_version: 1, submission_id: 'metadata', source: { provider: 'codex', session_id: 'metadata' },
    scope: { project_ids: ['sample'], business_ids: [] },
    messages: [
      { message_id: 'a', role: 'assistant', text: '建议 API 超时为 30 秒。', occurred_at: '2026-09-16T13:00:00+08:00' },
      { message_id: 'u', role: 'user', text: '确认 API 超时 30 秒；2026-09-17T00:00:00+08:00 开始生效。', occurred_at: '2026-09-16T06:00:00Z' },
    ],
  })
  const fact = {
    content: 'API 超时为 30 秒。', scope: 'project' as const, basis: 'user_confirmed' as const, source_message_ids: ['a', 'u'],
    entities: ['API'], valid_from: '2026-09-17T00:00:00+08:00', valid_until: null,
    time_evidence: { source_message_id: 'u', quote: '2026-09-17T00:00:00+08:00 开始生效' },
  }
  const result = { schema_version: 1, memories: [fact], proposals: [], revisions: [] }
  assert.doesNotThrow(() => agentExtractionSchema.parse(result))
  assert.doesNotThrow(() => z.toJSONSchema(agentExtractionSchema))
  assert.deepEqual(entryMetadata(parseExtraction(JSON.stringify(result), submission).memories[0], submission), {
    entities: ['API'], source_occurred_at: '2026-09-16T06:00:00.000Z', valid_from: '2026-09-16T16:00:00.000Z', valid_until: null,
  })
  const partialTime = structuredClone(submission)
  delete partialTime.messages[0].occurred_at
  assert.equal(entryMetadata(fact, partialTime).source_occurred_at, null)
  assert.throws(() => submissionSchema.parse({ ...submission, messages: submission.messages.toReversed() }), /会话顺序/)
  assert.doesNotThrow(() => parseExtraction(JSON.stringify({ ...result, memories: [{ ...fact, entities: ['API service'] }] }), submission))
  assert.throws(() => parseExtraction(JSON.stringify({ ...result, memories: [{ ...fact, time_evidence: { source_message_id: 'u', quote: '编造日期' } }] }), submission), /时间原文/)
  assert.throws(() => parseExtraction(JSON.stringify({ ...result, memories: [{ ...fact, claim_status: 'verified' }] }), submission))
  assert.throws(() => parseExtraction(JSON.stringify({ ...result, memories: [{ ...fact, valid_until: '2026-09-16T17:00:00+08:00' }] }), submission), /失效时间/)
})
