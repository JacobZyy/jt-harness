import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectExtraction } from './intake.ts'
import type { Submission } from './contracts.ts'

const submission: Submission = {
  schema_version: 1, submission_id: 'intake', source: { provider: 'codex', session_id: 'intake' },
  scope: { project_ids: ['intake'], business_ids: [] },
  messages: [{ message_id: 'old', role: 'assistant', text: '使用 PG。', context_only: true }, { message_id: 'new', role: 'user', text: '继续。' }],
}
const fact = { content: '采用 PostgreSQL。', basis: 'user_confirmed', scope: 'project', source_message_ids: ['old', 'old'], entities: [' PostgreSQL ', 'PostgreSQL'] }
const report = (memories: unknown, proposals: unknown = [], revisions: unknown = []) => inspectExtraction(JSON.stringify({ schema_version: 1, memories, proposals, revisions }), submission)

test('aliases, old-only citations and role/order differences are accepted without changing source roles', () => {
  const result = report([fact])
  assert.equal(result.issues.length, 0)
  assert.deepEqual(result.extraction.memories[0].entities, ['PostgreSQL'])
  assert.deepEqual(result.extraction.memories[0].source_message_ids, ['old'])
  assert.equal(result.extraction.memories[0].basis, 'user_confirmed')
  assert.equal(submission.messages[0].role, 'assistant')
})

test('one invalid item cannot discard independent memories; rejected values and indices remain exact', () => {
  const invalid = { ...fact, content: '有待修正的引用', source_message_ids: ['not-a-real-id'] }
  const result = report([fact, invalid, { ...fact, content: '另一个有效事实', kind_note: '额外辅助字段' }])
  assert.equal(result.extraction.memories.length, 2)
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].path, 'memories[1]')
  assert.deepEqual(result.issues[0].value, invalid)
  assert.match(result.issues[0].error, /不存在的消息/)
})

test('malformed collections and invalid revisions are isolated; whole JSON syntax errors still fail', () => {
  const invalidRevision = { kind: 'correction', earlier_content: 'A', later_content: 'B', explanation: '修订', source_message_ids: ['missing'] }
  const result = report([fact], 'not an array', [invalidRevision])
  assert.equal(result.extraction.memories.length, 1)
  assert.equal(result.extraction.proposals.length, 0)
  assert.equal(result.extraction.revisions.length, 0)
  assert.deepEqual(result.issues.map(issue => issue.path), ['proposals', 'revisions[0]'])
  assert.throws(() => inspectExtraction('{"memories":', submission), SyntaxError)
  assert.throws(() => inspectExtraction('{"schema_version":1}', submission), /不能当成正常空结果/)
  assert.equal(report(null).issues.length, 1)
})
