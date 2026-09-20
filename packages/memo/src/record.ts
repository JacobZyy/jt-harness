import { evidenceSchema, recordDraftSchema, recordId } from './record-contract.ts'
import type { Evidence, RecordDraft } from './record-contract.ts'
import type { Pool, PoolClient } from 'pg'
import { parseExtraction, submissionSchema } from './contracts.ts'
import type { Submission } from './contracts.ts'
import type { Extraction } from './contracts.ts'
import type { Config } from './config.ts'
import { MemoStorageError, sha256 } from './storage/contract.ts'
import { relationSchema, validateRelations } from './storage/relations.ts'
import { MemoStorage } from './storage/storage.ts'
import { transaction } from './storage/database.ts'
import { entryVersion } from './version.ts'
import { entryMetadata } from './storage/metadata.ts'
import { declarationId } from './declaration-contract.ts'

type Fact = Extraction['memories'][number] | Extraction['proposals'][number]
export interface DeclarationReceipt {
  status: 'accepted', declaration_id: string, submission_id: string | null, entry_ids: string[],
  new_facts: number, linked_sources: number, index_status: 'queued' | 'reused', duplicate: boolean,
}

/** Only exact, equally scoped and equally qualified assertions are coalesced. Semantic changes stay explicit. */
export async function recordDeclaration(database: Pool | PoolClient, input: RecordDraft, rawEvidence: Evidence, config: Config): Promise<DeclarationReceipt> {
  const draft = recordDraftSchema.parse(input), evidence = evidenceSchema.parse(rawEvidence)
  if (draft.evidence_id !== evidence.id) throw new Error('声明与证据回执不一致')
  parseExtraction(JSON.stringify(draft.extraction), evidence.submission)
  if (!config.embedding.space) throw new Error('声明已保留；需要配置 Embedding 向量空间后投递')
  const id = declarationId(draft)
  return transaction(database, async client => {
    // ponytail: declarations contain at most three facts; serialize this local write boundary before considering per-fingerprint locks.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('jt_memo:declarations',0))")
    const prior = (await client.query<{ result: DeclarationReceipt }>('SELECT result FROM jt_memo.declaration_receipts WHERE id=$1', [id])).rows[0]
    if (prior) return { ...prior.result, duplicate: true }
    const facts: { fact: Fact, collection: 'memories' | 'proposals', index: number }[] = [
      ...draft.extraction.memories.map((fact, index) => ({ fact, collection: 'memories' as const, index })),
      ...draft.extraction.proposals.map((fact, index) => ({ fact, collection: 'proposals' as const, index })),
    ]
    const fresh: Extraction = { schema_version: 1, memories: [], proposals: [], revisions: draft.extraction.revisions }
    const targets: { entryId?: string, collection: 'memories' | 'proposals', index: number }[] = []
    const fingerprints = new Map<string, number>()
    const memoryIndexes = new Map<number, number>()
    for (const { fact, collection, index } of facts) {
      const changed = collection === 'memories' && draft.changes.some(change => change.current_memory_index === index)
      const metadata = entryMetadata(fact, evidence.submission)
      const fingerprint = JSON.stringify([collection, fact.content, fact.basis, fact.scope, metadata.entities.toSorted(), metadata.valid_from, metadata.valid_until])
      const same = changed ? undefined : fingerprints.get(fingerprint)
      if (same !== undefined) { targets.push(targets[same]); continue }
      const match = changed || fact.scope === 'unspecified' ? undefined : (await client.query<{ id: string }>(`
        SELECT e.id FROM jt_memo.entry_states e JOIN jt_memo.entries locked_entry ON locked_entry.id=e.id
        WHERE e.content_sha256=$1 AND e.content=$2 AND e.collection=$3 AND e.basis=$4 AND e.scope=$5
          AND e.valid_from IS NOT DISTINCT FROM $6::timestamptz AND e.valid_until IS NOT DISTINCT FROM $7::timestamptz
          AND e.entities @> $8::text[] AND e.entities <@ $8::text[] AND NOT e.archived AND e.claim_status<>'rejected'
          AND (($5='project' AND e.project_ids @> $9::text[] AND e.project_ids <@ $9::text[])
            OR ($5='business' AND e.business_ids @> $10::text[] AND e.business_ids <@ $10::text[])
            OR ($5='current_task' AND e.source_session_id=$11) OR $5='user')
          AND ((e.state IN ('active','conflicted','scheduled') AND EXISTS (SELECT 1 FROM jt_memo.embeddings v WHERE v.entry_id=e.id AND v.space_id=$12))
            OR (e.state='pending' AND EXISTS (SELECT 1 FROM jt_memo.jobs j WHERE j.id=e.submission_id AND j.kind='index' AND j.status IN ('queued','running') AND j.execution->'space'->>'id'=$12)))
        ORDER BY e.received_at,e.id LIMIT 1 FOR UPDATE OF locked_entry
      `, [sha256(fact.content), fact.content, collection, fact.basis, fact.scope, metadata.valid_from, metadata.valid_until, metadata.entities,
        evidence.submission.scope.project_ids, evidence.submission.scope.business_ids, evidence.submission.source.session_id, config.embedding.space!.id])).rows[0]
      fingerprints.set(fingerprint, targets.length)
      if (match) { targets.push({ entryId: match.id, collection, index: 0 }); continue }
      const position = fresh[collection].length
      targets.push({ collection, index: position })
      if (collection === 'memories') { memoryIndexes.set(index, position); fresh.memories.push(fact as Extraction['memories'][number]) }
      else fresh.proposals.push(fact as Extraction['proposals'][number])
    }
    let jobId: string | null = null
    let entryIds: string[] = []
    if (fresh.memories.length || fresh.proposals.length || fresh.revisions.length) {
      const reduced: RecordDraft = { ...draft, extraction: fresh, changes: draft.changes.map(change => ({ ...change,
        current_memory_index: change.current_memory_index === null ? null : memoryIndexes.get(change.current_memory_index)!,
      })) }
      await recordMemories(client, reduced, evidence, config)
      jobId = recordId(reduced)
      entryIds = (await client.query<{ id: string }>('SELECT id FROM jt_memo.entries WHERE submission_id=$1 ORDER BY position', [jobId])).rows.map(row => row.id)
    }
    const entries = targets.map(target => target.entryId ?? entryIds[target.index + (target.collection === 'proposals' ? fresh.memories.length : 0)])
    const result: DeclarationReceipt = { status: 'accepted', declaration_id: id, submission_id: jobId, entry_ids: entries,
      new_facts: entryIds.length, linked_sources: entries.length - entryIds.length, index_status: jobId ? 'queued' : 'reused', duplicate: false }
    await client.query('INSERT INTO jt_memo.declaration_receipts(id,draft,evidence,result) VALUES ($1,$2,$3,$4)', [id, draft, evidence, result])
    for (const [position, entryId] of entries.entries()) await client.query('INSERT INTO jt_memo.declaration_sources(declaration_id,position,entry_id,source_message_ids) VALUES ($1,$2,$3,$4)', [id, position, entryId, facts[position].fact.source_message_ids])
    return result
  })
}

/** One transaction commits the immutable candidate and its index-only outbox job. */
export async function recordMemories(database: Pool | PoolClient, input: RecordDraft, rawEvidence: Evidence, config: Config) {
  const draft = recordDraftSchema.parse(input)
  const evidence = evidenceSchema.parse(rawEvidence)
  if (draft.evidence_id !== evidence.id) throw new Error('候选引用的证据回执不一致')
  const submission = submissionSchema.parse({ ...evidence.submission, submission_id: recordId(draft) })
  const extraction = parseExtraction(JSON.stringify(draft.extraction), submission)
  if (!config.embedding.space) throw new Error('需要配置 Embedding 模型和向量空间；材料仍保留在本地待投递区')
  const execution = { envFile: config.envFile, dataDir: config.dataDir, space: config.embedding.space }
  return transaction(database, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [submission.submission_id])
    const existing = await client.query('SELECT id,status,kind,content_hash FROM jt_memo.jobs WHERE id=$1', [submission.submission_id])
    if (existing.rows[0]) {
      if (existing.rows[0].kind !== 'index' || existing.rows[0].content_hash !== sha256(JSON.stringify(submission))) throw new MemoStorageError('SUBMISSION_CONFLICT', '该提交 ID 已绑定其他来源材料')
      return { status: 'accepted', submission_id: submission.submission_id, index_status: existing.rows[0].status, duplicate: true }
    }
    const ids = [...new Set(draft.changes.map(change => change.previous_entry_id))].sort()
    await client.query('SELECT id FROM jt_memo.entries WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
    for (const change of draft.changes) {
      if (change.expected_version !== await entryVersion(client, change.previous_entry_id)) throw new MemoStorageError('VERSION_CONFLICT', '旧记忆版本已变化；请重新 read 后提交，未修改旧事实')
    }
    const storage = new MemoStorage(client)
    const stored = await storage.store({ submission, extraction, run: evidence.run })
    const saved = await storage.getSubmission(submission.submission_id)
    const relations = draft.changes.map(({ current_memory_index, expected_version, ...change }) => {
      if (current_memory_index !== null && current_memory_index >= extraction.memories.length) throw new Error('current_memory_index 必须引用本批 memories 中的条目')
      return relationSchema.parse({ ...change, current_entry_id: current_memory_index === null ? null : stored.entry_ids[current_memory_index] })
    })
    const previous = ids.length ? (await client.query('SELECT * FROM jt_memo.entry_states WHERE id=ANY($1::uuid[])', [ids])).rows : []
    validateRelations(relations, previous, saved.entries, submission, extraction)
    const plan = { relations, expected_versions: Object.fromEntries(draft.changes.map(change => [change.previous_entry_id, change.expected_version])) }
    await client.query(`INSERT INTO jt_memo.jobs(id,content_hash,payload,execution,kind,record_plan)
      VALUES ($1,$2,$3,$4,'index',$5)`, [submission.submission_id, sha256(JSON.stringify(submission)), submission, execution, plan])
    return { ...stored, status: 'accepted', index_status: 'queued', duplicate: false }
  })
}
