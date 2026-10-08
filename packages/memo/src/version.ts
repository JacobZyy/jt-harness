import type { Pool, PoolClient } from 'pg'
import { sha256 } from './storage/contract.ts'

/** Evidence and governance are append-only, so these identities form a revision token. */
function versionDataExpression(entryAlias: string, factsAlias: string, asOfPlaceholder: string, includeDerivations: boolean): string {
  const at = `COALESCE(${asOfPlaceholder}::timestamptz,CURRENT_TIMESTAMP)`
  const derivations: string = includeDerivations ? `,
  'derivations',CASE WHEN EXISTS (SELECT 1 FROM jt_memo.entry_derivations d WHERE d.derived_entry_id=${entryAlias}.id) THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('source_entry_id',d.source_entry_id,'read_version',d.read_version,
    'source_version_data',(SELECT ${versionDataExpression('source_entry', 'source_facts', asOfPlaceholder, false)}
      FROM jt_memo.entries source_entry JOIN jt_memo.entry_facts_at(${at}) source_facts ON source_facts.entry_id=source_entry.id
      WHERE source_entry.id=d.source_entry_id)) ORDER BY d.source_entry_id)
    FROM jt_memo.entry_derivations d WHERE d.derived_entry_id=${entryAlias}.id),'[]'::jsonb) ELSE NULL END` : ''
  return `jsonb_strip_nulls(jsonb_build_object('content',${entryAlias}.content_sha256,'state',${factsAlias}.state,'claim',${factsAlias}.claim_status,'archived',${factsAlias}.archived,
  'actions',COALESCE((SELECT jsonb_agg(a.id ORDER BY a.id) FROM jt_memo.entry_actions a WHERE a.entry_id=${entryAlias}.id AND a.acted_at<=${at}),'[]'::jsonb),
  'relations',COALESCE((SELECT jsonb_agg(r.id ORDER BY r.id) FROM jt_memo.entry_relations r WHERE (r.previous_entry_id=${entryAlias}.id OR r.current_entry_id=${entryAlias}.id) AND r.created_at<=${at}),'[]'::jsonb)${derivations}) )`
}

export function versionExpressionFor(alias = 'e', asOfPlaceholder = 'NULL', includeDerivations = true) {
  return versionDataExpression(alias, alias, asOfPlaceholder, includeDerivations)
}

export const versionExpression = versionExpressionFor()

export async function entryVersion(database: Pool | PoolClient, id: string) {
  const result = await database.query(`SELECT ${versionExpression} AS version_data FROM jt_memo.entry_states e WHERE e.id=$1`, [id])
  if (!result.rows[0]) throw new Error('待修订的旧记忆不存在')
  return sha256(JSON.stringify(result.rows[0].version_data))
}
