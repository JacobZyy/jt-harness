import { z } from 'zod'
import type { Extraction, Submission } from '../contracts.ts'
import type { MemoryEntry } from './contract.ts'

export const comparisonLimits = { minimumSimilarity: 0.5, maxEntries: 24, maxBytes: 24000 } as const

export const relationSchema = z.strictObject({
  kind: z.enum(['correction', 'supplement', 'conflict']),
  previous_entry_id: z.uuid(),
  current_entry_id: z.uuid().nullable(),
  revision_index: z.number().int().min(0).max(79).nullable(),
  explanation: z.string().trim().min(1).max(2000),
  source_message_ids: z.array(z.string().min(1)).min(1).max(1000),
  evidence_quote: z.string().trim().min(1).max(4000),
  resolved_revision_conflict_ids: z.array(z.uuid()).max(20).default([]),
}).refine(value => value.current_entry_id !== null
  ? value.revision_index === null
  : value.kind === 'conflict' && value.revision_index !== null,
'更正和补充必须关联新记忆；冲突可关联本批 revision 证据')

export const reconciliationSchema = z.strictObject({ relations: z.array(relationSchema).max(160) })
export type Relation = z.infer<typeof relationSchema>
export type EntryState = 'pending' | 'active' | 'superseded' | 'conflicted' | 'scheduled' | 'expired'
export type ClaimStatus = 'candidate' | 'asserted' | 'observed' | 'verified' | 'rejected'
export type StateEntry = MemoryEntry & {
  state: EntryState, claim_status: ClaimStatus, archived: boolean,
  received_at: Date, published_at: Date | null, confirmed_at: Date | null, invalid_at: Date | null,
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id))

export function sameScope(a: MemoryEntry, b: MemoryEntry) {
  if (a.scope !== b.scope) return false
  switch (a.scope) {
    case 'project': return sameIds(a.project_ids, b.project_ids)
    case 'business': return sameIds(a.business_ids, b.business_ids)
    case 'current_task': return a.source_session_id === b.source_session_id
    case 'unspecified': return a.submission_id === b.submission_id
    case 'user': return true
  }
}

export function scopeProvided(entry: MemoryEntry, submission: Submission) {
  return sameScope(entry, {
    ...entry, submission_id: submission.submission_id,
    project_ids: submission.scope.project_ids, business_ids: submission.scope.business_ids,
    source_session_id: submission.source.session_id,
  })
}

/** IDs, scope and exact source quotes are checked again inside the publication transaction. */
export function validateRelations(relations: Relation[], previous: StateEntry[], current: MemoryEntry[], submission: Submission, extraction: Extraction) {
  const pairs = new Set<string>()
  const corrected = new Set<string>()
  for (const relation of relations) {
    const old = previous.find(entry => entry.id === relation.previous_entry_id)
    const next = current.find(entry => entry.id === relation.current_entry_id)
    if (!old || (old.collection !== 'memories' && old.claim_status !== 'verified')
      || ['candidate', 'rejected'].includes(old.claim_status) || old.archived
      || !['active', 'conflicted', 'scheduled'].includes(old.state)) throw new Error('修订引用的旧记忆不存在、未发布或已失效；必须重新比较')
    if (old.submission_id === submission.submission_id) throw new Error('跨批修订不能引用本批作为旧记忆')
    if (!scopeProvided(old, submission)) throw new Error('修订不能跨越项目、业务、任务或未明确范围')
    if (relation.current_entry_id !== null && (!next || next.collection !== 'memories' || !sameScope(old, next))) {
      throw new Error('新旧记忆必须属于完全相同范围，助手建议不能修改已存事实')
    }
    if (relation.revision_index !== null && extraction.revisions[relation.revision_index]?.kind !== 'conflict') {
      throw new Error('revision_index 必须引用本批未解决的冲突证据')
    }
    const pair = `${old.id}:${next?.id ?? `revision:${relation.revision_index}`}`
    if (pairs.has(pair)) throw new Error('同一对记忆不能重复或同时声明多种修订关系')
    pairs.add(pair)
    if (relation.kind === 'correction') {
      if (corrected.has(old.id)) throw new Error('一条旧记忆只能有一个直接替代者')
      corrected.add(old.id)
    } else if (relation.resolved_revision_conflict_ids.length > 0) throw new Error('只有明确更正才能裁决既有冲突')
    const evidenceIds = next?.source_message_ids ?? extraction.revisions[relation.revision_index!].source_message_ids
    if (relation.source_message_ids.some(id => !evidenceIds.includes(id))) throw new Error('修订引用必须来自对应新记忆或冲突证据')
    const cited = submission.messages.filter(message => relation.source_message_ids.includes(message.message_id))
    if (cited.length === 0 || !cited.some(message => message.text.includes(relation.evidence_quote))) throw new Error('修订证据引文不是本批来源原文')
  }
}
