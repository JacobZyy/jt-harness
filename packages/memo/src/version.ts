import type { Pool, PoolClient } from 'pg'
import { sha256 } from './storage/contract.ts'

/** Evidence and governance are append-only, so these identities form a revision token. */
export const versionExpression = `jsonb_build_object('content',e.content_sha256,'state',e.state,'claim',e.claim_status,'archived',e.archived,
  'actions',COALESCE((SELECT jsonb_agg(a.id ORDER BY a.id) FROM jt_memo.entry_actions a WHERE a.entry_id=e.id),'[]'::jsonb),
  'relations',COALESCE((SELECT jsonb_agg(r.id ORDER BY r.id) FROM jt_memo.entry_relations r WHERE r.previous_entry_id=e.id OR r.current_entry_id=e.id),'[]'::jsonb))`

export async function entryVersion(database: Pool | PoolClient, id: string) {
  const result = await database.query(`SELECT ${versionExpression} AS version_data FROM jt_memo.entry_states e WHERE e.id=$1`, [id])
  if (!result.rows[0]) throw new Error('待修订的旧记忆不存在')
  return sha256(JSON.stringify(result.rows[0].version_data))
}
