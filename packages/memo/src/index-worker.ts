import type { Pool, PoolClient } from 'pg'
import type { Config } from './config.ts'
import { safeError } from './config.ts'
import { embedTexts } from './storage/embedding.ts'
import { MemoStorage } from './storage/storage.ts'
import type { EmbeddingSpace } from './storage/contract.ts'
import type { Relation } from './storage/relations.ts'
import { randomUUID } from 'node:crypto'
import { persistIndexWriteUsage } from './write-usage.ts'
import type { IndexWriteUsage } from './write-usage.ts'

interface IndexJob {
  id: string
  attempts?: number
  execution: { envFile: string, dataDir: string, space: EmbeddingSpace }
  record_plan: { relations: Relation[], expected_versions: Record<string, string> }
}

function indexWriteUsage(job: IndexJob, startedAt = new Date().toISOString()): IndexWriteUsage {
  return { version: 1, id: randomUUID(), submission_id: job.id, job_attempt: job.attempts ?? null, space_id: job.execution.space.id,
    started_at: startedAt, completed_at: null, status: 'running', error: null,
    background_extraction_model_calls: 0, background_extraction_input_tokens: 0, background_extraction_output_tokens: 0, declaration_tokens: null, embedding_attempts: [] }
}

export async function processIndexJob(client: PoolClient, job: IndexJob, config: Config, signal?: AbortSignal) {
  const usage = indexWriteUsage(job)
  await persistIndexWriteUsage(job.execution.dataDir, usage)
  try {
    const storage = new MemoStorage(client)
    const saved = await storage.getSubmission(job.id)
    const published = saved.index_receipts.find(receipt => receipt.space_id === job.execution.space.id)
    if (published) { usage.status = 'already_indexed'; return published }
    if (config.embedding.space?.id !== job.execution.space.id) throw new Error('向量空间已变化；请恢复本任务的 Embedding 配置')
    const vectors = await embedTexts(saved.entries.map(entry => entry.content), config.embedding, signal, async attempt => {
      usage.embedding_attempts.push({ ...attempt, entry_id: saved.entries[attempt.text_index].id })
      await persistIndexWriteUsage(job.execution.dataDir, usage)
    })
    signal?.throwIfAborted()
    const receipt = await storage.index({ submission_id: job.id, space: job.execution.space,
      embeddings: saved.entries.map((entry, index) => ({ entry_id: entry.id, content_sha256: entry.content_sha256, vector: vectors[index] })),
      relations: job.record_plan.relations, expected_versions: job.record_plan.expected_versions,
    })
    usage.status = 'indexed'
    return receipt
  } catch (error) {
    usage.status = 'failed'
    usage.error = safeError(error, config)
    throw error
  } finally {
    usage.completed_at = new Date().toISOString()
    await persistIndexWriteUsage(job.execution.dataDir, usage)
  }
}

/** This worker never imports or invokes an extraction/comparison model. */
export async function runIndexWorker(pool: Pool, resolveConfig: (envFile: string) => Promise<Config>, signal?: AbortSignal) {
  const client = await pool.connect()
  const controller = new AbortController()
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
  let released = false
  const dispose = () => { if (!released) { released = true; client.release(true) } }
  const lost = (error: Error) => controller.abort(error)
  client.on('error', lost)
  combined.addEventListener('abort', dispose, { once: true })
  let completed = 0, failed = 0
  try {
    combined.throwIfAborted()
    await client.query('SET statement_timeout=0')
    await client.query("SELECT pg_advisory_lock(hashtextextended('jt_memo:index-worker',0))")
    await client.query('SET statement_timeout=15000')
    await client.query("UPDATE jt_memo.jobs SET status='queued',updated_at=CURRENT_TIMESTAMP WHERE kind='index' AND status='running'")
    while (!combined.aborted) {
      const result = await client.query<IndexJob>(`UPDATE jt_memo.jobs SET status='running',attempts=attempts+1,error=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id=(SELECT id FROM jt_memo.jobs WHERE kind='index' AND status='queued' ORDER BY created_at,id LIMIT 1) RETURNING id,execution,record_plan,attempts`)
      const job = result.rows[0]
      if (!job) break
      const startedAt = new Date().toISOString()
      let config: Config | undefined
      try {
        config = await resolveConfig(job.execution.envFile)
        await processIndexJob(client, job, config, combined)
        await client.query("UPDATE jt_memo.jobs SET status='complete',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [job.id])
        completed++
      } catch (error) {
        if (!config) {
          const usage = indexWriteUsage(job, startedAt)
          usage.status = 'failed'
          usage.error = safeError(error)
          usage.completed_at = new Date().toISOString()
          await persistIndexWriteUsage(job.execution.dataDir, usage)
        }
        combined.throwIfAborted()
        await client.query("UPDATE jt_memo.jobs SET status='failed',error=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1", [job.id, safeError(error, config)])
        failed++
      }
    }
    combined.throwIfAborted()
    return { completed, failed }
  } finally { client.off('error', lost); combined.removeEventListener('abort', dispose); dispose() }
}
