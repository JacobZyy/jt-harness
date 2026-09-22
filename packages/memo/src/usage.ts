import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { scopeFilterSchema } from './storage/contract.ts'

export async function memoryUses(database: Pool | PoolClient, input: z.input<typeof scopeFilterSchema>, limit = 20) {
  const scope = scopeFilterSchema.parse(input)
  z.number().int().min(1).max(100).parse(limit)
  const ids = scope.kind === 'project' ? scope.project_ids : scope.kind === 'business' ? scope.business_ids : []
  const source = scope.kind === 'current_task' ? scope.source_session_id : scope.kind === 'unspecified' ? scope.submission_id : ''
  const rows = await database.query(`
    SELECT u.*,left(e.content,240) AS preview,e.state AS current_state,
      r.evidence#>>'{submission,source,session_id}' AS session_id,r.evidence#>'{submission,scope}' AS context_scope
    FROM jt_memo.memory_uses u JOIN jt_memo.declaration_receipts r ON r.id=u.declaration_id
      JOIN jt_memo.entry_states e ON e.id=u.entry_id
    WHERE ($1='current_task' AND r.evidence#>>'{submission,source,session_id}'=$3)
      OR ($1='project' AND jsonb_array_length(r.evidence#>'{submission,scope,project_ids}')>0
        AND ARRAY(SELECT jsonb_array_elements_text(r.evidence#>'{submission,scope,project_ids}')) <@ $2::text[])
      OR ($1='business' AND jsonb_array_length(r.evidence#>'{submission,scope,business_ids}')>0
        AND ARRAY(SELECT jsonb_array_elements_text(r.evidence#>'{submission,scope,business_ids}')) <@ $2::text[])
      OR ($1='user' AND e.scope='user') OR ($1='unspecified' AND e.submission_id=$3)
    ORDER BY u.reported_at DESC,u.declaration_id,u.entry_id LIMIT $4
  `, [scope.kind, ids, source, limit])
  return { kind: 'reported_use', uses: rows.rows, limit, notice: '采用反馈是主 Agent 的声明，不代表正确性评分；read_version 保留当时读取的版本。' }
}
