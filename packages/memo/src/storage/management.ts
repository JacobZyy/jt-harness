import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { transaction } from './database.ts'
import type { StateEntry } from './relations.ts'

const note = z.string().trim().min(1).max(2000)
export const actionSchema = z.strictObject({
  action: z.enum(['approve', 'reject', 'archive', 'restore']),
  entry_id: z.uuid().optional(),
  source_session_id: z.string().trim().min(1).max(200).optional(),
  reason: note,
  evidence_ref: note.optional(),
}).superRefine((input, context) => {
  if (Boolean(input.entry_id) === Boolean(input.source_session_id)) context.addIssue({ code: 'custom', message: '必须选择一个条目 ID 或一个会话 ID' })
  if (input.source_session_id && input.action !== 'archive') context.addIssue({ code: 'custom', message: '只有 archive 支持按会话批量操作' })
  if (input.action === 'approve' && !input.evidence_ref) context.addIssue({ code: 'custom', message: '确认候选必须提供 --evidence 依据引用' })
})

/** Review and archive are separate append-only decisions; neither rewrites facts or revisions. */
export async function manageEntry(database: Pool, input: z.input<typeof actionSchema>) {
  const action = actionSchema.parse(input)
  return transaction(database, async client => {
    const selected = await client.query<{ id: string }>(`
      SELECT id FROM jt_memo.entries WHERE ($1::uuid IS NOT NULL AND id=$1)
        OR ($2::text IS NOT NULL AND scope='current_task' AND source_session_id=$2)
      ORDER BY id FOR UPDATE
    `, [action.entry_id ?? null, action.source_session_id ?? null])
    if (selected.rows.length === 0) throw new Error('没有匹配的记忆；按会话归档仅匹配 current_task 条目')
    const entries = await client.query<StateEntry>('SELECT * FROM jt_memo.entry_states WHERE id=ANY($1::uuid[])', [selected.rows.map(row => row.id)])
    if (entries.rows.some(entry => entry.state === 'pending')) throw new Error('条目尚未完成向量入库，请等待任务处理完成')
    const receipts = []
    for (const entry of entries.rows) {
      if ((action.action === 'archive' && entry.archived) || (action.action === 'restore' && !entry.archived)) continue
      const receipt = await client.query(`
        INSERT INTO jt_memo.entry_actions(id,entry_id,action,origin,reason,evidence_ref)
        VALUES ($1,$2,$3,'local_cli',$4,$5) RETURNING id,entry_id,action,actor,reason,evidence_ref,acted_at
      `, [randomUUID(), entry.id, action.action, action.reason, action.evidence_ref ?? null])
      receipts.push(receipt.rows[0])
    }
    const states = await client.query('SELECT id,state,claim_status,archived FROM jt_memo.entry_states WHERE id=ANY($1::uuid[]) ORDER BY id', [selected.rows.map(row => row.id)])
    return { changed: receipts.length, receipts, entries: states.rows }
  })
}

export async function readActions(database: Pool | PoolClient, ids: string[], asOf?: string) {
  const result = await database.query(`
    SELECT id,entry_id,action,origin,actor,reason,evidence_ref,acted_at FROM jt_memo.entry_actions
    WHERE entry_id=ANY($1::uuid[]) AND acted_at<=COALESCE($2::timestamptz,CURRENT_TIMESTAMP)
    ORDER BY sequence DESC LIMIT 101
  `, [ids, asOf ?? null])
  return { actions: result.rows.slice(0, 100), actions_truncated: result.rows.length > 100 }
}

export async function listManagedEntries(database: Pool, kind: 'candidates' | 'archives', limit = 20) {
  z.number().int().min(1).max(100).parse(limit)
  const condition = kind === 'candidates' ? "claim_status='candidate' AND NOT archived" : 'archived'
  const result = await database.query(`SELECT id,submission_id,scope,collection,basis,claim_status,state,archived,
    entities,received_at,left(content,400) AS preview FROM jt_memo.entry_states
    WHERE ${condition} AND state<>'pending' ORDER BY received_at,id LIMIT $1`, [limit])
  const count = await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM jt_memo.entry_states WHERE ${condition} AND state<>'pending'`)
  return { total: count.rows[0].count, entries: result.rows, limit }
}

export async function storageStats(database: Pool | PoolClient) {
  const states = await database.query(`SELECT scope,state,claim_status,archived,count(*)::int AS count
    FROM jt_memo.entry_states GROUP BY scope,state,claim_status,archived ORDER BY scope,state,claim_status,archived`)
  const sizes = await database.query(`SELECT c.relname AS name,pg_total_relation_size(c.oid)::text AS bytes,
    pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='jt_memo' AND c.relkind='r' ORDER BY c.relname`)
  const volume = await database.query(`SELECT
    (SELECT count(*)::int FROM jt_memo.submissions) AS submissions,
    (SELECT count(*)::int FROM jt_memo.entries) AS entries,
    (SELECT count(*)::int FROM jt_memo.embeddings) AS vectors,
    (SELECT count(*)::int FROM jt_memo.entry_relations) AS relations,
    (SELECT count(*)::int FROM jt_memo.entry_actions) AS actions,
    (SELECT count(*)::int FROM jt_memo.jobs WHERE status='failed') AS failed_jobs`)
  return { counts: volume.rows[0], states: states.rows, tables: sizes.rows, archive_policy: '归档仅改变默认可见性，保留正文、向量和来源，不释放物理空间' }
}
