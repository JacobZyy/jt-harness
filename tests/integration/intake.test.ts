import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { z } from 'zod'
import { prepareDatabase, loadConfig, executionProfile, enqueue, jobStatus, MemoStorage, readAgentOutputs, retryJob } from '@jt-harness/memo'
import type { Submission } from '@jt-harness/memo/contracts'
import { processJob, runLegacyWorker } from '@jt-harness/memo/legacy'
import type { extractMemories } from '@jt-harness/memo/legacy'
import { inspectExtraction } from '../../packages/memo/src/intake.ts'
import { inspectRelations } from '../../packages/memo/src/agents/reconcile.ts'
import { runValidatedMemoryAgent } from '../../packages/memo/src/agents/runtime.ts'

const execute = promisify(execFile), root = process.cwd()
test('partial intake publishes independent memories and preserves rejected and undecodable model responses', { skip: !process.env.JTH_TEST_DATABASE_URL }, async t => {
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL }), storage = new MemoStorage(pool)
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'jth_test')
  await pool.query('DROP SCHEMA IF EXISTS jt_memo CASCADE')
  await prepareDatabase(pool, true)
  const directory = await mkdtemp('/tmp/jth-intake-test-'), envFile = resolve(directory, '.env')
  await writeFile(envFile, `JTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=intake-test\nEMBEDDING_DIMENSIONS=2\nEMBEDDING_API_KEY=placeholder\nJTH_DATA_DIR=${directory}\n`)
  const config = await loadConfig(root, envFile, {}), execution = executionProfile(config)
  const source = (prefix: string): Submission => ({ schema_version: 1, submission_id: `${prefix}-${randomUUID()}`,
    source: { provider: 'codex', session_id: prefix }, scope: { project_ids: [prefix], business_ids: [] },
    messages: [{ message_id: 'm', role: 'assistant', text: 'PG 使用 B 替代 A；新事实 E、Z。', context_only: true }],
  })
  const fact = (content: string) => ({ content, basis: 'user_confirmed' as const, scope: 'project' as const, source_message_ids: ['m'], entities: ['PostgreSQL'] })
  const api = t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'intake-test', data: [{ index: 0, embedding: [1, 0] }] }))
  const outputRun = () => ({ session_id: randomUUID(), provider: 'test', model: 'test' })
  const model = (response: string): typeof extractMemories => async (input, runtime, context) => {
    const submission = input as Submission
    const parsed = await runValidatedMemoryAgent(submission, runtime, new URL('../../packages/memo/src/agents/agent.md', import.meta.url), z.object({}),
      value => inspectExtraction(value, submission), context, async () => ({ response, run: outputRun() }))
    return { status: 'extracted', submission_id: submission.submission_id, source: submission.source, scope: submission.scope,
      run: parsed.run, ...parsed.value.extraction, issues: parsed.value.issues }
  }
  try {
    await t.test('v4 upgrade preserves source, facts, hashes and vectors without replaying models', async () => {
      const submission = source('intake-migration')
      submission.messages = [{ message_id: 'm', role: 'user', text: 'PG 保存现有事实。' }]
      await enqueue(pool, submission, execution)
      await storage.store({ submission, extraction: { schema_version: 1,
        memories: [{ ...fact('PG 保存现有事实。'), basis: 'user_statement', entities: ['PG'] }], proposals: [], revisions: [] }, run: outputRun() })
      const entries = (await storage.getSubmission(submission.submission_id)).entries
      await storage.index({ submission_id: submission.submission_id, space: execution.space,
        embeddings: entries.map(entry => ({ entry_id: entry.id, content_sha256: entry.content_sha256, vector: [1, 0] })) })
      await pool.query("UPDATE jt_memo.jobs SET status='complete' WHERE id=$1", [submission.submission_id])
      const snapshot = async () => (await pool.query(`SELECT s.content_hash,s.source,s.extraction,e.id,e.content,e.content_sha256,v.embedding::text,c.vector_hash
        FROM jt_memo.submissions s JOIN jt_memo.entries e ON e.submission_id=s.id
        JOIN jt_memo.embeddings v ON v.entry_id=e.id JOIN jt_memo.index_commits c ON c.submission_id=s.id WHERE s.id=$1`, [submission.submission_id])).rows
      const before = await snapshot()
      await pool.query(`DROP TABLE jt_memo.agent_outputs;
        ALTER TABLE jt_memo.submissions DROP COLUMN intake_issues;
        ALTER TABLE jt_memo.index_commits DROP COLUMN intake_issues;
        ALTER TABLE jt_memo.jobs DROP CONSTRAINT jobs_status_check;
        ALTER TABLE jt_memo.jobs ADD CONSTRAINT jobs_status_check CHECK(status IN ('queued','running','complete','failed'));
        UPDATE jt_memo.schema_version SET version=4;`)
      await assert.rejects(prepareDatabase(pool, false), /v5/)
      await prepareDatabase(pool, true)
      assert.deepEqual(await snapshot(), before)
      assert.deepEqual((await storage.getSubmission(submission.submission_id)).intake_issues, [])
      assert.equal((await readAgentOutputs(pool, submission.submission_id)).length, 0)
    })

    await t.test('a malformed item does not discard good items; index retry keeps the exact first extraction', async () => {
      const submission = source('partial-intake')
      const bad = { ...fact('引用待修正'), source_message_ids: ['invented'] }
      const raw = JSON.stringify({ schema_version: 1, memories: [fact('B'), bad, { ...fact('Z'), kind_note: '辅助字段' }], proposals: [], revisions: [] })
      await enqueue(pool, submission, execution)
      const client = await pool.connect()
      try {
        api.mock.mockImplementationOnce(async () => Response.json({}, { status: 503 }))
        await assert.rejects(processJob(client, { id: submission.submission_id, payload: submission, execution }, config, undefined, model(raw)), /HTTP 503/)
        const receipt = await processJob(client, { id: submission.submission_id, payload: submission, execution }, config, undefined,
          async () => { throw new Error('must not regenerate accepted extraction') })
        assert.equal(receipt.status, 'partial')
        assert.equal(receipt.entry_count, 2)
        assert.deepEqual(receipt.intake_issues[0].value, bad)
      } finally { client.release() }
      const saved = await storage.getSubmission(submission.submission_id)
      assert.deepEqual(saved.entries.map(entry => entry.content), ['B', 'Z'])
      const found = await storage.search({ space_id: execution.space.id, vector: [1, 0], scope: { kind: 'project', project_ids: submission.scope.project_ids } })
      assert.equal(found.entries.length, 2)
      assert.equal((await readAgentOutputs(pool, submission.submission_id))[0].response, raw)
      const queued = await pool.query("SELECT id FROM jt_memo.jobs WHERE status IN ('queued','running')")
      assert.deepEqual(queued.rows.map(row => row.id), [submission.submission_id], 'The real worker must not encounter unrelated unstubbed model work')
      assert.equal((await runLegacyWorker(pool, root)).partial, 1)
      const status = await jobStatus(pool, submission.submission_id)
      assert.equal(status.status, 'partial')
      assert.equal(status.issue_count, 1)
      assert.equal(status.output_count, 1)
      await assert.rejects(retryJob(pool, submission.submission_id), /partial/)
    })

    await t.test('bad relations do not change old facts or block independent new memories', async () => {
      const original = source('partial-relations'), incoming = source('partial-relations')
      const stored = await storage.store({ submission: original, extraction: { schema_version: 1, memories: [fact('A')], proposals: [], revisions: [] }, run: outputRun() })
      const old = (await storage.getSubmission(original.submission_id)).entries[0]
      await storage.index({ submission_id: original.submission_id, space: execution.space, embeddings: [{ entry_id: stored.entry_ids[0], content_sha256: old.content_sha256, vector: [1, 0] }] })
      await enqueue(pool, incoming, execution)
      const raw = JSON.stringify({ schema_version: 1, memories: [fact('B'), fact('E'), fact('Z')], proposals: [], revisions: [] })
      const client = await pool.connect()
      try {
        const receipt = await processJob(client, { id: incoming.submission_id, payload: incoming, execution }, config, undefined, model(raw), async (input, runtime, context) => {
          const current = input.current_entries
          const broken = { kind: 'correction', previous_entry_id: old.id, current_entry_id: current[1].id, revision_index: null,
            explanation: '错误引用', source_message_ids: ['m'], evidence_quote: '不在原文的引文' }
          const result = await runValidatedMemoryAgent(input, runtime, new URL('../../packages/memo/src/agents/reconcile.md', import.meta.url), z.object({}),
            response => inspectRelations(response, input), context, async () => ({ response: JSON.stringify({ relations: [broken] }), run: outputRun() }))
          return { ...result.value, run: result.run }
        })
        assert.equal(receipt.status, 'partial')
        assert.equal(receipt.entry_count, 3)
        assert.equal(receipt.relation_count, 0)
        assert.equal(receipt.intake_issues.length, 1)
      } finally { client.release() }
      await pool.query("UPDATE jt_memo.jobs SET status='partial' WHERE id=$1", [incoming.submission_id])
      assert.equal((await storage.getEntry(old.id)).state, 'active')
      const saved = await storage.getSubmission(incoming.submission_id)
      assert.equal(saved.entries.find(entry => entry.content === 'E')!.claim_status, 'candidate')
      const found = await storage.search({ space_id: execution.space.id, vector: [1, 0], scope: { kind: 'project', project_ids: incoming.scope.project_ids } })
      assert(found.entries.some(entry => entry.content === 'B') && found.entries.some(entry => entry.content === 'Z'))
      assert(!found.entries.some(entry => entry.content === 'E'))
      assert.equal((await readAgentOutputs(pool, incoming.submission_id)).length, 2)
    })

    await t.test('unparseable JSON and its repair attempt are both retained and readable through the CLI', async () => {
      const submission = source('invalid-json'), raw = '{"memories":["有价值但不完整的输出"'
      await enqueue(pool, submission, execution)
      const client = await pool.connect()
      try { await assert.rejects(processJob(client, { id: submission.submission_id, payload: submission, execution }, config, undefined, model(raw)), SyntaxError) }
      finally { client.release() }
      await pool.query("UPDATE jt_memo.jobs SET status='failed',error='invalid JSON fixture' WHERE id=$1", [submission.submission_id])
      const outputs = await readAgentOutputs(pool, submission.submission_id)
      assert.equal(outputs.length, 2)
      assert(outputs.every(output => output.response === raw && output.validation_error))
      await assert.rejects(storage.getSubmission(submission.submission_id), /不存在/)
      const result = await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), 'memo', 'outputs', submission.submission_id, '--env-file', envFile])
      assert.equal(JSON.parse(result.stdout).outputs.length, 2)
    })
  } finally { await pool.end(); await rm(directory, { recursive: true, force: true }) }
})
