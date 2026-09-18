import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { inspectExtraction } from '../intake.ts'
import type { IntakeIssue } from '../intake.ts'
import type { ExecutionProfile } from '../config.ts'
import { submissionSchema } from '../contracts.ts'
import { MemoStorage } from './storage.ts'
import { transaction } from './database.ts'
import { enqueue } from './jobs.ts'
import { sha256 } from './contract.ts'
import { relationSchema } from './relations.ts'
import { publishRelations } from './revision-storage.ts'

const reason = z.string().trim().min(1).max(2000)
const recoveryInputSchema = z.array(z.discriminatedUnion('action', [
  z.strictObject({ path: z.string().min(1), action: z.literal('replace'), reason, value: z.unknown().refine(value => value !== undefined, 'replace 必须提供 value') }),
  z.strictObject({ path: z.string().min(1), action: z.literal('dismiss'), reason }),
])).min(1).max(160).refine(items => new Set(items.map(item => item.path)).size === items.length, '不能重复处理同一个 issue 路径')

export async function readIntakeRecovery(database: Pool | PoolClient, id: string) {
  const job = (await database.query<{ status: string, execution: ExecutionProfile }>('SELECT status,execution FROM jt_memo.jobs WHERE id=$1', [id])).rows[0]
  if (!job) throw new Error('记忆任务不存在')
  const saved = await new MemoStorage(database).getSubmission(id)
  const receipt = saved.index_receipts.find(receipt => receipt.space_id === job.execution.space.id)
  const recoveries = (await database.query(`SELECT r.*,j.status AS followup_status,j.error AS followup_error
    FROM jt_memo.intake_recoveries r LEFT JOIN jt_memo.jobs j ON j.id=r.followup_id WHERE r.submission_id=$1 ORDER BY r.created_at,r.path`, [id])).rows
  const issues = (receipt?.intake_issues ?? saved.intake_issues).map(issue => {
    const recovery = recoveries.find(row => row.path === issue.path) ?? null
    const resolved = recovery !== null && (recovery.action === 'dismiss' || (recovery.followup_id
      ? recovery.followup_status === 'complete' : recovery.publication_notes.length === 0))
    return { ...issue, resolved, recovery }
  })
  return { submission_id: id, status: job.status, unresolved_count: issues.filter(issue => !issue.resolved).length, issues }
}

/** Explicit per-issue corrections share the existing source, storage and publication contracts. */
export async function recoverIntake(pool: Pool, id: string, input: unknown) {
  const changes = recoveryInputSchema.parse(input)
  await transaction(pool, async client => {
    const job = (await client.query<{ status: string, execution: ExecutionProfile }>('SELECT status,execution FROM jt_memo.jobs WHERE id=$1 FOR UPDATE', [id])).rows[0]
    if (!job || job.status !== 'partial') throw new Error('只能恢复已完成部分入库的 partial；failed 先用 memo retry 从保存阶段续跑')
    const storage = new MemoStorage(client), saved = await storage.getSubmission(id)
    const receipt = saved.index_receipts.find(receipt => receipt.space_id === job.execution.space.id)
    if (!receipt) throw new Error('缺少原发布回执，不能处理 partial')
    for (const change of changes) {
      const issue = receipt.intake_issues.find(issue => issue.path === change.path)
      if (!issue) throw new Error(`未接收条目不存在：${change.path}`)
      const hash = sha256(JSON.stringify(change))
      const existing = (await client.query('SELECT content_hash FROM jt_memo.intake_recoveries WHERE submission_id=$1 AND path=$2', [id, change.path])).rows[0]
      if (existing) {
        if (existing.content_hash !== hash) throw new Error(`${change.path} 已有恢复回执；不能覆盖，后续失败应 retry 对应任务`)
        continue
      }
      let notes: Awaited<ReturnType<typeof publishRelations>> = []
      if (change.action === 'replace' && issue.path.startsWith('relations[')) {
        const relation = relationSchema.parse(change.value)
        const ids = [relation.previous_entry_id, ...(relation.current_entry_id ? [relation.current_entry_id] : [])].sort()
        await client.query('SELECT id FROM jt_memo.entries WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
        if (relation.current_entry_id) {
          const current = (await client.query('SELECT state FROM jt_memo.entry_states WHERE id=$1 AND submission_id=$2', [relation.current_entry_id, id])).rows[0]
          if (!current || !['active', 'conflicted', 'scheduled'].includes(current.state)) throw new Error('恢复引用的新记忆已失效或不属于原批次；重新核对当前事实，不能用旧关系回退状态')
        }
        // Do not let a repair add a second, contradictory declaration for a pair already published.
        const pair = await client.query(`SELECT id FROM jt_memo.entry_relations WHERE previous_entry_id=$1
          AND current_entry_id IS NOT DISTINCT FROM $2::uuid AND revision_index IS NOT DISTINCT FROM $3::int
          AND submission_id=$4`, [relation.previous_entry_id, relation.current_entry_id, relation.revision_index, id])
        if (pair.rowCount) throw new Error('该关系已经发布；原错误可用 dismiss 说明重复原因')
        notes = await publishRelations(client, saved.submission, saved.extraction, saved.entries, job.execution.space.id, [relation])
      } else if (change.action === 'replace') {
        const collection = extractionCollection(issue)
        const values = issue.path === collection ? change.value : [change.value]
        const { extraction, issues } = inspectExtraction(JSON.stringify({ schema_version: 1, memories: [], proposals: [], revisions: [], [collection]: values }), saved.submission)
        if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.error}`).join('; '))
        if (!extraction[collection].length) throw new Error('空修正使用 dismiss 并说明依据')
        if (extraction[collection].some(item => saved.extraction[collection].some(accepted => isDeepStrictEqual(item, accepted)))) {
          throw new Error('修正包含本批已接收条目；使用 dismiss 说明重复，不重新嵌入有效内容')
        }
        const followup = `recovery-${sha256(JSON.stringify([id, change.path]))}`
        const submission = submissionSchema.parse({ ...saved.submission, submission_id: followup })
        await enqueue(client, submission, job.execution)
        // Write the link before store so recovery retains the original receive time.
        await client.query(`INSERT INTO jt_memo.intake_recoveries(submission_id,path,action,reason,value,content_hash,followup_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, change.path, change.action, change.reason, JSON.stringify(change.value), hash, followup])
        await storage.store({ submission, extraction, run: { session_id: followup, provider: 'local', model: 'explicit-recovery' } })
        continue
      }
      await client.query(`INSERT INTO jt_memo.intake_recoveries(submission_id,path,action,reason,value,content_hash,publication_notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, change.path, change.action, change.reason,
        change.action === 'replace' ? JSON.stringify(change.value) : null, hash, JSON.stringify(notes)])
    }
  })
  return readIntakeRecovery(pool, id)
}

function extractionCollection(issue: IntakeIssue): 'memories' | 'proposals' | 'revisions' {
  for (const collection of ['memories', 'proposals', 'revisions'] as const) {
    if (issue.path === collection || issue.path.startsWith(`${collection}[`)) return collection
  }
  throw new Error(`未知条目路径：${issue.path}`)
}
