import type { Pool, PoolClient } from 'pg'
import { optionsSchema, submissionSchema } from '../contracts.ts'
import type { Submission } from '../contracts.ts'
import type { ExecutionProfile } from '../config.ts'
import { MemoStorageError, sha256 } from './contract.ts'
import { transaction } from './database.ts'

export interface Job {
  id: string
  payload: Submission
  execution: ExecutionProfile
}

/** A returned receipt means PostgreSQL committed the source, not that extraction finished. */
export async function enqueue(pool: Pool | PoolClient, input: unknown, execution: ExecutionProfile) {
  const payload = submissionSchema.parse(input)
  const hash = sha256(JSON.stringify(payload))
  return transaction(pool, async client => {
    const inserted = await client.query(`
      INSERT INTO jt_memo.jobs (id, content_hash, payload, execution) VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO NOTHING RETURNING id
    `, [payload.submission_id, hash, payload, execution])
    const existing = await client.query<{ content_hash: string, status: string }>('SELECT content_hash, status FROM jt_memo.jobs WHERE id = $1', [payload.submission_id])
    if (existing.rows[0].content_hash !== hash) throw new MemoStorageError('SUBMISSION_CONFLICT', '同一 submission_id 已接收不同材料；请保留原批次并为新增材料使用新 ID')
    return { submission_id: payload.submission_id, status: existing.rows[0].status, duplicate: inserted.rowCount === 0 }
  })
}

export async function jobStatus(database: Pool | PoolClient, id?: string) {
  const jobs = await database.query(`
    SELECT j.id AS submission_id, j.kind, j.status, j.attempts, j.error, j.created_at, j.updated_at,
      j.execution->'agent' AS agent, j.execution->'space' AS embedding_space,
      s.stored_at, s.extraction_run AS extraction_run,
      CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_array_length(s.extraction->'revisions') END AS revision_evidence_count,
      c.id AS index_receipt_id, c.entry_count, c.indexed_at,
      jsonb_array_length(c.relation_decisions)-jsonb_array_length(c.publication_notes) AS relation_count,
      c.reconciliation_run,c.publication_notes,
      (SELECT count(*)::int FROM jt_memo.entry_states e WHERE e.submission_id=j.id AND e.claim_status='candidate') AS candidate_count
    FROM jt_memo.jobs j LEFT JOIN jt_memo.submissions s ON s.id = j.id
    LEFT JOIN jt_memo.index_commits c ON c.submission_id = j.id AND c.space_id = j.execution->'space'->>'id'
    WHERE ($1::text IS NULL OR j.id = $1)
    ORDER BY j.created_at DESC, j.id LIMIT 20
  `, [id ?? null])
  if (id) {
    if (!jobs.rows[0]) throw new MemoStorageError('NOT_FOUND', '记忆任务不存在')
    return jobs.rows[0]
  }
  const counts = await database.query<{ status: string, count: number }>('SELECT status, count(*)::int AS count FROM jt_memo.jobs GROUP BY status ORDER BY status')
  const kinds = await database.query<{ kind: string, status: string, count: number }>('SELECT kind,status,count(*)::int AS count FROM jt_memo.jobs GROUP BY kind,status')
  const failures = await database.query<{ error: string, count: number }>("SELECT error,count(*)::int AS count FROM jt_memo.jobs WHERE status='failed' GROUP BY error ORDER BY count(*) DESC")
  return { counts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])),
    execution: { dsh: 'sdk-subprocess', web_required: false }, failures: failures.rows,
    index_counts: Object.fromEntries(kinds.rows.filter(row => row.kind === 'index').map(row => [row.status, row.count])),
    legacy_counts: Object.fromEntries(kinds.rows.filter(row => row.kind === 'legacy').map(row => [row.status, row.count])), recent: jobs.rows }
}

export async function retryJob(pool: Pool, id: string, timeoutMs?: number) {
  const budget = timeoutMs === undefined ? null : optionsSchema.shape.timeoutMs.parse(timeoutMs)
  const result = await pool.query(`
    UPDATE jt_memo.jobs SET status = 'queued', error = NULL, updated_at = CURRENT_TIMESTAMP,
      execution = CASE WHEN $2::int IS NULL THEN execution
        ELSE jsonb_set(execution, '{agent,timeoutMs}', to_jsonb($2::int)) END
    WHERE id = $1 AND status = 'failed' AND ($2::int IS NULL OR kind='legacy') RETURNING id
  `, [id, budget])
  if (!result.rowCount) throw new Error('只能 retry 已失败的任务；--timeout-ms 仅用于 legacy；queued/running 用 memo work 恢复，complete 无需重试')
  return { submission_id: id, status: 'queued', ...(budget === null ? {} : { timeoutMs: budget }) }
}
