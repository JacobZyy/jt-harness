import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import type { Submission } from '../contracts.ts'
import type { ComparisonInput } from './reconcile.ts'
import type { StateEntry } from '../storage/relations.ts'
import { comparisonLimits } from '../storage/relations.ts'
import { extractionMaterial, comparisonMaterial, projectMessages, materialLimits, jsonBytes } from './material.ts'
import { agentUsage } from './runtime.ts'

const submission: Submission = {
  schema_version: 1, submission_id: 'material-test', source: { provider: 'codex', session_id: 'test-session', codex: {
    transcript_path: '/private/local.jsonl', start_offset: 100, end_offset: 1000, parser_version: 1,
  } }, scope: { project_ids: ['test-project'], business_ids: [] }, messages: [
    { message_id: 'user', role: 'user', text: '现在明确把超时从 30 秒改成 60 秒。', occurred_at: '2026-01-01T00:00:00Z' },
    { message_id: 'tool', role: 'tool', text: JSON.stringify({ tool: 'Bash', command: 'pnpm test', exit_code: 0, output: '测试通过😀\n'.repeat(2000) }) },
    { message_id: 'assistant', role: 'assistant', text: '已修改并验证超时配置。' },
  ],
}
const entry = (index: number): StateEntry => ({
  id: randomUUID(), submission_id: 'old', position: index, collection: 'memories', content: '超时时间为 30 秒。', content_sha256: 'a'.repeat(64),
  basis: 'user_statement', scope: 'project', source_message_ids: ['user'], project_ids: ['test-project'], business_ids: [], source_session_id: 'old-session',
  entities: ['timeout'], source_occurred_at: new Date('2025-01-01'), valid_from: null, valid_until: null, state: 'active', claim_status: 'asserted',
  archived: false, received_at: new Date('2025-01-01'), published_at: new Date('2025-01-01'), confirmed_at: null, invalid_at: null,
})

test('model material bounds tool evidence, keeps exact excerpts and never changes durable source', () => {
  const before = structuredClone(submission), projected = extractionMaterial(submission)
  const [user, , assistant] = projected.messages
  assert('text' in user && 'text' in assistant)
  assert.equal(user.text, submission.messages[0].text)
  assert.equal(assistant.text, submission.messages[2].text)
  const tool = projected.messages[1]
  assert('excerpts' in tool && tool.excerpts)
  for (const excerpt of tool.excerpts) assert(submission.messages[1].text.includes(excerpt))
  assert.equal(tool.tool_metadata.exit_code, 0)
  assert(tool.omitted_characters > 0)
  assert(jsonBytes(projected) < jsonBytes(submission) / 5)
  assert(!JSON.stringify(projected).includes('local.jsonl'))
  const many = projectMessages(Array.from({ length: 30 }, (_, index) => ({ ...submission.messages[1], message_id: `t${index}` })))
  assert(many.reduce((count, message) => count + Array.from('text' in message ? message.text : message.excerpts.join('')).length, 0) <= materialLimits.totalToolCharacters)
  assert.deepEqual(submission, before)
})

test('comparison includes only cited evidence, unique new facts and bounded intact old facts', () => {
  const previous = Array.from({ length: 30 }, (_, i) => ({ ...entry(i), content: `事实 ${i}：` + '保留适用条件。'.repeat(180) }))
  const next = { ...entry(31), submission_id: submission.submission_id, content: '超时时间改成 60 秒。' }
  const input: ComparisonInput = { submission, extraction: { schema_version: 1, memories: [{ content: next.content, basis: 'user_statement', scope: 'project', source_message_ids: ['user'] }], proposals: [], revisions: [] }, current_entries: [next], previous_entries: previous, previous_conflicts: [] }
  const before = structuredClone(input), result = comparisonMaterial(input)
  assert.deepEqual(result.messages.map(message => message.message_id), ['user'])
  assert.equal(result.current_entries[0].content, next.content)
  assert(!('memories' in result.extraction))
  assert(result.previous_entries.length <= comparisonLimits.maxEntries)
  assert(result.previous_entries.reduce((total, candidate) => total + jsonBytes(candidate), 0) <= comparisonLimits.maxBytes)
  for (const old of result.previous_entries) assert.equal(old.content, previous.find(candidate => candidate.id === old.id)!.content)
  assert(!JSON.stringify(result).includes('content_sha256'))
  assert.deepEqual(input, before)
  const reversed = comparisonMaterial({ ...input, previous_entries: input.previous_entries.slice(0, 2).toReversed() })
  const ordered = comparisonMaterial({ ...input, previous_entries: input.previous_entries.slice(0, 2) })
  assert.deepEqual(reversed.previous_entries, ordered.previous_entries)
})

test('usage includes cached input exactly once and missing usage stays unavailable', () => {
  const run = { events: [
    { type: 'assistant/message', data: { usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 30 } } },
  ] } as unknown as RunResult
  assert.deepEqual(agentUsage(run), { input_tokens: 2000, cache_hit_tokens: 1700, output_tokens: 50, requests: 2 })
  assert.equal(agentUsage({ events: [] } as unknown as RunResult), undefined)
})
