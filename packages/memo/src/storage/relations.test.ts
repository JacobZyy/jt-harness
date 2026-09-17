import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Extraction, Submission } from '../contracts.ts'
import { relationSchema, validateRelations } from './relations.ts'
import type { StateEntry } from './relations.ts'

test('revision boundary rejects fabricated evidence, cross-scope changes and proposal authority', () => {
  const submission: Submission = {
    schema_version: 1, submission_id: 'new', source: { provider: 'codex', session_id: 's' },
    scope: { project_ids: ['one'], business_ids: [] },
    messages: [{ message_id: 'u', role: 'user', text: '更正：以 B 替代 A。' }],
  }
  const extraction: Extraction = { schema_version: 1, memories: [], proposals: [], revisions: [] }
  const old: StateEntry = {
    id: randomUUID(), submission_id: 'old', position: 0, collection: 'memories', content: 'A', content_sha256: 'a'.repeat(64),
    basis: 'user_statement', scope: 'project', project_ids: ['one'], business_ids: [], source_session_id: 'old-session',
    source_message_ids: ['old-u'], state: 'active',
    entities: [], source_occurred_at: null, valid_from: null, valid_until: null,
    claim_status: 'asserted', archived: false, received_at: new Date(), published_at: new Date(), confirmed_at: null, invalid_at: null,
  }
  const next = { ...old, id: randomUUID(), submission_id: 'new', content: 'B', source_message_ids: ['u'] }
  const relation = relationSchema.parse({
    kind: 'correction', previous_entry_id: old.id, current_entry_id: next.id, revision_index: null,
    explanation: '用户明确替换', source_message_ids: ['u'], evidence_quote: '更正：以 B 替代 A。',
  })
  const check = (value = relation, previous = old, current = next, input = submission) => validateRelations([value], [previous], [current], input, extraction)
  assert.doesNotThrow(() => check())
  assert.throws(() => check({ ...relation, evidence_quote: '模型编造的更正' }), /来源原文/)
  assert.throws(() => check(relation, { ...old, project_ids: ['two'] }), /跨越/)
  assert.throws(() => check(relation, { ...old, project_ids: ['one', 'two'] }), /跨越/)
  assert.throws(() => check(relation, { ...old, state: 'superseded' }), /失效/)
  assert.throws(() => check(relation, old, { ...next, collection: 'proposals' }), /助手建议/)
  assert.throws(() => check(relation, old, next, { ...submission, messages: [{ message_id: 'u', role: 'assistant', text: relation.evidence_quote }] }), /用户/)
  assert.throws(() => check({ ...relation, current_entry_id: null, kind: 'conflict', revision_index: 0 }), /冲突证据/)
  assert.throws(() => validateRelations([relation, relation], [old], [next], submission, extraction), /重复/)
  assert.throws(() => relationSchema.parse({ ...relation, current_entry_id: null }), /新记忆/)
})
