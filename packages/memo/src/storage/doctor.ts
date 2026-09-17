import type { Pool } from 'pg'
import { parseExtraction, submissionSchema } from '../contracts.ts'
import type { Extraction, Submission } from '../contracts.ts'
import { sha256, vectorSchema } from './contract.ts'
import type { MemoryEntry } from './contract.ts'
import { entryMetadata } from './metadata.ts'
import { sameScope } from './relations.ts'

interface Issue { level: 'error' | 'warning', check: string, record: string, detail: string }

/** Diagnose one consistent read-only snapshot. Repairs are never implicit. */
export async function storageDoctor(pool: Pool) {
  const client = await pool.connect()
  const issues: Issue[] = []
  let errors = 0
  let warnings = 0
  let submissions = 0
  let commits = 0
  const add = (level: Issue['level'], check: string, record: string, detail: string) => {
    if (level === 'error') errors++; else warnings++
    if (issues.length < 100) issues.push({ level, check, record, detail })
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const ready = await client.query<{ relation: string | null }>("SELECT to_regclass('jt_memo.schema_version')::text AS relation")
    const version = ready.rows[0].relation ? (await client.query<{ version: number }>('SELECT version FROM jt_memo.schema_version')).rows[0]?.version : null
    if (version !== 4) {
      add('error', 'schema', 'jt_memo', '需要 v4；先运行 jth memo init，体检本身不会改库')
    } else {
      let cursor = ''
      for (;;) {
        const rows = await client.query<{ id: string, content_hash: string, source: Submission, extraction: Extraction }>(
          'SELECT id,content_hash,source,extraction FROM jt_memo.submissions WHERE id>$1 ORDER BY id LIMIT 50', [cursor])
        if (rows.rows.length === 0) break
        for (const row of rows.rows) {
          submissions++
          let source: Submission
          let extraction: Extraction
          try {
            source = submissionSchema.parse(row.source)
            extraction = parseExtraction(JSON.stringify(row.extraction), source)
          } catch {
            add('error', 'source_contract', row.id, '来源或提炼结果不满足已保存的契约')
            continue
          }
          if (sha256(JSON.stringify({ submission: source, extraction })) !== row.content_hash) add('error', 'submission_hash', row.id, '材料或提炼结果与提交哈希不一致')
          const entries = await client.query<MemoryEntry>('SELECT * FROM jt_memo.entries WHERE submission_id=$1 ORDER BY position', [row.id])
          const expected = (['memories', 'proposals'] as const).flatMap(collection => extraction[collection].map(fact => ({ ...fact, collection })))
          if (entries.rows.length !== expected.length) add('error', 'entry_count', row.id, '条目数量与提炼检查点不一致')
          for (const entry of entries.rows) {
            const fact = expected[entry.position]
            if (!fact || entry.content !== fact.content || entry.collection !== fact.collection || entry.scope !== fact.scope
              || entry.basis !== fact.basis || JSON.stringify(entry.source_message_ids) !== JSON.stringify(fact.source_message_ids)
              || entry.source_session_id !== source.source.session_id
              || JSON.stringify(entry.project_ids) !== JSON.stringify(source.scope.project_ids)
              || JSON.stringify(entry.business_ids) !== JSON.stringify(source.scope.business_ids)) {
              add('error', 'entry_source', entry.id, '条目正文、分类或引用与原提炼不一致')
              continue
            }
            if (sha256(entry.content) !== entry.content_sha256) add('error', 'content_hash', entry.id, '正文与正文哈希不一致')
            const metadata = entryMetadata(fact, source)
            const actual = { entities: entry.entities, source_occurred_at: entry.source_occurred_at?.toISOString() ?? null,
              valid_from: entry.valid_from?.toISOString() ?? null, valid_until: entry.valid_until?.toISOString() ?? null }
            if (JSON.stringify(metadata) !== JSON.stringify(actual)) add('error', 'entry_metadata', entry.id, '实体或时间元数据与原始证据不一致')
          }
          const receipts = await client.query<{ id: string, space_id: string, entry_count: number, vector_hash: string }>('SELECT id,space_id,entry_count,vector_hash FROM jt_memo.index_commits WHERE submission_id=$1', [row.id])
          for (const receipt of receipts.rows) {
            commits++
            const vectors = await client.query<{ entry_id: string, content_sha256: string, vector: string }>(`
              SELECT v.entry_id,e.content_sha256,v.embedding::text AS vector FROM jt_memo.embeddings v
              JOIN jt_memo.entries e ON e.id=v.entry_id WHERE v.submission_id=$1 AND v.space_id=$2
            `, [row.id, receipt.space_id])
            if (vectors.rows.length !== receipt.entry_count || vectors.rows.length !== entries.rows.length) add('error', 'vector_count', receipt.id, '向量数量与条目或索引回执不一致')
            try {
              const normalized = vectors.rows.map(vector => ({ entry_id: vector.entry_id, content_sha256: vector.content_sha256, vector: vectorSchema.parse(JSON.parse(vector.vector)) }))
                .sort((a, b) => a.entry_id.localeCompare(b.entry_id))
              if (sha256(JSON.stringify(normalized)) !== receipt.vector_hash) add('error', 'vector_hash', receipt.id, '存储向量与提交回执哈希不一致')
            } catch { add('error', 'vector_values', receipt.id, '向量不是可用的有限非零 float32 数据') }
          }
        }
        cursor = rows.rows.at(-1)!.id
      }
      const incomplete = await client.query<{ id: string }>(`SELECT j.id FROM jt_memo.jobs j
        WHERE j.status='complete' AND NOT EXISTS(SELECT 1 FROM jt_memo.index_commits c WHERE c.submission_id=j.id AND c.space_id=j.execution->'space'->>'id')`)
      for (const row of incomplete.rows) add('error', 'complete_without_receipt', row.id, '任务标记完成但缺少对应空间的提交回执')
      const dimensions = await client.query<{ entry_id: string }>(`SELECT v.entry_id FROM jt_memo.embeddings v JOIN jt_memo.embedding_spaces s ON s.id=v.space_id
        WHERE public.vector_dims(v.embedding)<>v.dimensions OR v.dimensions<>s.dimensions OR v.dimensions<>(s.definition->>'dimensions')::integer`)
      for (const row of dimensions.rows) add('error', 'dimensions', row.entry_id, '向量维度与空间定义不一致')
      const links = await client.query<{ id: string, previous: MemoryEntry, current: MemoryEntry | null, evidence: Submission, quote: string, ids: string[] }>(`
        SELECT r.id,to_jsonb(p) AS previous,to_jsonb(n) AS current,s.source AS evidence,r.evidence_quote AS quote,r.source_message_ids AS ids
        FROM jt_memo.entry_relations r JOIN jt_memo.entries p ON p.id=r.previous_entry_id
        LEFT JOIN jt_memo.entries n ON n.id=r.current_entry_id JOIN jt_memo.submissions s ON s.id=r.evidence_submission_id
      `)
      for (const link of links.rows) {
        if (link.current && !sameScope(link.previous, link.current)) add('error', 'relation_scope', link.id, '关系跨越了不同范围')
        if (!link.ids.every(id => link.evidence.messages.some(message => message.message_id === id))
          || !link.evidence.messages.some(message => link.ids.includes(message.message_id) && message.text.includes(link.quote))) add('error', 'relation_evidence', link.id, '关系引用或引文不能定位到原始材料')
      }
      const cycles = await client.query<{ root: string }>(`WITH RECURSIVE paths(root,node,visited,cycle) AS (
        SELECT previous_entry_id,current_entry_id,ARRAY[previous_entry_id,current_entry_id],false FROM jt_memo.entry_relations WHERE kind='correction'
        UNION ALL SELECT p.root,r.current_entry_id,p.visited||r.current_entry_id,r.current_entry_id=ANY(p.visited)
          FROM paths p JOIN jt_memo.entry_relations r ON r.previous_entry_id=p.node AND r.kind='correction' WHERE NOT p.cycle
      ) SELECT DISTINCT root FROM paths WHERE cycle`)
      for (const row of cycles.rows) add('error', 'revision_cycle', row.root, '替代关系出现循环')
      const unknown = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM jt_memo.entries WHERE source_occurred_at IS NULL')
      if (unknown.rows[0].count) add('warning', 'unknown_source_time', 'entries', `${unknown.rows[0].count} 条记忆没有完整来源时间；不会伪造为今天`)
      const future = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM jt_memo.entries WHERE source_occurred_at>CURRENT_TIMESTAMP')
      if (future.rows[0].count) add('warning', 'future_source_time', 'entries', `${future.rows[0].count} 条来源事件时间晚于当前时间；请核对采集端时钟和时区`)
      const failed = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM jt_memo.jobs WHERE status='failed'")
      if (failed.rows[0].count) add('warning', 'failed_jobs', 'jobs', `${failed.rows[0].count} 个任务失败，可通过 status 查看原因`)
    }
    await client.query('COMMIT')
    return { ok: errors === 0, schema_version: version, checked: { submissions, commits }, errors, warnings, issues, issues_truncated: errors + warnings > issues.length, mode: 'read_only' }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
