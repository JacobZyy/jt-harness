import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import type { Extraction, Submission } from '@jt-harness/memo/contracts'
import type { extractMemories } from '@jt-harness/memo/legacy'
import { executionProfile, loadConfig } from '@jt-harness/memo/config'
import { prepareDatabase } from '@jt-harness/memo'
import { enqueue, jobStatus, retryJob } from '@jt-harness/memo'
import type { Job } from '@jt-harness/memo'
import { MemoStorage } from '@jt-harness/memo'
import { processJob, runLegacyWorker as drainWorker } from '@jt-harness/memo/legacy'
import { relationSchema } from '@jt-harness/memo'
import { listManagedEntries, manageEntry, storageStats } from '@jt-harness/memo'
import { storageDoctor } from '@jt-harness/memo'
import { captureEvent, prepareEvidence, readEvidence, registerCaptures } from '@jt-harness/codex-hooks'
import { recordMemories, runIndexWorker } from '@jt-harness/memo'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const source = (id: string): Submission => ({
  schema_version: 1, submission_id: id,
  source: { provider: 'codex', session_id: 'session-one' },
  scope: { project_ids: ['project-a', 'project-b'], business_ids: ['shipping'] },
  messages: [
    { message_id: 'u1', role: 'user', text: '用户已提供的项目、个人、任务和业务事实。' },
    { message_id: 'a1', role: 'assistant', text: '尚未确认的助手建议。' },
  ],
})
const extraction: Extraction = {
  schema_version: 1,
  memories: ['project', 'business', 'user', 'current_task', 'unspecified'].map(scope => ({
    content: `事实 ${scope}`, basis: 'user_statement', scope: scope as Extraction['memories'][number]['scope'], source_message_ids: ['u1'],
  })),
  proposals: [{ content: '未确认的建议', basis: 'assistant_proposal', scope: 'project', source_message_ids: ['a1'] }],
  revisions: [{ kind: 'correction', earlier_content: '旧说法', later_content: '新说法', explanation: '保留纠正证据。', source_message_ids: ['u1'] }],
}
const run = { session_id: 'test-dsh-session', provider: 'test', model: 'test' }

test('native PostgreSQL + pgvector: durable queue, atomic publication, scope isolation and recovery', {
  skip: !process.env.JTH_TEST_DATABASE_URL, timeout: 60_000,
}, async t => {
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL, max: 5, connectionTimeoutMillis: 2000 })
  const database = await pool.query<{ name: string }>('SELECT current_database() AS name')
  assert.equal(database.rows[0].name, 'jth_test', 'Only the disposable jth_test database may run this suite')
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-tests-'))
  const envFile = resolve(directory, '.env')
  await writeFile(envFile, [
    `JTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}`,
    'EMBEDDING_API_KEY=test-placeholder', 'EMBEDDING_BASE_URL=https://example.invalid/v1',
    'EMBEDDING_MODEL=test', 'EMBEDDING_DIMENSIONS=2', `JTH_DATA_DIR=${directory}`,
  ].join('\n'), { mode: 0o600 })
  const config = await loadConfig(root, envFile, {})
  const execution = executionProfile(config)
  const storage = new MemoStorage(pool)
  const runWorker = (database: Pool, directory: string, signal?: AbortSignal) => drainWorker(database, directory, signal, async () => ({ relations: [], run }))
  const vectors = async (id: string) => ({
    submission_id: id, space: execution.space,
    embeddings: (await storage.getSubmission(id)).entries.map(entry => ({ entry_id: entry.id, content_sha256: entry.content_sha256, vector: [1, 0] })),
  })
  let extractionCalls = 0
  const extract: typeof extractMemories = async (input) => {
    extractionCalls++
    const submission = input as Submission
    return { status: 'extracted', submission_id: submission.submission_id, source: submission.source, scope: submission.scope, run, ...extraction }
  }
  const fakeApi = t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { input } = JSON.parse(String(init?.body))
    return Response.json({ model: 'test', data: input.map((_: string, index: number) => ({ index, embedding: [1, 0] })) })
  })
  try {
    await prepareDatabase(pool, true)
    await prepareDatabase(pool, true)
    const version = await pool.query('SELECT extversion FROM pg_extension WHERE extname = $1', ['vector'])
    assert(version.rows[0].extversion)

    await t.test('acceptance commits before extraction; retries preserve payload identity', async () => {
      const receipts = await Promise.all([enqueue(pool, source('batch'), execution), enqueue(pool, source('batch'), execution)])
      assert.equal(receipts.filter(receipt => receipt.duplicate).length, 1)
      assert.equal(extractionCalls, 0)
      await assert.rejects(enqueue(pool, { ...source('batch'), messages: [{ message_id: 'u2', role: 'user', text: 'different' }] }, execution), /不同材料/)
      assert.equal((await jobStatus(pool, 'batch')).status, 'queued')
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM jt_memo.jobs')).rows[0].count, 1)
    })

    await t.test('embedding failure preserves extraction; retry resumes without another model call', async () => {
      const client = await pool.connect()
      const job: Job = { id: 'batch', payload: source('batch'), execution }
      try {
        fakeApi.mock.mockImplementationOnce(async () => Response.json({}, { status: 503 }))
        await assert.rejects(processJob(client, job, config, undefined, extract), /HTTP 503/)
        assert.equal(extractionCalls, 1)
        const checkpoint = await storage.getSubmission('batch')
        assert.equal(checkpoint.entries.length, 6)
        assert.equal(checkpoint.index_receipts.length, 0)
        const receipt = await processJob(client, job, config, undefined, extract)
        assert.equal(receipt.entry_count, 6)
        assert.equal(extractionCalls, 1)
        const calls = fakeApi.mock.callCount()
        assert.deepEqual(await processJob(client, job, config, undefined, extract), receipt)
        assert.equal(fakeApi.mock.callCount(), calls)
      } finally { client.release() }
      await assert.rejects(storage.store({ submission: source('batch'), extraction: { ...extraction, proposals: [] }, run }), /不同的材料或提炼结果/)
    })

    await t.test('database failure rolls back all vectors, space and receipt together', async () => {
      await storage.store({ submission: source('atomic'), extraction, run })
      const input = await vectors('atomic')
      const finalId = input.embeddings.map(entry => entry.entry_id).sort().at(-1)!
      await pool.query(`
        CREATE FUNCTION jt_memo.reject_test_vector() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.entry_id = '${finalId}'::uuid THEN RAISE EXCEPTION 'simulated vector write failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_vector_failure BEFORE INSERT ON jt_memo.embeddings FOR EACH ROW EXECUTE FUNCTION jt_memo.reject_test_vector();
      `)
      const newSpace = { ...input.space, id: 'atomic-test-space' }
      await assert.rejects(storage.index({ ...input, space: newSpace }), /simulated vector write failure/)
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM jt_memo.embeddings WHERE submission_id = 'atomic'")).rows[0].count, 0)
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM jt_memo.embedding_spaces WHERE id = 'atomic-test-space'")).rows[0].count, 0)
      assert.equal((await storage.getSubmission('atomic')).index_receipts.length, 0)
      await pool.query('DROP TRIGGER test_vector_failure ON jt_memo.embeddings; DROP FUNCTION jt_memo.reject_test_vector()')
      await assert.rejects(storage.index({ ...input, embeddings: input.embeddings.slice(1) }), /完整对应/)
      const receipt = await storage.index(input)
      assert.deepEqual(await storage.index(input), receipt)
      await assert.rejects(storage.index({ ...input, embeddings: input.embeddings.map(entry => ({ ...entry, vector: [0, 1] })) }), /不同向量/)
      await assert.rejects(storage.index({ ...input, space: { ...input.space, model: 'different-model' } }), /不同的模型/)
    })

    await t.test('retrieval excludes unrelated scopes and proposals; reads bind original evidence', async () => {
      const base = { space_id: execution.space.id, vector: [1, 0] }
      assert.equal((await storage.search({ ...base, scope: { kind: 'project', project_ids: ['project-a'] } })).entries.length, 0)
      const both = await storage.search({ ...base, scope: { kind: 'project', project_ids: ['project-a', 'project-b'] } })
      assert.equal(both.entries.length, 2)
      assert(both.entries.every(entry => entry.collection === 'memories'))
      assert.equal((await storage.search({ ...base, scope: { kind: 'project', project_ids: ['project-a', 'project-b'] }, include_proposals: true })).entries.length, 4)
      assert.equal((await storage.search({ ...base, scope: { kind: 'current_task', source_session_id: 'wrong' } })).entries.length, 0)
      assert.equal((await storage.search({ ...base, scope: { kind: 'unspecified', submission_id: 'batch' } })).entries.length, 1)
      const entry = await storage.getEntry(both.entries[0].id)
      assert.deepEqual(entry.messages.map(message => message.message_id), ['u1'])
      assert(!('embedding' in entry))
      assert.equal((await storage.getSubmission('batch')).extraction.revisions.length, 1)
    })

    await t.test('interrupted jobs recover from index commit; lock contenders do not lose wakeups', async () => {
      await pool.query("UPDATE jt_memo.jobs SET status = 'running' WHERE id = 'batch'")
      const lock = await pool.connect()
      await lock.query("SELECT pg_advisory_lock(hashtextextended('jt_memo:worker', 0))")
      const first = runWorker(pool, root)
      const second = runWorker(pool, root)
      await enqueue(pool, source('atomic'), execution)
      await lock.query("SELECT pg_advisory_unlock(hashtextextended('jt_memo:worker', 0))")
      lock.release()
      const results = await Promise.all([first, second])
      assert.equal(results.reduce((count, result) => count + result.completed, 0), 2)
      assert.equal((await jobStatus(pool, 'batch')).status, 'complete')
      assert.equal((await jobStatus(pool, 'atomic')).status, 'complete')
      assert.equal(extractionCalls, 1)
    })

    await t.test('failed task retries keep checkpoint and do not overwrite accepted model profile', async () => {
      await enqueue(pool, source('failed'), execution)
      await storage.store({ submission: source('failed'), extraction, run })
      fakeApi.mock.mockImplementationOnce(async () => Response.json({}, { status: 429 }))
      assert.equal((await runWorker(pool, root)).failed, 1)
      assert.equal((await jobStatus(pool, 'failed')).status, 'failed')
      const beforeRetry = (await pool.query('SELECT payload,execution FROM jt_memo.jobs WHERE id=$1', ['failed'])).rows[0]
      await assert.rejects(retryJob(pool, 'failed', 0))
      assert.equal((await jobStatus(pool, 'failed')).status, 'failed')
      await retryJob(pool, 'failed', 600000)
      const afterRetry = (await pool.query('SELECT payload,execution FROM jt_memo.jobs WHERE id=$1', ['failed'])).rows[0]
      assert.deepEqual(afterRetry, { ...beforeRetry, execution: { ...beforeRetry.execution, agent: { ...beforeRetry.execution.agent, timeoutMs: 600000 } } })
      assert.equal((await runWorker(pool, root)).completed, 1)
      assert.equal((await jobStatus(pool, 'failed')).attempts, 2)
      await assert.rejects(retryJob(pool, 'failed'), /只能 retry/)
    })

    await t.test('zero candidates create a durable noop receipt without embedding API calls', async () => {
      await enqueue(pool, source('empty'), execution)
      await storage.store({ submission: source('empty'), extraction: { schema_version: 1, memories: [], proposals: [], revisions: [] }, run })
      const calls = fakeApi.mock.callCount()
      await runWorker(pool, root)
      assert.equal(fakeApi.mock.callCount(), calls)
      assert.equal((await storage.getSubmission('empty')).index_receipts[0].status, 'noop')
    })

    await t.test('aborting a lock waiter closes its session; dead sessions cannot publish', async () => {
      const lock = await pool.connect()
      await lock.query("SELECT pg_advisory_lock(hashtextextended('jt_memo:worker', 0))")
      const controller = new AbortController()
      const waiting = runWorker(pool, root, controller.signal)
      const rejected = assert.rejects(waiting)
      controller.abort(new Error('test interruption'))
      await rejected
      await lock.query("SELECT pg_advisory_unlock(hashtextextended('jt_memo:worker', 0))")
      lock.release()
      const client = await pool.connect()
      client.on('error', () => {})
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await pool.query('SELECT pg_terminate_backend($1)', [pid])
      await assert.rejects(new MemoStorage(client).store({ submission: source('stale'), extraction, run }))
      client.release(true)
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM jt_memo.submissions WHERE id = 'stale'")).rows[0].count, 0)
    })

    await t.test('v1 migration preserves existing source, vector bytes and receipts', async () => {
      const before = await pool.query('SELECT entry_id,embedding::text AS vector FROM jt_memo.embeddings ORDER BY entry_id')
      await pool.query(`DROP VIEW jt_memo.entry_states; DROP FUNCTION jt_memo.entry_facts_at(timestamptz);
        DROP TABLE jt_memo.entry_actions; DROP TABLE jt_memo.entry_relations;
        ALTER TABLE jt_memo.entries DROP COLUMN entities, DROP COLUMN source_occurred_at, DROP COLUMN valid_from, DROP COLUMN valid_until;
        ALTER TABLE jt_memo.submissions DROP COLUMN received_at;
        ALTER TABLE jt_memo.index_commits DROP COLUMN relation_decisions, DROP COLUMN reconciliation_run, DROP COLUMN publication_notes;
        ALTER TABLE jt_memo.jobs DROP COLUMN kind, DROP COLUMN record_plan; UPDATE jt_memo.schema_version SET version=1`)
      await assert.rejects(prepareDatabase(pool, false), /memo init/)
      await prepareDatabase(pool, true)
      assert.deepEqual((await pool.query('SELECT entry_id,embedding::text AS vector FROM jt_memo.embeddings ORDER BY entry_id')).rows, before.rows)
      assert.equal((await storage.getSubmission('batch')).index_receipts.length, 1)
    })

    await t.test('correction, supplement, unresolved conflicts and historical reads publish atomically', async () => {
      const make = async (id: string, content: string, message: string, project = 'revision-project') => {
        const submission = { ...source(id), scope: { project_ids: [project], business_ids: [] }, messages: [{ message_id: 'u1', role: 'user' as const, text: message }] }
        const result: Extraction = {
          schema_version: 1, memories: [{ content, basis: 'user_statement', scope: 'project', source_message_ids: ['u1'] }], proposals: [], revisions: [],
        }
        await storage.store({ submission, extraction: result, run })
        return { id, entry: (await storage.getSubmission(id)).entries[0], message }
      }
      const relation = (kind: 'correction' | 'supplement' | 'conflict', previousId: string, next: Awaited<ReturnType<typeof make>>) => relationSchema.parse({
        kind, previous_entry_id: previousId, current_entry_id: next.entry.id, revision_index: null,
        explanation: `${kind} evidence`, source_message_ids: ['u1'], evidence_quote: next.message,
      })
      const old = await make('rev-old', 'API 使用 A。', '项目 API 使用 A。')
      await storage.index(await vectors(old.id))
      const next = await make('rev-correct', 'API 使用 B。', '更正：项目 API 从 A 改为 B，以 B 为准。')
      const correction = relation('correction', old.entry.id, next)
      const publication = { ...await vectors(next.id), relations: [correction], reconciliation_run: run }
      await assert.rejects(storage.index({ ...publication, relations: [{ ...correction, evidence_quote: 'fabricated' }] }), /来源原文/)
      assert.equal((await storage.getEntry(old.entry.id)).state, 'active')
      assert.equal((await storage.getEntry(next.entry.id)).state, 'pending')
      assert.equal((await storage.getSubmission(next.id)).index_receipts.length, 0)
      const receipt = await storage.index(publication)
      assert.deepEqual(await storage.index(publication), receipt)
      assert.equal((await storage.getEntry(old.entry.id)).state, 'superseded')
      assert.equal((await storage.getEntry(old.entry.id)).content, 'API 使用 A。')
      const provenance = (await storage.getEntry(next.entry.id)).relations[0]
      assert.equal(provenance.previous_evidence.messages[0].text, old.message)
      assert.equal(provenance.current_evidence.messages[0].text, next.message)
      const search = { space_id: execution.space.id, vector: [1, 0], scope: { kind: 'project' as const, project_ids: ['revision-project'] } }
      assert.deepEqual((await storage.search(search)).entries.map(entry => entry.id), [next.entry.id])
      assert.equal((await storage.search({ ...search, include_history: true })).entries.length, 2)

      const extra = await make('rev-extra', 'API B 超时为 30 秒。', '补充：API B 的超时为 30 秒。')
      await storage.index({ ...await vectors(extra.id), relations: [relation('supplement', next.entry.id, extra)] })
      assert.equal((await storage.getEntry(next.entry.id)).state, 'active')
      assert.equal((await storage.getEntry(extra.entry.id)).state, 'active')
      assert((await storage.getEntry(next.entry.id)).relations.some(row => row.kind === 'supplement' && row.current_entry_id === extra.entry.id))

      const disputed = await make('rev-dispute', 'API 使用 C。', '另一份资料说 API 使用 C，目前无法确定 B、C 哪个正确。')
      await storage.index({ ...await vectors(disputed.id), relations: [relation('conflict', next.entry.id, disputed)] })
      assert.equal((await storage.getEntry(next.entry.id)).state, 'conflicted')
      assert.equal((await storage.getEntry(disputed.entry.id)).state, 'conflicted')
      const updated = await make('rev-update', 'API 使用 D。', '更正之前 B 的说法：应当使用 D。')
      await storage.index({ ...await vectors(updated.id), relations: [relation('correction', next.entry.id, updated)] })
      assert.equal((await storage.getEntry(updated.entry.id)).state, 'conflicted', 'unresolved C must not disappear after B changes')
      assert.equal((await storage.getEntry(disputed.entry.id)).state, 'conflicted')
      const resolved = await make('rev-resolved', 'API 使用 E。', '明确裁决：C 和 D 都不正确，现在 API 统一使用 E。')
      await storage.index({ ...await vectors(resolved.id), relations: [relation('correction', updated.entry.id, resolved), relation('correction', disputed.entry.id, resolved)] })
      assert.equal((await storage.getEntry(resolved.entry.id)).state, 'active')
      assert.equal((await storage.getEntry(updated.entry.id)).state, 'superseded')
      assert.equal((await storage.getEntry(disputed.entry.id)).state, 'superseded')

      const conflictSource: Submission = {
        ...source('rev-evidence'), scope: { project_ids: ['revision-project'], business_ids: [] },
        messages: [{ message_id: 'u1', role: 'user', text: '资料一说 E，资料二说 F，尚无法确认。' }],
      }
      await storage.store({ submission: conflictSource, run, extraction: { schema_version: 1, memories: [], proposals: [], revisions: [{
        kind: 'conflict', earlier_content: 'API 使用 E。', later_content: 'API 使用 F。', explanation: '两份资料冲突', source_message_ids: ['u1'],
      }] } })
      const conflictReceipt = await storage.index({ ...await vectors('rev-evidence'), relations: [relationSchema.parse({
        kind: 'conflict', previous_entry_id: resolved.entry.id, current_entry_id: null, revision_index: 0,
        explanation: '缺乏裁决', source_message_ids: ['u1'], evidence_quote: conflictSource.messages[0].text,
      })] })
      assert.equal(conflictReceipt.status, 'indexed')
      assert.equal(conflictReceipt.entry_count, 0)
      assert.equal((await storage.getEntry(resolved.entry.id)).state, 'conflicted')
      const evidence = await storage.getSubmission('rev-evidence')
      assert.equal(evidence.relations.length, 1)
      assert.equal(evidence.relations[0].revision?.later_content, 'API 使用 F。')
      const final = await make('rev-final', 'API 使用 G。', '明确更正：E 和 F 都是错误信息，API 只使用 G。')
      await storage.index({ ...await vectors(final.id), relations: [{
        ...relation('correction', resolved.entry.id, final), resolved_revision_conflict_ids: [evidence.relations[0].id],
      }] })
      assert.equal((await storage.getEntry(final.entry.id)).state, 'active')

      const foreign = await make('rev-foreign', '另一项目使用 H。', '更正为 H。', 'another-project')
      await assert.rejects(storage.index({ ...await vectors(foreign.id), relations: [relation('correction', final.entry.id, foreign)] }), /跨越/)
      assert.equal((await storage.getEntry(final.entry.id)).state, 'active')
      assert.equal((await storage.getEntry(foreign.entry.id)).state, 'pending')
    })

    await t.test('source time and reception order prevent stale retries from superseding current facts', async () => {
      const make = async (id: string, text: string, at?: string) => {
        const submission: Submission = { ...source(id), scope: { project_ids: ['time-test'], business_ids: [] },
          messages: [{ message_id: 'u1', role: 'user', text, ...(at ? { occurred_at: at } : {}) }] }
        await storage.store({ submission, run, extraction: { schema_version: 1,
          memories: [{ content: text, scope: 'project', basis: 'user_statement', source_message_ids: ['u1'], entities: [], valid_from: null, valid_until: null, time_evidence: null }], proposals: [], revisions: [] } })
        return (await storage.getSubmission(id)).entries[0]
      }
      const current = await make('dated-current', 'API 使用 A。', '2026-01-10T00:00:00Z')
      await storage.index(await vectors(current.submission_id))
      const old = await make('dated-late', '明确更正：API 应使用 B。', '2026-01-05T00:00:00Z')
      const planned = relationSchema.parse({ kind: 'correction', previous_entry_id: current.id, current_entry_id: old.id,
        revision_index: null, explanation: '用户原文更正', source_message_ids: ['u1'], evidence_quote: old.content })
      const receipt = await storage.index({ ...await vectors(old.submission_id), relations: [planned] })
      assert.equal(receipt.status, 'review_required')
      assert.equal(receipt.relation_count, 0)
      assert.match(receipt.publication_notes[0].reason, /早于/)
      assert.equal((await storage.getEntry(current.id)).state, 'active')
      assert.equal((await storage.getEntry(old.id)).claim_status, 'candidate')
      const query = { space_id: execution.space.id, vector: [1, 0], scope: { kind: 'project' as const, project_ids: ['time-test'] } }
      assert.deepEqual((await storage.search(query)).entries.map(entry => entry.id), [current.id])
      assert.equal((await storage.search({ ...query, include_candidates: true })).entries.length, 2)
      await manageEntry(pool, { action: 'approve', entry_id: old.id, reason: '测试：人工确认候选，但不自动执行旧更正计划', evidence_ref: 'test:dated-evidence' })
      assert.equal((await storage.getEntry(old.id)).claim_status, 'verified')
      assert.equal((await storage.getEntry(current.id)).state, 'conflicted')
      assert.equal((await storage.getEntry(old.id)).state, 'conflicted')
      await manageEntry(pool, { action: 'reject', entry_id: old.id, reason: '测试：拒绝补录旧信息' })
      assert.equal((await storage.getEntry(current.id)).state, 'active')
      assert.equal((await storage.search(query)).entries.length, 1)

      const pending = await make('retry-older', '更正：应采用较早任务的 C。')
      const later = await make('retry-newer', '当前明确采用 D。')
      await pool.query("UPDATE jt_memo.submissions SET received_at='2026-01-01T00:00:00Z' WHERE id='retry-older'")
      await pool.query("UPDATE jt_memo.submissions SET received_at='2026-01-02T00:00:00Z' WHERE id='retry-newer'")
      await assert.rejects(storage.getEntry(pending.id, '2026-02-01T00:00:00Z'), /不存在/)
      await assert.rejects(storage.getSubmission(pending.submission_id, '2026-02-01T00:00:00Z'), /不存在/)
      await storage.index(await vectors(later.submission_id))
      const lateRetry = await storage.index({ ...await vectors(pending.submission_id), relations: [relationSchema.parse({
        ...planned, previous_entry_id: later.id, current_entry_id: pending.id, evidence_quote: pending.content,
      })] })
      assert.match(lateRetry.publication_notes[0].reason, /较早接收/)
      assert.equal((await storage.getEntry(later.id)).state, 'active')
    })

    await t.test('validity windows, candidate decisions and reversible archive have auditable historical views', async () => {
      const submission: Submission = { ...source('management'), source: { provider: 'codex', session_id: 'archive-test-session' },
        scope: { project_ids: ['management-test'], business_ids: [] },
        messages: [
          { message_id: 'u1', role: 'user', text: '项目正常使用 API；临时任务完成后可以归档。future-service 有效期从 2100-01-01T00:00:00Z 至 2100-02-01T00:00:00Z。', occurred_at: '2026-01-01T00:00:00Z' },
          { message_id: 'a1', role: 'assistant', text: '建议采用 local-cache。', occurred_at: '2026-01-01T00:00:01Z' },
        ] }
      await storage.store({ submission, run, extraction: { schema_version: 1,
        memories: [
          { content: 'future-service 在指定日期生效。', basis: 'user_statement', scope: 'project', source_message_ids: ['u1'], entities: ['future-service'],
            valid_from: '2100-01-01T00:00:00Z', valid_until: '2100-02-01T00:00:00Z', time_evidence: { source_message_id: 'u1', quote: '2100-01-01T00:00:00Z 至 2100-02-01T00:00:00Z' } },
          { content: '本次临时任务。', basis: 'user_statement', scope: 'current_task', source_message_ids: ['u1'] },
          { content: '项目正常使用 API。', basis: 'user_statement', scope: 'project', source_message_ids: ['u1'] },
        ], proposals: [{ content: '建议采用 local-cache。', basis: 'assistant_proposal', scope: 'project', source_message_ids: ['a1'], entities: ['local-cache'] }], revisions: [] } })
      await storage.index(await vectors('management'))
      const [scheduled, task, stable, candidate] = (await storage.getSubmission('management')).entries
      assert.equal(scheduled.state, 'scheduled')
      assert.equal((await storage.getEntry(scheduled.id, '2100-01-02T00:00:00Z')).state, 'active')
      assert.equal((await storage.getEntry(scheduled.id, '2100-03-01T00:00:00Z')).state, 'expired')
      await assert.rejects(storage.getEntry(scheduled.id, '2000-01-01T00:00:00Z'), /不存在/)
      assert.equal(candidate.claim_status, 'candidate')
      assert((await listManagedEntries(pool, 'candidates', 100)).entries.some(entry => entry.id === candidate.id))
      await assert.rejects(manageEntry(pool, { action: 'approve', entry_id: candidate.id, reason: '没有证据' }), /evidence/)
      await manageEntry(pool, { action: 'approve', entry_id: candidate.id, reason: '确认该建议用于此验证项目', evidence_ref: 'test:manual-approval' })
      assert.equal((await storage.getEntry(candidate.id)).claim_status, 'verified')
      assert.equal((await storage.getEntry(candidate.id)).basis, 'assistant_proposal', 'approval never rewrites original provenance')
      const query = { space_id: execution.space.id, vector: [1, 0], scope: { kind: 'project' as const, project_ids: ['management-test'] } }
      assert((await storage.search(query)).entries.some(entry => entry.id === candidate.id))
      const before = (await pool.query<{ at: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at
      const archive = await manageEntry(pool, { action: 'archive', source_session_id: 'archive-test-session', reason: '验证任务已结束' })
      assert.equal(archive.changed, 1)
      assert.equal((await storage.getEntry(task.id)).archived, true)
      assert.equal((await storage.getEntry(stable.id)).archived, false)
      assert.equal((await storage.getEntry(task.id, before)).archived, false)
      assert.equal((await manageEntry(pool, { action: 'archive', entry_id: task.id, reason: '重复归档' })).changed, 0)
      await manageEntry(pool, { action: 'restore', entry_id: task.id, reason: '继续验证' })
      assert.equal((await storage.getEntry(task.id)).archived, false)
      assert.deepEqual((await storage.getEntry(task.id)).actions.map(row => row.action), ['restore', 'archive'])
      const stats = await storageStats(pool)
      assert(stats.tables.some(table => table.name === 'entry_actions'))
      assert(stats.counts.actions >= 3)
    })

    await t.test('doctor validates a read-only snapshot and detects independent corruption', async () => {
      const healthy = await storageDoctor(pool)
      assert.equal(healthy.ok, true, JSON.stringify(healthy.issues))
      assert.equal(healthy.mode, 'read_only')
      const entry = (await storage.getSubmission('management')).entries[0]
      try {
        await pool.query('UPDATE jt_memo.entries SET content=$2 WHERE id=$1', [entry.id, 'corrupted content'])
        const broken = await storageDoctor(pool)
        assert.equal(broken.ok, false)
        assert(broken.issues.some(issue => issue.record === entry.id && issue.check === 'entry_source'))
      } finally { await pool.query('UPDATE jt_memo.entries SET content=$2 WHERE id=$1', [entry.id, entry.content]) }
      assert.equal((await storageDoctor(pool)).ok, true)
    })

    await t.test('built CLI validates arguments and durably returns while a worker is blocked', async () => {
      const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), 'memo', ...args, '--env-file', envFile])).stdout)
      assert.equal((await cli('status', 'batch')).status, 'complete')
      assert.equal((await cli('read', '--submission', 'batch')).extraction.revisions.length, 1)
      assert.equal((await cli('doctor')).ok, true)
      assert((await cli('stats')).counts.entries > 0)
      assert((await cli('review', 'list')).total > 0)
      await assert.rejects(cli('search', 'query'), /必须明确指定/)
      const inputPath = resolve(directory, 'cli-source.json')
      await writeFile(inputPath, JSON.stringify(source('cli-batch')))
      await storage.store({ submission: source('cli-batch'), extraction: { schema_version: 1, memories: [], proposals: [], revisions: [] }, run })
      await storage.index(await vectors('cli-batch'))
      const lock = await pool.connect()
      await lock.query("SELECT pg_advisory_lock(hashtextextended('jt_memo:worker', 0))")
      const start = performance.now()
      const receipt = await cli('send', inputPath, '--legacy')
      assert.equal(receipt.status, 'queued')
      assert.equal(receipt.worker.started, true)
      assert(performance.now() - start < 5000, 'send must not wait for extraction or worker lock')
      await lock.query("SELECT pg_advisory_unlock(hashtextextended('jt_memo:worker', 0))")
      lock.release()
      // Waiting for the same advisory lock drains anything not claimed by the detached worker.
      await runWorker(pool, root)
      assert.equal((await cli('status', 'cli-batch')).status, 'complete')
      assert.equal((await cli('send', inputPath, '--legacy')).duplicate, true)
    })

  } finally {
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  }
})
