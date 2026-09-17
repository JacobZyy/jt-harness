import { evidenceSchema, recordDraftSchema, recordId } from './record-contract.ts'
import type { Evidence, RecordDraft } from './record-contract.ts'
import type { Pool, PoolClient } from 'pg'
import { parseExtraction, submissionSchema } from './contracts.ts'
import type { Submission } from './contracts.ts'
import type { Config } from './config.ts'
import { MemoStorageError, sha256 } from './storage/contract.ts'
import { relationSchema, validateRelations } from './storage/relations.ts'
import { MemoStorage } from './storage/storage.ts'
import { transaction } from './storage/database.ts'
import { entryVersion } from './version.ts'

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
