import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeError } from './config.ts'
import { sha256 } from './storage/contract.ts'
import type { EmbeddingAttempt } from './storage/embedding.ts'

export interface IndexWriteUsage {
  version: 1
  id: string
  submission_id: string
  job_attempt: number | null
  space_id: string
  started_at: string
  completed_at: string | null
  status: 'running' | 'indexed' | 'already_indexed' | 'failed'
  error: string | null
  background_extraction_model_calls: 0
  background_extraction_input_tokens: 0
  background_extraction_output_tokens: 0
  declaration_tokens: null
  embedding_attempts: (EmbeddingAttempt & { entry_id: string })[]
}

/** Usage is operational evidence, outside the knowledge database. Logging failure cannot undo indexing. */
export async function persistIndexWriteUsage(dataDir: string, usage: IndexWriteUsage) {
  const path = resolve(dataDir, 'codex', 'write-usage', `${sha256(usage.submission_id)}-${usage.id}.json`)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(usage, null, 2)}\n`); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  } catch (error) {
    console.error(`JTH 单次写入用量记录失败；不会改变索引结果：${safeError(error)}`)
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') console.error(`JTH 用量临时文件清理失败：${safeError(error)}`) })
  }
}
