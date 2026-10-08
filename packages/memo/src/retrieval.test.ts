import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rankMemories, queryTerms, retrievalInputSchema } from './retrieval.ts'

test('hybrid retrieval preserves exact identifiers, semantic matches and an empty-result path', () => {
  const rows = [
    { id: 'exact', content: 'saveSegmentQcDraft 使用 operatorAuthUid', entities: [], distance: 0.9 },
    { id: 'meaning', content: '草稿保存使用当前操作人', entities: [], distance: 0.1 },
    { id: 'noise', content: '用户午饭吃面条', entities: [], distance: 0.9 },
  ]
  const input = retrievalInputSchema.parse({ query: 'saveSegmentQcDraft', scope: { kind: 'project', project_ids: ['test'] }, vector: [1, 0], space_id: 'test' })
  assert.deepEqual(rankMemories(rows, input).map(entry => entry.id), ['exact', 'meaning'])
  assert.deepEqual(rankMemories(rows, { ...input, mode: 'keyword' }).map(entry => entry.id), ['exact'])
  assert.deepEqual(rankMemories(rows, { ...input, mode: 'semantic' }).map(entry => entry.id), ['meaning'])
  assert.deepEqual(rankMemories(rows, { ...input, mode: 'keyword', query: '完全不存在的火星资料' }), [])
  assert.deepEqual(rankMemories(rows, { ...input, mode: 'semantic', min_similarity: 0.99 }), [])
  assert(queryTerms('记忆读取 source_session_id').includes('source_session_id'))
  assert.equal(rankMemories(rows, input)[0].match.matched_terms[0], 'savesegmentqcdraft')
  assert.throws(() => retrievalInputSchema.parse({ ...input, min_similarity: 2 }))
  assert.throws(() => retrievalInputSchema.parse({ ...input, scope: { kind: 'project', project_ids: [] } }))
})

test('lexical ties prefer complete content phrases', () => {
  const rows = [
    { id: 'scattered', content: 'alpha appears here, beta appears later', entities: [], distance: null },
    { id: 'phrase', content: 'alpha beta is the complete phrase', entities: [], distance: null },
  ]
  const input = retrievalInputSchema.parse({ query: 'alpha beta', mode: 'keyword', scope: { kind: 'user' } })
  assert.deepEqual(rankMemories(rows, input).map(entry => entry.id), ['phrase', 'scattered'])
  assert.equal(rankMemories(rows, input)[0].match.phrase_match, true)
})

test('qualification and source date break lexical ties without changing relevance', () => {
  const input = retrievalInputSchema.parse({ query: 'same phrase', mode: 'keyword', scope: { kind: 'user' }, limit: 10 })
  const qualified = rankMemories([
    { id: 'asserted', content: 'same phrase asserted', entities: [], distance: null, claim_status: 'asserted' as const },
    { id: 'verified', content: 'same phrase verified', entities: [], distance: null, claim_status: 'verified' as const },
  ], input)
  assert.deepEqual(qualified.map(entry => entry.id), ['verified', 'asserted'])
  const dated = rankMemories([
    { id: 'old', content: 'same phrase old', entities: [], distance: null, source_occurred_at: '2026-01-01T00:00:00Z' },
    { id: 'new', content: 'same phrase new', entities: [], distance: null, source_occurred_at: '2026-02-01T00:00:00Z' },
  ], input)
  assert.deepEqual(dated.map(entry => entry.id), ['new', 'old'])
  const stable = rankMemories([
    { id: 'b', content: 'same phrase b', entities: [], distance: null },
    { id: 'a', content: 'same phrase a', entities: [], distance: null },
  ], input)
  assert.deepEqual(stable.map(entry => entry.id), ['a', 'b'])
})

test('folds only exact duplicates in same scope and validity, keeps highest qualification primary', () => {
  const input = retrievalInputSchema.parse({ query: 'same phrase', mode: 'keyword', scope: { kind: 'user' }, limit: 10 })
  const entries = rankMemories([
    { id: 'candidate', content: 'same phrase', entities: [], distance: null, claim_status: 'candidate' as const, scope: 'project', project_ids: ['one'], source_session_id: 'old-session', submission_id: 'old-submission', valid_from: '2026-01-01T00:00:00Z', valid_until: null },
    { id: 'verified', content: 'same phrase', entities: [], distance: null, claim_status: 'verified' as const, scope: 'project', project_ids: ['one'], source_session_id: 'new-session', submission_id: 'new-submission', valid_from: '2026-01-01T00:00:00Z', valid_until: null },
    { id: 'other-scope', content: 'same phrase', entities: [], distance: null, claim_status: 'verified' as const, scope: 'project', project_ids: ['two'], valid_from: '2026-01-01T00:00:00Z', valid_until: null },
    { id: 'other-validity', content: 'same phrase', entities: [], distance: null, claim_status: 'verified' as const, scope: 'project', project_ids: ['one'], valid_from: '2026-02-01T00:00:00Z', valid_until: null },
  ], input)
  assert.deepEqual(new Set(entries.map(entry => entry.id)), new Set(['verified', 'other-scope', 'other-validity']))
  assert.deepEqual(entries.find(entry => entry.id === 'verified')?.match.duplicate_ids, ['candidate'])
  assert.equal(entries.length, 3)
})

test('source-date tie-break orders known dates before unknown dates stably', () => {
  const input = retrievalInputSchema.parse({ query: 'same phrase', mode: 'keyword', scope: { kind: 'user' }, limit: 10 })
  const rows = [
    { id: 'unknown', content: 'same phrase unknown', entities: [], distance: null },
    { id: 'known', content: 'same phrase known', entities: [], distance: null, source_occurred_at: '2026-02-01T00:00:00Z' },
  ]
  assert.deepEqual(rankMemories(rows, input).map(entry => entry.id), ['known', 'unknown'])
  assert.deepEqual(rankMemories(rows.toReversed(), input).map(entry => entry.id), ['known', 'unknown'])
})

test('duplicate scope identity follows sameScope semantics', () => {
  const input = retrievalInputSchema.parse({ query: 'same phrase', mode: 'keyword', scope: { kind: 'user' }, limit: 10 })
  const project = rankMemories([
    { id: 'project-old', content: 'same phrase', entities: [], distance: null, scope: 'project', project_ids: ['one'], source_session_id: 'old', submission_id: 'old-submission' },
    { id: 'project-new', content: 'same phrase', entities: [], distance: null, scope: 'project', project_ids: ['one'], source_session_id: 'new', submission_id: 'new-submission' },
  ], input)
  assert.equal(project.length, 1)
  assert.deepEqual(project[0].match.duplicate_ids, ['project-old'])
  const task = rankMemories([
    { id: 'task-old', content: 'same phrase', entities: [], distance: null, scope: 'current_task', source_session_id: 'old' },
    { id: 'task-new', content: 'same phrase', entities: [], distance: null, scope: 'current_task', source_session_id: 'new' },
  ], input)
  assert.equal(task.length, 2)
  const unspecified = rankMemories([
    { id: 'submission-old', content: 'same phrase', entities: [], distance: null, scope: 'unspecified', submission_id: 'old' },
    { id: 'submission-new', content: 'same phrase', entities: [], distance: null, scope: 'unspecified', submission_id: 'new' },
  ], input)
  assert.equal(unspecified.length, 2)
})

test('semantic channel keeps strongest vector match first', () => {
  const input = retrievalInputSchema.parse({ query: 'unrelated words', mode: 'semantic', scope: { kind: 'user' }, space_id: 'test', vector: [1, 0], limit: 10 })
  assert.deepEqual(rankMemories([
    { id: 'weak', content: 'weak semantic memory', entities: [], distance: 0.2 },
    { id: 'strong', content: 'strong semantic memory', entities: [], distance: 0.01 },
  ], input).map(entry => entry.id), ['strong', 'weak'])
})

test('retrieval does not mutate rows, input or confidence fields', () => {
  const rows = [{ id: 'entry', content: 'same phrase', entities: ['same'], distance: null, confidence: 0.7 }]
  const input = retrievalInputSchema.parse({ query: 'same phrase', mode: 'keyword', scope: { kind: 'user' } })
  const rowsBefore = structuredClone(rows), inputBefore = structuredClone(input)
  const result = rankMemories(rows, input)
  assert.deepEqual(rows, rowsBefore)
  assert.deepEqual(input, inputBefore)
  assert.equal(rows[0].confidence, 0.7)
  assert.equal(result[0].match.rank_score > 0, true)
})
