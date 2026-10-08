import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readMemory } from './reading.ts'
import type { MemoStorage } from './storage/storage.ts'

type Entry = Awaited<ReturnType<MemoStorage['getEntry']>>

const entry = (content: string): Entry => ({
  id: '00000000-0000-0000-0000-000000000001', submission_id: '00000000-0000-0000-0000-000000000002', position: 0,
  collection: 'proposals', content, content_sha256: 'hash', basis: 'assistant_proposal', scope: 'project',
  source_message_ids: ['source-message'], project_ids: ['project'], business_ids: [], source_session_id: 'session', entities: [],
  source_occurred_at: null, valid_from: null, valid_until: null, state: 'active', claim_status: 'candidate', archived: false,
  received_at: new Date('2026-01-01T00:00:00Z'), published_at: null, confirmed_at: null, invalid_at: null,
  source: { provider: 'codex', session_id: 'session' }, version: 'version',
  messages: Array.from({ length: 20 }, (_, index) => ({ message_id: `message-${index}`, role: 'assistant' as const,
    text: `${content} ${'长内容'.repeat(2_000)}`, occurred_at: '2026-01-01T00:00:00Z' })),
  additional_sources: [], index_receipts: [], as_of: null,
  relations: [],
  relations_truncated: false, actions: [], actions_truncated: false,
})

test('evidence stays within Unicode budget and full read remains canonical', () => {
  const full = entry(`建议使用 Bearer secret-token-value。${'事实'.repeat(2_000)}`)
  const evidence = readMemory(full, 'evidence')
  assert(Array.from(JSON.stringify(evidence, null, 2)).length <= 12_000)
  assert.equal(evidence.id, full.id)
  assert.equal(evidence.version, full.version)
  assert.equal(evidence.next, `jth memo read ${full.id} --level full`)
  assert(evidence.messages_truncated)
  assert(evidence.messages.some(message => message.message_id === 'message-0'))
  assert(!JSON.stringify(evidence).includes('secret-token-value'))
  assert.deepEqual(readMemory(full, 'full'), full)
})

test('evidence compresses oversized metadata without losing trace IDs', () => {
  const full = {
    ...entry('事实'),
    project_ids: Array.from({ length: 200 }, (_, index) => `project-${index}-${'x'.repeat(100)}`),
    business_ids: Array.from({ length: 100 }, (_, index) => `business-${index}-${'x'.repeat(100)}`),
    source: { provider: 'codex' as const, session_id: 'session', codex: {
      transcript_path: `/tmp/${'x'.repeat(4_000)}`, start_offset: 0, end_offset: 4_001, parser_version: 1 as const,
    } },
    derivation: { stale: false, sources: Array.from({ length: 10 }, (_, index) => ({ entry_id: `entry-${index}`, read_version: 'a'.repeat(64), current_version: 'a'.repeat(64), stale: false })) },
  } as Entry
  const evidence = readMemory(full, 'evidence')
  assert(Array.from(JSON.stringify(evidence, null, 2)).length <= 12_000)
  assert.equal(evidence.id, full.id)
  assert.equal(evidence.version, full.version)
  assert.equal(evidence.next, `jth memo read ${full.id} --level full`)
  assert.equal((evidence.source as { message_ids: string[] }).message_ids[0], 'message-0')
  assert(evidence.metadata_truncated || evidence.truncated)
  assert.deepEqual(readMemory(full, 'full'), full)
})
