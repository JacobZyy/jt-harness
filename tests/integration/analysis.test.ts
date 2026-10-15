import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { MemoStorage, prepareDatabase, readMemoAnalysis } from '@jt-harness/memo'
import type { Submission } from '@jt-harness/memo/contracts'

test('analysis reads only selected historical Memo results and does not migrate or alter queue state', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
  const key = randomUUID(), selected = `analysis-selected-${key}`, unrelated = `analysis-unrelated-${key}`
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'jth_test')
    await prepareDatabase(pool, true)
    const storage = new MemoStorage(pool), now = Date.now(), cutoff = new Date(now).toISOString(), before = new Date(now - 60_000).toISOString()
    const source = (sessionId: string): Submission => ({ schema_version: 1, submission_id: sessionId,
      source: { provider: 'codex', session_id: sessionId }, scope: { project_ids: [key], business_ids: [] },
      messages: [{ message_id: 'u', role: 'user', text: '项目长期使用 pnpm。', occurred_at: before }] })
    for (const sessionId of [selected, unrelated]) {
      await storage.store({ submission: source(sessionId), extraction: { schema_version: 1,
        memories: [{ content: '项目长期使用 pnpm。', scope: 'project', basis: 'user_statement', source_message_ids: ['u'] }], proposals: [], revisions: [] },
        run: { session_id: sessionId, provider: 'fixture', model: 'fixture' } })
      await pool.query('UPDATE jt_memo.submissions SET stored_at=$2,received_at=$2 WHERE id=$1', [sessionId, before])
      await pool.query("INSERT INTO jt_memo.jobs(id,content_hash,payload,execution,kind,status,created_at,updated_at) VALUES($1,'fixture',$2,'{}','index','complete',$3,$4)",
        [sessionId, source(sessionId), before, new Date(now + 60_000).toISOString()])
    }
    const queueBefore = (await pool.query('SELECT id,status,attempts FROM jt_memo.jobs WHERE id=ANY($1::text[]) ORDER BY id', [[selected, unrelated]])).rows
    const result = await readMemoAnalysis(pool, [selected], cutoff)
    assert(result.length >= 3)
    assert(result.every(row => row.sessionId === selected))
    assert(result.some(row => row.kind === 'entry' && row.value.content === '项目长期使用 pnpm。'))
    const job = result.find(row => row.kind === 'job')!
    assert.equal(job.value.status, null)
    assert.equal(job.value.later_state_unavailable, true)
    assert(!JSON.stringify(result).includes(unrelated))
    assert.deepEqual((await pool.query('SELECT id,status,attempts FROM jt_memo.jobs WHERE id=ANY($1::text[]) ORDER BY id', [[selected, unrelated]])).rows, queueBefore)
    assert.deepEqual(await readMemoAnalysis(pool, [selected], new Date(now - 120_000).toISOString()), [])
  } finally {
    try {
      await pool.query('DELETE FROM jt_memo.jobs WHERE id=ANY($1::text[])', [[selected, unrelated]])
      await pool.query('DELETE FROM jt_memo.entries WHERE submission_id=ANY($1::text[])', [[selected, unrelated]])
      await pool.query('DELETE FROM jt_memo.submissions WHERE id=ANY($1::text[])', [[selected, unrelated]])
    } finally { await pool.end() }
  }
})
