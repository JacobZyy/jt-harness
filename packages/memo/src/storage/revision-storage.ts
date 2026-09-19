import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { Extraction, Submission } from '../contracts.ts'
import type { MemoryEntry, PublicationNote } from './contract.ts'
import { validateRelations, comparisonLimits } from './relations.ts'
import type { Relation, StateEntry } from './relations.ts'
import { entrySnapshot } from './metadata.ts'

interface RelationRow extends Omit<Relation, 'resolved_revision_conflict_ids'> {
  id: string
  evidence_submission_id: string
  origin_relation_id: string | null
  effective_at: Date
  needs_review: boolean
}

const openConflict = `r.kind = 'conflict' AND NOT EXISTS (
  SELECT 1 FROM jt_memo.entry_relations c WHERE c.kind = 'correction'
    AND (c.previous_entry_id = r.previous_entry_id OR c.previous_entry_id = r.current_entry_id))`

function correctionReviewReason(previous: StateEntry, current: StateEntry, now: Date) {
  if (current.claim_status === 'candidate' || current.claim_status === 'rejected' || current.archived) return '新条目尚未获得可用资格'
  const startsAt = current.valid_from ?? current.source_occurred_at
  if (startsAt && startsAt > now) return '未来生效的更正需要在生效时确认，暂不作废当前事实'
  if (current.valid_until && current.valid_until <= now) return '已过有效期的历史材料不能自动作废当前事实'
  const olderAt = previous.confirmed_at ?? previous.source_occurred_at
  const newerAt = current.source_occurred_at
  if (olderAt && !newerAt) return '旧记忆有明确事件时间，新材料时间未知，需要确认顺序'
  if (olderAt && newerAt && newerAt < olderAt) return '新收到的材料实际早于当前记忆，已阻止晚到资料覆盖'
  if (!olderAt && newerAt && newerAt < previous.received_at) return '旧记忆缺少事件时间，无法证明这份补录材料更新'
  if (!olderAt && !newerAt && current.received_at < previous.received_at) return '较早接收的任务晚完成，已阻止重试覆盖后来决定'
  return null
}

export async function publishRelations(client: PoolClient, submission: Submission, extraction: Extraction, current: MemoryEntry[], spaceId: string, relations: Relation[]): Promise<PublicationNote[]> {
  if (relations.length === 0) return []
  const ids = [...new Set(relations.map(relation => relation.previous_entry_id))].sort()
  await client.query('SELECT id FROM jt_memo.entries WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
  const previous = await client.query<StateEntry>('SELECT * FROM jt_memo.entry_states WHERE id = ANY($1::uuid[])', [ids])
  validateRelations(relations, previous.rows, current, submission, extraction)
  const incoming = await client.query<StateEntry>('SELECT * FROM jt_memo.entry_states WHERE submission_id=$1', [submission.submission_id])
  const now = (await client.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now')).rows[0].now
  const held = new Map<string, string>()
  for (const relation of relations) {
    if (relation.kind !== 'correction') continue
    const next = incoming.rows.find(entry => entry.id === relation.current_entry_id)!
    const reason = correctionReviewReason(previous.rows.find(entry => entry.id === relation.previous_entry_id)!, next, now)
    if (reason) held.set(next.id, reason)
  }
  for (const [id, reason] of held) {
    await client.query("INSERT INTO jt_memo.entry_actions(id,entry_id,action,origin,reason) VALUES ($1,$2,'hold','runtime',$3)", [randomUUID(), id, reason])
  }
  const notes: PublicationNote[] = []
  const deferred = new Set<Relation>()
  for (const relation of relations) {
    const next = incoming.rows.find(entry => entry.id === relation.current_entry_id)
    const reason = held.get(relation.current_entry_id ?? '')
      ?? (submission.review_required || next?.claim_status === 'candidate' || next?.claim_status === 'rejected' ? '来源要求审核，关系尚未生效' : null)
    if (reason) {
      notes.push({ kind: 'review_required', reason, previous_entry_id: relation.previous_entry_id, current_entry_id: relation.current_entry_id })
      deferred.add(relation)
    }
  }
  const existingConflicts = await client.query<RelationRow>(`
    SELECT r.* FROM jt_memo.entry_relations r WHERE (${openConflict})
      AND (r.previous_entry_id = ANY($1::uuid[]) OR r.current_entry_id = ANY($1::uuid[]))
  `, [ids])
  const resolved = new Set<string>()
  for (const relation of relations) {
    if (deferred.has(relation)) continue
    for (const id of relation.resolved_revision_conflict_ids) {
      const conflict = existingConflicts.rows.find(row => row.id === id)
      if (!conflict || conflict.current_entry_id !== null || conflict.previous_entry_id !== relation.previous_entry_id || relation.kind !== 'correction') {
        throw new Error('只能裁决当前旧记忆关联的未解决 revision 冲突')
      }
      resolved.add(id)
    }
  }
  const insert = async (relation: Relation, evidenceSubmissionId: string, origin: string | null, effectiveAt: Date, needsReview = false) => {
    await client.query(`
      INSERT INTO jt_memo.entry_relations (id, submission_id, space_id, kind, previous_entry_id, current_entry_id,
        revision_index, explanation, evidence_submission_id, source_message_ids, evidence_quote, origin_relation_id,effective_at,needs_review)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (submission_id, kind, previous_entry_id, current_entry_id, revision_index) DO NOTHING
    `, [randomUUID(), submission.submission_id, spaceId, relation.kind, relation.previous_entry_id, relation.current_entry_id,
      relation.revision_index, relation.explanation, evidenceSubmissionId, relation.source_message_ids, relation.evidence_quote, origin, effectiveAt, needsReview])
  }
  for (const relation of relations) {
    const next = incoming.rows.find(entry => entry.id === relation.current_entry_id)
    const startsAt = next?.valid_from ?? next?.source_occurred_at
    const effectiveAt = startsAt && startsAt > now ? startsAt : now
    if (deferred.has(relation) && relation.current_entry_id === null) continue
    await insert(deferred.has(relation) && relation.kind === 'correction' ? { ...relation, kind: 'conflict' } : relation,
      submission.submission_id, null, effectiveAt, deferred.has(relation))
  }
  const replacements = new Map(relations.filter(relation => relation.kind === 'correction' && !deferred.has(relation)).map(relation => [relation.previous_entry_id, relation.current_entry_id!]))
  // Correcting one side must not silently declare the other side of an unresolved
  // conflict true. Carry the dispute forward until both sides share a replacement.
  for (const conflict of existingConflicts.rows) {
    if (resolved.has(conflict.id)) continue
    const previousId = replacements.get(conflict.previous_entry_id) ?? conflict.previous_entry_id
    const currentId = conflict.current_entry_id === null ? null : replacements.get(conflict.current_entry_id) ?? conflict.current_entry_id
    if (previousId === currentId || (previousId === conflict.previous_entry_id && currentId === conflict.current_entry_id)) continue
    await insert({ ...conflict, previous_entry_id: previousId, current_entry_id: currentId, resolved_revision_conflict_ids: [] }, conflict.evidence_submission_id, conflict.id, conflict.effective_at > now ? conflict.effective_at : now, conflict.needs_review)
  }
  return notes
}

export async function readRelations(database: Pool | PoolClient, ids: string[], submissionId?: string, asOf?: string) {
  const result = await database.query<RelationRow & {
    previous_content: string, current_content: string | null, evidence: Submission, revision: Extraction['revisions'][number] | null, unresolved: boolean,
    previous_source: Submission, previous_sources: string[], current_source: Submission | null, current_sources: string[] | null,
  }>(`
    WITH snapshot AS (${entrySnapshot('$3')})
    SELECT r.*, p.content AS previous_content, n.content AS current_content, s.source AS evidence,
      ps.source AS previous_source, p.source_message_ids AS previous_sources,
      ns.source AS current_source, n.source_message_ids AS current_sources,
      s.extraction->'revisions'->r.revision_index AS revision,
      (r.kind='conflict' AND r.effective_at<=COALESCE($3::timestamptz,CURRENT_TIMESTAMP)
        AND NOT EXISTS (SELECT 1 FROM jt_memo.entry_relations c WHERE c.kind='correction'
          AND c.created_at<=COALESCE($3::timestamptz,CURRENT_TIMESTAMP) AND c.effective_at<=COALESCE($3::timestamptz,CURRENT_TIMESTAMP)
          AND (c.previous_entry_id=r.previous_entry_id OR c.previous_entry_id=r.current_entry_id))
        AND (NOT r.needs_review OR (p.claim_status NOT IN ('candidate','rejected') AND n.claim_status NOT IN ('candidate','rejected')))) AS unresolved
    FROM jt_memo.entry_relations r JOIN snapshot p ON p.id = r.previous_entry_id
    LEFT JOIN snapshot n ON n.id = r.current_entry_id
    JOIN jt_memo.submissions ps ON ps.id = p.submission_id
    LEFT JOIN jt_memo.submissions ns ON ns.id = n.submission_id
    JOIN jt_memo.submissions s ON s.id = r.evidence_submission_id
    WHERE (r.previous_entry_id = ANY($1::uuid[]) OR r.current_entry_id = ANY($1::uuid[]) OR r.submission_id = $2)
      AND r.created_at<=COALESCE($3::timestamptz,CURRENT_TIMESTAMP)
    ORDER BY unresolved DESC, r.created_at DESC, r.id LIMIT 101
  `, [ids, submissionId ?? null, asOf ?? null])
  return {
    relations: result.rows.slice(0, 100).map(({ evidence, previous_source, previous_sources, current_source, current_sources, ...row }) => ({
      ...row, source: evidence.source,
      messages: evidence.messages.filter(message => row.source_message_ids.includes(message.message_id)),
      previous_evidence: { source: previous_source.source, messages: previous_source.messages.filter(message => previous_sources.includes(message.message_id)) },
      current_evidence: current_source ? { source: current_source.source, messages: current_source.messages.filter(message => current_sources!.includes(message.message_id)) }
        : { source: evidence.source, messages: evidence.messages.filter(message => row.source_message_ids.includes(message.message_id)) },
    })),
    relations_truncated: result.rows.length > 100,
  }
}

/** Retrieval nominates candidates only; similarity never authorizes a correction. */
export async function findRelatedEntries(database: Pool | PoolClient, submission: Submission, spaceId: string, probes: { vector: number[], scope: MemoryEntry['scope'] | null }[]) {
  const found = new Map<string, StateEntry & { similarity: number }>()
  for (const probe of probes) {
    const result = await database.query<StateEntry & { similarity: number }>(`
      SELECT e.*, 1 - (v.embedding OPERATOR(public.<=>) $2::public.vector) AS similarity FROM jt_memo.entry_states e JOIN jt_memo.embeddings v ON v.entry_id = e.id
      WHERE v.space_id = $1 AND e.claim_status IN ('asserted','observed','verified') AND NOT e.archived AND e.state IN ('active', 'conflicted', 'scheduled')
        AND e.submission_id <> $3 AND ($4::text IS NULL OR e.scope = $4)
        AND (e.scope = 'user'
          OR (e.scope = 'project' AND e.project_ids <@ $5::text[] AND e.project_ids @> $5::text[])
          OR (e.scope = 'business' AND e.business_ids <@ $6::text[] AND e.business_ids @> $6::text[])
          OR (e.scope = 'current_task' AND e.source_session_id = $7))
      ORDER BY v.embedding OPERATOR(public.<=>) $2::public.vector, e.id LIMIT 5
    `, [spaceId, JSON.stringify(probe.vector), submission.submission_id, probe.scope,
      submission.scope.project_ids, submission.scope.business_ids, submission.source.session_id])
    for (const entry of result.rows) {
      if (entry.similarity < comparisonLimits.minimumSimilarity) continue
      if (!found.has(entry.id) || found.get(entry.id)!.similarity < entry.similarity) found.set(entry.id, entry)
    }
  }
  return [...found.values()].sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, comparisonLimits.maxEntries)
}
