import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { optionsSchema } from '../contracts.ts'
import { reconcileMemories } from './reconcile.ts'
import type { ComparisonInput } from './reconcile.ts'
import type { StateEntry } from '../storage/relations.ts'

test('live comparison keeps unannounced contradictions unresolved and ignores unrelated facts', {
  skip: process.env.DSH_RECONCILE_LIVE !== '1', timeout: 400_000,
}, async () => {
  const runtime = optionsSchema.parse(JSON.parse(await readFile(new URL('./runtime.json', import.meta.url), 'utf8')))
  const old: StateEntry = {
    id: randomUUID(), submission_id: 'previous', position: 0, collection: 'memories',
    content: '项目生产 API 地址为 https://alpha.example.invalid。', content_sha256: 'a'.repeat(64),
    basis: 'user_statement', scope: 'project', source_message_ids: ['previous-u'],
    project_ids: ['comparison-check'], business_ids: [], source_session_id: 'previous-session', state: 'active',
    entities: [], source_occurred_at: null, valid_from: null, valid_until: null,
    claim_status: 'asserted', archived: false, received_at: new Date(), published_at: new Date(), confirmed_at: null, invalid_at: null,
  }
  for (const scenario of [
    { content: '项目生产 API 地址为 https://beta.example.invalid。', expected: 'conflict' },
    { content: '项目 README 使用中文编写。', expected: null },
  ]) {
    const next = { ...old, id: randomUUID(), submission_id: 'current', content: scenario.content, source_message_ids: ['current-u'] }
    const input: ComparisonInput = {
      submission: { schema_version: 1, submission_id: 'current', source: { provider: 'codex', session_id: 'current-session' },
        scope: { project_ids: ['comparison-check'], business_ids: [] }, messages: [{ message_id: 'current-u', role: 'user', text: scenario.content }] },
      extraction: { schema_version: 1, memories: [{ content: next.content, basis: 'user_statement', scope: 'project', source_message_ids: ['current-u'] }], proposals: [], revisions: [] },
      current_entries: [next], previous_entries: [old], previous_conflicts: [],
    }
    const decision = await reconcileMemories(input, runtime)
    if (scenario.expected) {
      assert.equal(decision.relations.length, 1)
      assert.equal(decision.relations[0].kind, scenario.expected)
    } else assert.equal(decision.relations.length, 0)
  }
})
