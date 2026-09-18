import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { timestampSchema } from '../contracts.ts'
import type { Submission, Extraction } from '../contracts.ts'
import { indexInputSchema, searchInputSchema, storeInputSchema, sha256, MemoStorageError } from './contract.ts'
import type { EmbeddingSpace, IndexInput, IndexReceipt, MemoryEntry, PublicationNote, SearchInput, StoreInput, StoreReceipt } from './contract.ts'
import { transaction } from './database.ts'
import { publishRelations, readRelations } from './revision-storage.ts'
import type { Relation, StateEntry } from './relations.ts'
import { entryMetadata, entrySnapshot } from './metadata.ts'
import { readActions } from './management.ts'
import { entryVersion, versionExpression } from '../version.ts'
import type { IntakeIssue } from '../intake.ts'

interface SubmissionRow {
  id: string
  content_hash: string
  source: Submission
  extraction: Extraction
  extraction_run: StoreInput['run']
  stored_at: Date
  received_at: Date
  intake_issues: IntakeIssue[]
}

interface IndexRow {
  id: string
  submission_id: string
  space_id: string
  vector_hash: string
  entry_count: number
  indexed_at: Date
  relation_decisions: Relation[]
  reconciliation_run: StoreInput['run'] | null
  publication_notes: PublicationNote[]
  intake_issues: IntakeIssue[]
}

function indexReceipt(row: IndexRow): IndexReceipt {
  return {
    status: row.intake_issues.length > 0 ? 'partial' : row.publication_notes.length > 0 ? 'review_required'
      : row.entry_count === 0 && row.relation_decisions.length === 0 ? 'noop' : 'indexed', id: row.id,
    submission_id: row.submission_id, space_id: row.space_id,
    entry_count: row.entry_count, indexed_at: row.indexed_at.toISOString(),
    relation_count: row.relation_decisions.length - row.publication_notes.length,
    publication_notes: row.publication_notes,
    intake_issues: row.intake_issues,
  }
}

/** Local PostgreSQL storage. The CLI worker owns all writes. */
export class MemoStorage {
  private readonly pool: Pool | PoolClient

  constructor(pool: Pool | PoolClient) {
    this.pool = pool
  }

  /** Persist immutable source and candidates; stored does not mean vector-indexed. */
  async store(input: StoreInput): Promise<StoreReceipt> {
    const { submission, extraction, run, intake_issues } = storeInputSchema.parse(input)
    const contentHash = sha256(JSON.stringify({ submission, extraction }))
    return transaction(this.pool, async (client) => {
      const inserted = await client.query(`
        INSERT INTO jt_memo.submissions (id, content_hash, source, extraction, extraction_run, received_at, intake_issues)
        VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT created_at FROM jt_memo.jobs WHERE id=$1),CURRENT_TIMESTAMP),$6)
        ON CONFLICT (id) DO NOTHING RETURNING id
      `, [submission.submission_id, contentHash, submission, extraction, run, JSON.stringify(intake_issues)])
      if (inserted.rowCount === 0) {
        const existing = await this.submission(client, submission.submission_id)
        if (existing.content_hash !== contentHash) {
          throw new MemoStorageError('SUBMISSION_CONFLICT', '同一 submission_id 已保存不同的材料或提炼结果')
        }
      } else {
        const entries = (['memories', 'proposals'] as const).flatMap(collection => extraction[collection].map(item => ({
          ...item, ...entryMetadata(item, submission), id: randomUUID(), collection, content_sha256: sha256(item.content),
        }))).map((entry, position) => ({ ...entry, position }))
        await client.query(`
          INSERT INTO jt_memo.entries
            (id, submission_id, position, collection, content, content_sha256, basis, scope,
             source_message_ids, project_ids, business_ids, source_session_id, entities, source_occurred_at, valid_from, valid_until)
          SELECT e.id, $1, e.position, e.collection, e.content, e.content_sha256, e.basis, e.scope,
                 e.source_message_ids, $3::text[], $4::text[], $5, e.entities, e.source_occurred_at, e.valid_from, e.valid_until
          FROM jsonb_to_recordset($2::jsonb) AS e(
            id uuid, position integer, collection text, content text, content_sha256 text,
            basis text, scope text, source_message_ids text[], entities text[], source_occurred_at timestamptz, valid_from timestamptz, valid_until timestamptz)
        `, [submission.submission_id, JSON.stringify(entries), submission.scope.project_ids, submission.scope.business_ids, submission.source.session_id])
      }
      const row = await this.submission(client, submission.submission_id)
      const entries = await client.query<{ id: string }>('SELECT id FROM jt_memo.entries WHERE submission_id = $1 ORDER BY position', [row.id])
      return {
        status: 'stored', submission_id: row.id, entry_ids: entries.rows.map(entry => entry.id),
        revision_evidence_count: row.extraction.revisions.length, stored_at: row.stored_at.toISOString(),
      }
    })
  }

  /** Commit a complete vector batch atomically. No model/API call runs in this transaction. */
  async index(input: IndexInput): Promise<IndexReceipt> {
    const parsed = indexInputSchema.parse(input)
    const embeddings = parsed.embeddings.toSorted((a, b) => a.entry_id.localeCompare(b.entry_id))
    const vectorHash = sha256(JSON.stringify(embeddings))
    return transaction(this.pool, async (client) => {
      // One batch lock covers publication and idempotency across callers.
      const submission = await this.submission(client, parsed.submission_id, true)
      const entries = await client.query<MemoryEntry>('SELECT * FROM jt_memo.entries WHERE submission_id = $1', [parsed.submission_id])
      if (embeddings.length !== entries.rows.length || entries.rows.some(entry => !embeddings.some(item => item.entry_id === entry.id && item.content_sha256 === entry.content_sha256))) {
        throw new MemoStorageError('INVALID_EMBEDDINGS', '向量必须完整对应本批全部条目及其正文哈希')
      }
      await client.query(`
        INSERT INTO jt_memo.embedding_spaces (id, dimensions, definition) VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
      `, [parsed.space.id, parsed.space.dimensions, parsed.space])
      const space = await client.query<{ matches: boolean }>('SELECT definition = $2::jsonb AS matches FROM jt_memo.embedding_spaces WHERE id = $1', [parsed.space.id, parsed.space])
      if (!space.rows[0].matches) throw new MemoStorageError('SPACE_CONFLICT', '该向量空间 ID 已绑定不同的模型、维度或输入版本')
      const issues = [...submission.intake_issues, ...parsed.intake_issues]
      const existing = await client.query<IndexRow & { matches: boolean }>('SELECT *, relation_decisions = $3::jsonb AND intake_issues=$4::jsonb AS matches FROM jt_memo.index_commits WHERE submission_id = $1 AND space_id = $2', [parsed.submission_id, parsed.space.id, JSON.stringify(parsed.relations), JSON.stringify(issues)])
      if (existing.rows.length > 0) {
        if (existing.rows[0].vector_hash !== vectorHash || !existing.rows[0].matches) throw new MemoStorageError('INDEX_CONFLICT', '该批次在此向量空间已提交不同向量或修订；拒绝覆盖')
        return indexReceipt(existing.rows[0])
      }
      const held: PublicationNote[] = []
      const allowed: Relation[] = []
      if (parsed.expected_versions) {
        const ids = [...new Set(parsed.relations.map(relation => relation.previous_entry_id))].sort()
        await client.query('SELECT id FROM jt_memo.entries WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
        for (const relation of parsed.relations) {
          if (relation.current_entry_id && !entries.rows.some(entry => entry.id === relation.current_entry_id)) throw new Error('修订的新记忆必须属于本批')
          const expected = parsed.expected_versions[relation.previous_entry_id]
          if (!expected || expected !== await entryVersion(client, relation.previous_entry_id)) {
            const reason = '旧记忆在提交后发生变化；向量已保存，关系需要重新核对'
            if (relation.current_entry_id) await client.query("INSERT INTO jt_memo.entry_actions(id,entry_id,action,origin,reason) VALUES ($1,$2,'hold','runtime',$3)", [randomUUID(), relation.current_entry_id, reason])
            held.push({ kind: 'review_required', reason, previous_entry_id: relation.previous_entry_id, current_entry_id: relation.current_entry_id })
          } else allowed.push(relation)
        }
      } else allowed.push(...parsed.relations)
      // Invalid relationships cannot change old facts. Hold only a known new endpoint
      // with no validated relationship; independent memories can still publish.
      const affected = new Set(parsed.intake_issues.flatMap(issue => {
        if (!issue.value || typeof issue.value !== 'object' || !('current_entry_id' in issue.value)) return []
        const id = issue.value.current_entry_id
        return typeof id === 'string' && entries.rows.some(entry => entry.id === id)
          && !parsed.relations.some(relation => relation.current_entry_id === id) ? [id] : []
      }))
      for (const id of affected) await client.query("INSERT INTO jt_memo.entry_actions(id,entry_id,action,origin,reason) VALUES ($1,$2,'hold','runtime',$3)",
        [randomUUID(), id, '关系输出未通过引用或结构校验；条目保留，诊断见批次 intake_issues'])
      const receipt = await client.query<IndexRow>(`
        INSERT INTO jt_memo.index_commits (id, submission_id, space_id, vector_hash, entry_count, relation_decisions, reconciliation_run, intake_issues)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
      `, [randomUUID(), parsed.submission_id, parsed.space.id, vectorHash, entries.rows.length, JSON.stringify(parsed.relations), parsed.reconciliation_run ?? null, JSON.stringify(issues)])
      for (const item of embeddings) {
        await client.query(`
          INSERT INTO jt_memo.embeddings (entry_id, submission_id, space_id, dimensions, embedding)
          VALUES ($1, $2, $3, $4, $5::public.vector)
        `, [item.entry_id, parsed.submission_id, parsed.space.id, parsed.space.dimensions, JSON.stringify(item.vector)])
      }
      const notes = [...await publishRelations(client, submission.source, submission.extraction, entries.rows, parsed.space.id, allowed), ...held]
      await client.query('UPDATE jt_memo.index_commits SET publication_notes=$3 WHERE submission_id=$1 AND space_id=$2', [parsed.submission_id, parsed.space.id, JSON.stringify(notes)])
      return indexReceipt({ ...receipt.rows[0], publication_notes: notes })
    })
  }

  /** Read the full original batch, extraction evidence, immutable entries and index receipts. */
  async getSubmission(submissionId: string, asOf?: string) {
    z.string().min(1).max(500).parse(submissionId)
    if (asOf) timestampSchema.parse(asOf)
    return transaction(this.pool, async (client) => {
      const row = await this.submission(client, submissionId, false, asOf)
      const entries = await client.query<StateEntry>(`WITH snapshot AS (${entrySnapshot('$2')}) SELECT * FROM snapshot WHERE submission_id = $1 ORDER BY position`, [submissionId, asOf ?? null])
      const commits = await client.query<IndexRow>('SELECT * FROM jt_memo.index_commits WHERE submission_id = $1 AND indexed_at<=COALESCE($2::timestamptz,CURRENT_TIMESTAMP) ORDER BY indexed_at, id', [submissionId, asOf ?? null])
      return {
        submission: row.source, extraction: row.extraction, run: row.extraction_run,
        intake_issues: row.intake_issues,
        stored_at: row.stored_at.toISOString(), entries: entries.rows,
        received_at: row.received_at.toISOString(), as_of: asOf ?? null,
        index_receipts: commits.rows.map(indexReceipt),
        reconciliation_runs: commits.rows.map(commit => commit.reconciliation_run).filter(Boolean),
        ...await readRelations(client, entries.rows.map(entry => entry.id), submissionId, asOf),
        ...await readActions(client, entries.rows.map(entry => entry.id), asOf),
      }
    })
  }

  /** Read one candidate and only the messages cited by it; no vectors enter the result. */
  async getEntry(entryId: string, asOf?: string) {
    z.uuid().parse(entryId)
    if (asOf) timestampSchema.parse(asOf)
    const result = await this.pool.query<StateEntry & { source: Submission, version_data: unknown }>(`
      WITH snapshot AS (${entrySnapshot('$2')})
      SELECT e.*, s.source, ${versionExpression} AS version_data FROM snapshot e JOIN jt_memo.submissions s ON s.id = e.submission_id WHERE e.id = $1
    `, [entryId, asOf ?? null])
    const row = result.rows[0]
    if (!row) throw new MemoStorageError('NOT_FOUND', '记忆条目不存在')
    const { source, version_data, ...entry } = row
    const commits = await this.pool.query<IndexRow>('SELECT * FROM jt_memo.index_commits WHERE submission_id = $1 AND indexed_at<=COALESCE($2::timestamptz,CURRENT_TIMESTAMP) ORDER BY indexed_at, id', [entry.submission_id, asOf ?? null])
    return {
      ...entry, source: source.source, version: asOf ? null : sha256(JSON.stringify(version_data)),
      messages: source.messages.filter(message => entry.source_message_ids.includes(message.message_id)),
      index_receipts: commits.rows.map(indexReceipt),
      as_of: asOf ?? null,
      ...await readRelations(this.pool, [entry.id], undefined, asOf),
      ...await readActions(this.pool, [entry.id], asOf),
    }
  }

  /** Exact cosine search in one named vector space and one explicit scope. */
  async search(input: SearchInput) {
    const query = searchInputSchema.parse(input)
    const space = await this.pool.query<{ definition: EmbeddingSpace }>('SELECT definition FROM jt_memo.embedding_spaces WHERE id = $1', [query.space_id])
    if (!space.rows[0]) throw new MemoStorageError('NOT_FOUND', '向量空间尚未建立')
    if (space.rows[0].definition.dimensions !== query.vector.length) throw new MemoStorageError('INVALID_EMBEDDINGS', '查询向量维度不匹配')
    const scope = query.scope
    const scopeIds = scope.kind === 'project' ? scope.project_ids : scope.kind === 'business' ? scope.business_ids : []
    const sourceId = scope.kind === 'current_task' ? scope.source_session_id : scope.kind === 'unspecified' ? scope.submission_id : ''
    // ponytail: exact scan is sufficient for the initial personal store; add ANN
    // only when measured volume/latency requires it. Scope filtering stays first.
    const matches = await this.pool.query<StateEntry & { distance: number }>(`
      WITH snapshot AS (${entrySnapshot('$9')})
      SELECT e.*, v.embedding OPERATOR(public.<=>) $2::public.vector AS distance
      FROM jt_memo.embeddings v JOIN snapshot e ON e.id = v.entry_id
      WHERE v.space_id = $1 AND e.scope = $3
        AND (e.claim_status IN ('asserted','observed','verified') OR ($6::boolean AND e.claim_status='candidate'))
        AND ($8::boolean OR e.state IN ('active','conflicted')) AND e.state<>'pending'
        AND ($10::boolean OR NOT e.archived)
        AND (($3 = 'project' AND e.project_ids <@ $4::text[])
          OR ($3 = 'business' AND e.business_ids <@ $4::text[])
          OR ($3 = 'current_task' AND e.source_session_id = $5)
          OR ($3 = 'unspecified' AND e.submission_id = $5)
          OR $3 = 'user')
      ORDER BY distance, e.id LIMIT $7
    `, [query.space_id, JSON.stringify(query.vector), scope.kind, scopeIds, sourceId, query.include_proposals || query.include_candidates, query.limit, query.include_history, query.as_of ?? null, query.include_archived])
    return { space: space.rows[0].definition, entries: matches.rows }
  }

  private async submission(client: PoolClient, id: string, lock = false, asOf?: string): Promise<SubmissionRow> {
    const result = await client.query<SubmissionRow>(`SELECT * FROM jt_memo.submissions WHERE id = $1
      AND received_at<=COALESCE($2::timestamptz,CURRENT_TIMESTAMP) AND stored_at<=COALESCE($2::timestamptz,CURRENT_TIMESTAMP)${lock ? ' FOR UPDATE' : ''}`, [id, asOf ?? null])
    if (!result.rows[0]) throw new MemoStorageError('NOT_FOUND', '记忆批次不存在')
    return result.rows[0]
  }
}
