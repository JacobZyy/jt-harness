import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { extractMemories } from '../agents/extract.ts'
import { reconcileMemories } from '../agents/reconcile.ts'
import { loadConfig, safeError } from '../config.ts'
import type { Config } from '../config.ts'
import { MemoStorageError } from './contract.ts'
import { embedTexts } from './embedding.ts'
import type { Job } from './jobs.ts'
import { MemoStorage } from './storage.ts'
import { findRelatedEntries, readRelations } from './revision-storage.ts'
import { retainAgentOutputs } from './agent-outputs.ts'

/** Resume at the last committed stage; never rerun extraction after it has been stored. */
export async function processJob(client: PoolClient, job: Job, config: Config, signal?: AbortSignal, extract = extractMemories, compare = reconcileMemories) {
  const storage = new MemoStorage(client)
  let saved
  try { saved = await storage.getSubmission(job.id) } catch (error) {
    if (!(error instanceof MemoStorageError) || error.code !== 'NOT_FOUND') throw error
  }
  const committed = saved?.index_receipts.find(receipt => receipt.space_id === job.execution.space.id)
  if (committed) return committed
  if (config.embedding.space?.id !== job.execution.space.id) {
    throw new Error('Embedding 地址、模型或维度已改变；恢复本任务原配置再 retry，避免混用向量空间')
  }
  if (!saved) {
    const result = await extract(job.payload, job.execution.agent, { workspace: resolve(job.execution.dataDir, 'agent-workspace'), signal,
      ...retainAgentOutputs(client, job.id, 'extraction') })
    const { schema_version, memories, proposals, revisions, run, issues } = result
    signal?.throwIfAborted()
    await storage.store({ submission: job.payload, extraction: { schema_version, memories, proposals, revisions }, run, intake_issues: issues })
    saved = await storage.getSubmission(job.id)
  }
  const vectors = await embedTexts(saved.entries.map(entry => entry.content), config.embedding, signal)
  const revisionVectors = await embedTexts(saved.extraction.revisions.map(revision => revision.earlier_content), config.embedding, signal)
  const previous = await findRelatedEntries(client, saved.submission, job.execution.space.id, [
    ...saved.entries.flatMap((entry, index) => entry.collection === 'memories' ? [{ vector: vectors[index], scope: entry.scope }] : []),
    ...revisionVectors.map(vector => ({ vector, scope: null })),
  ])
  const decision = previous.length > 0 ? await compare({
    submission: saved.submission, extraction: saved.extraction,
    current_entries: saved.entries.filter(entry => entry.collection === 'memories'), previous_entries: previous,
    previous_conflicts: (await readRelations(client, previous.map(entry => entry.id))).relations.filter(relation => relation.unresolved).map(relation => ({
      id: relation.id, previous_entry_id: relation.previous_entry_id, current_entry_id: relation.current_entry_id,
      previous_content: relation.previous_content, current_content: relation.current_content, revision: relation.revision,
    })),
  }, job.execution.agent, { workspace: resolve(job.execution.dataDir, 'agent-workspace'), signal,
    ...retainAgentOutputs(client, job.id, 'reconciliation') }) : undefined
  signal?.throwIfAborted()
  return storage.index({
    submission_id: job.id,
    space: job.execution.space,
    embeddings: saved.entries.map((entry, index) => ({ entry_id: entry.id, content_sha256: entry.content_sha256, vector: vectors[index] })),
    relations: decision?.relations ?? [],
    reconciliation_run: decision?.run,
    intake_issues: decision?.issues,
  })
}

/**
 * The same PostgreSQL session owns the worker lock AND every write. If that
 * connection dies, the old worker cannot publish after another worker takes over.
 */
export async function runWorker(pool: Pool, root: string, signal?: AbortSignal, compare = reconcileMemories) {
  const client = await pool.connect()
  const controller = new AbortController()
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
  let released = false
  const dispose = () => {
    if (!released) { released = true; client.release(true) }
  }
  const lostConnection = () => controller.abort(new Error('记忆数据库连接中断；任务保留，使用 memo work 恢复'))
  client.on('error', lostConnection)
  combined.addEventListener('abort', dispose, { once: true })
  let completed = 0
  let partial = 0
  let failed = 0
  try {
    combined.throwIfAborted()
    // ponytail: one worker per database. Keep writes on this session; partition
    // queues only if measured throughput outgrows personal local use.
    // Wait instead of exiting on contention: an enqueue during worker shutdown
    // must still have a consumer after the current worker releases the lock.
    await client.query('SET statement_timeout = 0')
    await client.query("SELECT pg_advisory_lock(hashtextextended('jt_memo:worker', 0))")
    await client.query('SET statement_timeout = 15000')
    await client.query("UPDATE jt_memo.jobs SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE status = 'running' AND kind='legacy'")
    while (!combined.aborted) {
      const result = await client.query<Job>(`
        UPDATE jt_memo.jobs SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = (SELECT id FROM jt_memo.jobs WHERE status = 'queued' AND kind='legacy' ORDER BY created_at, id LIMIT 1)
        RETURNING id, payload, execution
      `)
      const job = result.rows[0]
      if (!job) break
      let config: Config | undefined
      try {
        config = await loadConfig(root, job.execution.envFile)
        await mkdir(job.execution.dataDir, { recursive: true, mode: 0o700 })
        const receipt = await processJob(client, job, config, combined, extractMemories, compare)
        const status = receipt.status === 'partial' ? 'partial' : 'complete'
        await client.query('UPDATE jt_memo.jobs SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [job.id, status])
        if (status === 'partial') partial++
        else completed++
      } catch (error) {
        combined.throwIfAborted()
        await client.query("UPDATE jt_memo.jobs SET status = 'failed', error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [job.id, safeError(error, config)])
        failed++
      }
    }
    combined.throwIfAborted()
    return { completed, partial, failed }
  } finally {
    client.off('error', lostConnection)
    combined.removeEventListener('abort', dispose)
    // Closing this dedicated connection releases the session advisory lock.
    dispose()
  }
}
