import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { Pool } from 'pg'
import { loadConfig, manageEntry, MemoStorage, prepareDatabase, recordDeclaration, recordId, recordMemories, runIndexWorker, sha256 } from '@jt-harness/memo'
import type { Evidence, RecordDraft } from '@jt-harness/memo/contracts'

test('derived proposals retain complete project scopes and source versions, and become stale after source governance changes', {
  skip: !process.env.JTH_TEST_DATABASE_URL, timeout: 60_000,
}, async t => {
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL, max: 4 })
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-derivation-db-'))
  const env = resolve(directory, '.env')
  await writeFile(env, `JTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\nJTH_DATA_DIR=${directory}\nEMBEDDING_API_KEY=test\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=derivation-test\nEMBEDDING_DIMENSIONS=2\n`)
  const config = await loadConfig(process.cwd(), env, {})
  const storage = new MemoStorage(pool)
  const projectIds = ['derivation-test', 'derivation-shared']
  const evidence = (key: string, text: string): Evidence => ({
    id: `evidence-${sha256(key)}`, run: { session_id: 'derivation-test', provider: 'test', model: 'test' },
    submission: { schema_version: 1, submission_id: `evidence-${sha256(key)}`, source: { provider: 'codex', session_id: 'derivation-test' },
      scope: { project_ids: projectIds, business_ids: [] }, messages: [{ message_id: `message-${key}`, role: 'user', text, occurred_at: new Date().toISOString() }] },
  })
  const memoryDraft = (source: Evidence, content: string): RecordDraft => ({ evidence_id: source.id, extraction: {
    schema_version: 1, memories: [{ content, basis: 'user_statement', scope: 'project', source_message_ids: [source.submission.messages[0].message_id] }], proposals: [], revisions: [],
  } })
  const work = () => runIndexWorker(pool, async () => config)
  const api = t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'derivation-test', data: [{ index: 0, embedding: [1, 0] }] }))
  try {
    await prepareDatabase(pool, true)
    const source = evidence('source', '请求超时为 17 秒。')
    const saved = await recordMemories(pool, memoryDraft(source, '请求超时为 17 秒。'), source, config)
    await work()
    const sourceEntry = await storage.getEntry((await storage.getSubmission(saved.submission_id)).entries[0].id)
    const rejectedCount = async (id: string) => (await pool.query('SELECT count(*)::int AS count FROM jt_memo.submissions WHERE id=$1', [id])).rows[0].count
    const derivedSource = evidence('derived', '根据请求超时事实形成操作建议。')
    const invalidVersionSource = evidence('invalid-version', '派生版本冲突不能留下半份提交。')
    const invalidVersionDraft: RecordDraft = { evidence_id: invalidVersionSource.id, extraction: {
      schema_version: 1, memories: [], proposals: [{ content: '版本冲突派生建议。', basis: 'assistant_proposal', scope: 'project', source_message_ids: [invalidVersionSource.submission.messages[0].message_id] }], revisions: [],
    }, derivations: [{ proposal_index: 0, sources: [{ entry_id: sourceEntry.id, read_version: '0'.repeat(64) }] }] }
    await assert.rejects(recordMemories(pool, invalidVersionDraft, invalidVersionSource, config), /版本已变化/)
    assert.equal(await rejectedCount(recordId(invalidVersionDraft)), 0)
    for (const [key, project_ids] of [['cross-scope', ['other-project']], ['subset-scope', ['derivation-test']]] as const) {
      const crossScopeSource = evidence(key, '跨项目派生必须拒绝。')
      crossScopeSource.submission.scope = { project_ids: [...project_ids], business_ids: [] }
      const crossScopeDraft: RecordDraft = { evidence_id: crossScopeSource.id, extraction: {
        schema_version: 1, memories: [], proposals: [{ content: '跨范围派生建议。', basis: 'assistant_proposal', scope: 'project', source_message_ids: [crossScopeSource.submission.messages[0].message_id] }], revisions: [],
      }, derivations: [{ proposal_index: 0, sources: [{ entry_id: sourceEntry.id, read_version: sourceEntry.version! }] }] }
      await assert.rejects(recordMemories(pool, crossScopeDraft, crossScopeSource, config), /范围/)
      assert.equal(await rejectedCount(recordId(crossScopeDraft)), 0)
    }
    const derived: RecordDraft = { evidence_id: derivedSource.id, extraction: {
      schema_version: 1, memories: [{ content: '派生批次保留普通事实。', basis: 'user_statement', scope: 'project', source_message_ids: [derivedSource.submission.messages[0].message_id] }],
      proposals: [{ content: '建议将超时预算设为 20 秒。', basis: 'assistant_proposal', scope: 'project', source_message_ids: [derivedSource.submission.messages[0].message_id] }], revisions: [],
    }, derivations: [{ proposal_index: 0, sources: [{ entry_id: sourceEntry.id, read_version: sourceEntry.version! }] }] }
    const accepted = await recordMemories(pool, derived, derivedSource, config)
    const derivedEntries = (await storage.getSubmission(accepted.submission_id)).entries
    assert.equal(derivedEntries.length, 2)
    const derivedEntryId = derivedEntries[1].id
    await work()
    assert.deepEqual((await storage.getEntry(derivedEntryId)).derivation?.sources.map(source => source.read_version), [sourceEntry.version])
    await manageEntry(pool, { action: 'approve', entry_id: derivedEntryId, reason: '来源当前有效', evidence_ref: 'test:source' })
    const chainSource = evidence('chain', '派生链必须拒绝。')
    const chainEntry = await storage.getEntry(derivedEntryId)
    const chainDraft: RecordDraft = { evidence_id: chainSource.id, extraction: {
      schema_version: 1, memories: [], proposals: [{ content: '派生链建议。', basis: 'assistant_proposal', scope: 'project', source_message_ids: [chainSource.submission.messages[0].message_id] }], revisions: [],
    }, derivations: [{ proposal_index: 0, sources: [{ entry_id: derivedEntryId, read_version: chainEntry.version! }] }] }
    await assert.rejects(recordMemories(pool, chainDraft, chainSource, config), /派生来源不能再依赖/)
    assert.equal(await rejectedCount(recordId(chainDraft)), 0)
    const declarationSource = evidence('declaration-derived', '声明批次同时保留普通事实与派生建议。')
    const declarationDraft: RecordDraft = { evidence_id: declarationSource.id, extraction: {
      schema_version: 1,
      memories: [{ content: '声明批次普通事实。', basis: 'user_statement', scope: 'project', source_message_ids: [declarationSource.submission.messages[0].message_id] }],
      proposals: [
        { content: '声明批次派生建议。', basis: 'assistant_proposal', scope: 'project', source_message_ids: [declarationSource.submission.messages[0].message_id] },
        { content: '声明批次派生建议。', basis: 'assistant_proposal', scope: 'project', source_message_ids: [declarationSource.submission.messages[0].message_id] },
      ], revisions: [],
    }, derivations: [
      { proposal_index: 0, sources: [{ entry_id: sourceEntry.id, read_version: sourceEntry.version! }] },
      { proposal_index: 1, sources: [{ entry_id: sourceEntry.id, read_version: sourceEntry.version! }] },
    ] }
    const declaration = await recordDeclaration(pool, declarationDraft, declarationSource, config)
    const declarationEntries = (await storage.getSubmission(declaration.submission_id!)).entries
    assert.equal(declarationEntries.length, 2)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM jt_memo.entry_derivations WHERE derived_entry_id=$1', [declarationEntries[1].id])).rows[0].count, 1)
    await work()
    const archive = await manageEntry(pool, { action: 'archive', entry_id: sourceEntry.id, reason: '测试来源失效' })
    const beforeArchive = new Date(new Date(archive.receipts[0].acted_at).getTime() - 1).toISOString()
    const staleEntry = await storage.getEntry(derivedEntryId)
    assert.equal(staleEntry.derivation?.stale, true)
    assert.notEqual(staleEntry.version, chainEntry.version)
    assert.equal((await storage.getEntry(derivedEntryId, beforeArchive)).derivation?.stale, false)
    const staleQuery = { scope: { kind: 'project' as const, project_ids: projectIds }, space_id: config.embedding.space!.id, vector: [1, 0] }
    assert.equal((await storage.retrieve({ ...staleQuery, query: '建议 超时', mode: 'keyword' })).entries.some(entry => entry.id === derivedEntryId), false)
    assert.equal((await storage.retrieve({ ...staleQuery, query: '建议 超时', mode: 'keyword', include_history: true })).entries.some(entry => entry.id === derivedEntryId), true)
    assert.equal((await storage.search({ ...staleQuery, include_history: true })).entries.some(entry => entry.id === derivedEntryId), true)
    await assert.rejects(manageEntry(pool, { action: 'approve', entry_id: derivedEntryId, reason: '来源已归档', evidence_ref: 'test:source' }), /来源已失效|来源已变化/)
  } finally {
    api.mock.restore()
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  }
})
