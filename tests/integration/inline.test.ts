import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { Pool } from 'pg'
import { loadConfig, prepareDatabase, recordMemories, recordId, MemoStorage, runIndexWorker, jobStatus, retryJob, enqueue, executionProfile, manageEntry, sha256, storageDoctor } from '@jt-harness/memo'
import type { Evidence, RecordDraft } from '@jt-harness/memo/contracts'

test('in-session records publish using only Embedding, with durable retries and optimistic revisions', {
  skip: !process.env.JTH_TEST_DATABASE_URL, timeout: 60_000,
}, async t => {
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL, max: 5 })
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'jth_test')
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-inline-db-'))
  const env = resolve(directory, '.env')
  await writeFile(env, `JTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\nJTH_DATA_DIR=${directory}\nEMBEDDING_API_KEY=test\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=inline-test\nEMBEDDING_DIMENSIONS=2\nJTH_DSH_BIN=/must-not-execute-dsh\n`)
  const config = await loadConfig(process.cwd(), env, {})
  const storage = new MemoStorage(pool)
  const evidence = (key: string, text: string): Evidence => {
    const id = `evidence-${sha256(key)}`
    return { id, run: { session_id: 'inline-codex', provider: 'codex', model: 'session-model' }, submission: {
      schema_version: 1, submission_id: id, source: { provider: 'codex', session_id: 'inline-codex' },
      scope: { project_ids: ['inline-test'], business_ids: [] },
      messages: [{ message_id: `source-${key}`, role: 'user', text, occurred_at: new Date().toISOString() }],
    } }
  }
  const draft = (source: Evidence, content: string): RecordDraft => ({ evidence_id: source.id, extraction: {
    schema_version: 1, memories: [{ content, basis: 'user_statement', scope: 'project', source_message_ids: [source.submission.messages[0].message_id] }], proposals: [], revisions: [],
  } })
  let calls = 0
  let failEmbedding = false
  const api = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    assert.equal(String(url), 'https://example.invalid/v1/embeddings', 'Only the Embedding API may be invoked')
    calls++
    return failEmbedding ? Response.json({}, { status: 503 }) : Response.json({ model: 'inline-test', data: [{ index: 0, embedding: [1, 0] }] })
  })
  const work = () => runIndexWorker(pool, async () => config)
  try {
    await prepareDatabase(pool, true)
    assert.equal((await pool.query('SELECT version FROM jt_memo.schema_version')).rows[0].version, 5)
    const initial = evidence('initial', '该项目请求超时为 17 秒。')
    const first = draft(initial, '请求超时为 17 秒。')
    let firstId = ''
    await t.test('body and index job commit together, duplicate records do not create another fact', async () => {
      const accepted = await Promise.all([recordMemories(pool, first, initial, config), recordMemories(pool, first, initial, config)])
      assert.equal(accepted.filter(receipt => receipt.duplicate).length, 1)
      firstId = accepted[0].submission_id
      assert.equal((await jobStatus(pool, firstId)).kind, 'index')
      const pending = await storage.getSubmission(firstId)
      assert.equal(pending.entries[0].state, 'pending')
      assert.equal(pending.run.provider, 'codex')
      assert.equal(calls, 0, 'acceptance cannot wait for Embedding')
      const legacy = { ...initial.submission, submission_id: 'inline-legacy-must-not-run' }
      await enqueue(pool, legacy, executionProfile(config))
      assert.equal((await work()).completed, 1)
      assert.equal((await jobStatus(pool, legacy.submission_id)).status, 'queued')
      assert.equal((await storage.getSubmission(firstId)).entries[0].state, 'active')
    })
    await t.test('queue insert failure rolls back the already staged source and candidate', async () => {
      const source = evidence('rollback', '事务失败不能留下半份记忆。'), input = draft(source, '事务失败不能留下半份记忆。'), id = recordId(input)
      await pool.query(`CREATE FUNCTION jt_memo.reject_inline_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${id}' THEN RAISE EXCEPTION 'test queue failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_inline_job BEFORE INSERT ON jt_memo.jobs FOR EACH ROW EXECUTE FUNCTION jt_memo.reject_inline_job()`)
      try {
        await assert.rejects(recordMemories(pool, input, source, config), /test queue failure/)
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM jt_memo.submissions WHERE id=$1', [id])).rows[0].count, 0)
      } finally { await pool.query('DROP TRIGGER reject_inline_job ON jt_memo.jobs; DROP FUNCTION jt_memo.reject_inline_job()') }
    })
    await t.test('Embedding retries reuse the saved body and never extract again', async () => {
      const source = evidence('retry', '新的写入仅排队生成向量。')
      const accepted = await recordMemories(pool, draft(source, '新的写入仅排队生成向量。'), source, config)
      const before = await storage.getSubmission(accepted.submission_id)
      failEmbedding = true
      assert.equal((await work()).failed, 1)
      failEmbedding = false
      await retryJob(pool, accepted.submission_id)
      assert.equal((await work()).completed, 1)
      const after = await storage.getSubmission(accepted.submission_id)
      assert.equal(after.entries[0].id, before.entries[0].id)
      assert.equal(after.run.provider, 'codex')
    })
    const oldId = (await storage.getSubmission(firstId)).entries[0].id
    const correction = (source: Evidence, version: string): RecordDraft => ({ ...draft(source, '请求超时为 20 秒。'), changes: [{
      kind: 'correction', previous_entry_id: oldId, expected_version: version, current_memory_index: 0, revision_index: null,
      explanation: '用户明确更正超时', source_message_ids: [source.submission.messages[0].message_id], evidence_quote: source.submission.messages[0].text,
    }] })
    await t.test('stale decisions become review candidates without blocking their index or replacing old facts', async () => {
      const before = await storage.getEntry(oldId)
      const source = evidence('stale', '将请求超时改为 20 秒。')
      const input = correction(source, before.version!)
      const accepted = await recordMemories(pool, input, source, config)
      await manageEntry(pool, { action: 'approve', entry_id: oldId, reason: '独立确认', evidence_ref: 'test-evidence' })
      const rejectedSource = evidence('reject-stale', '将请求超时改为 20 秒。')
      await assert.rejects(recordMemories(pool, correction(rejectedSource, before.version!), rejectedSource, config), /版本已变化/)
      assert.equal((await work()).completed, 1)
      const result = await storage.getSubmission(accepted.submission_id)
      assert.equal(result.entries[0].claim_status, 'candidate')
      assert.equal(result.index_receipts[0].status, 'review_required')
      assert.equal((await storage.getEntry(oldId)).state, 'active')
    })
    await t.test('an explicit current revision applies atomically with its vector, without another LLM', async () => {
      const previous = await storage.getEntry(oldId)
      const source = evidence('correct', '将请求超时改为 20 秒。')
      const accepted = await recordMemories(pool, correction(source, previous.version!), source, config)
      assert.equal((await work()).completed, 1)
      assert.equal((await storage.getEntry(oldId)).state, 'superseded')
      assert.equal((await storage.getSubmission(accepted.submission_id)).entries[0].state, 'active')
      assert.equal((await storageDoctor(pool)).ok, true)
    })
  } finally { api.mock.restore(); await pool.end(); await rm(directory, { recursive: true, force: true }) }
})
