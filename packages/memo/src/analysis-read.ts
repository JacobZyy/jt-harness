import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { transaction } from './storage/database.ts'
import { entrySnapshot } from './storage/metadata.ts'

export interface MemoAnalysisRow {
  sessionId: string
  kind: string
  id: string
  occurredAt: string
  value: Record<string, unknown>
}

/** Freeze only selected sessions in a read-only transaction. Never migrate or start a worker. */
export async function readMemoAnalysis(database: Pool | PoolClient, sessionIds: string[], cutoff: string) {
  z.array(z.string().min(1)).min(1).parse(sessionIds)
  z.iso.datetime({ offset: true }).parse(cutoff)
  return transaction(database, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const rows: MemoAnalysisRow[] = []
    for (const sessionId of [...new Set(sessionIds)]) {
      const params = [sessionId, cutoff]
      const receipts = await client.query(`SELECT id,draft,evidence,result,received_at FROM jt_memo.declaration_receipts
        WHERE evidence#>>'{submission,source,session_id}'=$1 AND received_at<=$2::timestamptz ORDER BY received_at,id`, params)
      const submissions = await client.query(`SELECT id,source,extraction,extraction_run,stored_at,received_at,intake_issues FROM jt_memo.submissions
        WHERE source#>>'{source,session_id}'=$1 AND stored_at<=$2::timestamptz ORDER BY stored_at,id`, params)
      const entryIds = await client.query<{ id: string }>(`SELECT id::text FROM jt_memo.entries WHERE source_session_id=$1
        UNION SELECT ds.entry_id::text FROM jt_memo.declaration_sources ds JOIN jt_memo.declaration_receipts r ON r.id=ds.declaration_id
          WHERE r.evidence#>>'{submission,source,session_id}'=$1 AND r.received_at<=$2::timestamptz
        UNION SELECT u.entry_id::text FROM jt_memo.memory_uses u JOIN jt_memo.declaration_receipts r ON r.id=u.declaration_id
          WHERE r.evidence#>>'{submission,source,session_id}'=$1 AND u.reported_at<=$2::timestamptz`, params)
      const entries = await client.query(`WITH snapshot AS (${entrySnapshot('$2')})
        SELECT * FROM snapshot WHERE id=ANY($1::uuid[]) ORDER BY received_at,id`, [entryIds.rows.map(row => row.id), cutoff])
      const commits = await client.query(`SELECT c.* FROM jt_memo.index_commits c JOIN jt_memo.submissions s ON s.id=c.submission_id
        WHERE s.source#>>'{source,session_id}'=$1 AND c.indexed_at<=$2::timestamptz ORDER BY c.indexed_at,c.id`, params)
      const jobs = await client.query(`SELECT id,kind,created_at,
        CASE WHEN updated_at<=$2::timestamptz THEN status ELSE NULL END AS status,
        CASE WHEN updated_at<=$2::timestamptz THEN attempts ELSE NULL END AS attempts,
        CASE WHEN updated_at<=$2::timestamptz THEN error ELSE NULL END AS error,
        CASE WHEN updated_at<=$2::timestamptz THEN updated_at ELSE NULL END AS updated_at,
        updated_at>$2::timestamptz AS later_state_unavailable
        FROM jt_memo.jobs WHERE payload#>>'{source,session_id}'=$1 AND created_at<=$2::timestamptz ORDER BY created_at,id`, params)
      const uses = await client.query(`SELECT u.* FROM jt_memo.memory_uses u JOIN jt_memo.declaration_receipts r ON r.id=u.declaration_id
        WHERE r.evidence#>>'{submission,source,session_id}'=$1 AND u.reported_at<=$2::timestamptz ORDER BY u.reported_at,u.entry_id`, params)
      const append = (kind: string, result: { rows: Record<string, unknown>[] }, time: string) => {
        for (const value of result.rows) rows.push({ sessionId, kind, id: String(value.id ?? `${value.declaration_id}:${value.entry_id}`),
          occurredAt: new Date(String(value[time])).toISOString(), value })
      }
      append('declaration_receipt', receipts, 'received_at')
      append('submission', submissions, 'stored_at')
      append('entry', entries, 'received_at')
      append('index_commit', commits, 'indexed_at')
      append('job', jobs, 'created_at')
      append('reported_use', uses, 'reported_at')
    }
    return rows
  })
}
