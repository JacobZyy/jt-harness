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
