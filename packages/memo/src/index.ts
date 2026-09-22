import { Pool } from 'pg'
import type { Config } from './config.ts'
import { safeError as databaseError } from './config.ts'
export function openDatabase(config: Config, fast = false) {
  if (!config.databaseUrl) throw new Error('请在 .env 配置 JTH_DATABASE_URL')
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: fast ? 200 : 3000, statement_timeout: fast ? 500 : 15000, application_name: 'jth-memo' })
  pool.on('error', error => process.stderr.write(JSON.stringify({ database_error: databaseError(error, config) }) + '\n'))
  return pool
}
export type { Pool } from 'pg'
export type { Job } from './storage/jobs.ts'
export async function withIntakeLock<T>(pool: Pool, operation: () => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('jt_memo:codex-capture',0))")
    return await operation()
  } finally { client.release(true) }
}
export { loadConfig, executionProfile, safeError } from './config.ts'
export type { Config } from './config.ts'
export * from './public-contracts.ts'
export { prepareDatabase, transaction, schemaVersion } from './storage/database.ts'
export { readAgentOutputs } from './storage/agent-outputs.ts'
export { readIntakeRecovery, recoverIntake } from './storage/recovery.ts'
export { MemoStorage } from './storage/storage.ts'
export { enqueue, jobStatus, retryJob } from './storage/jobs.ts'
export { embedTexts } from './storage/embedding.ts'
export { listManagedEntries, manageEntry, storageStats } from './storage/management.ts'
export { storageDoctor } from './storage/doctor.ts'
export { recordMemories, recordDeclaration } from './record.ts'
export { runIndexWorker, processIndexJob } from './index-worker.ts'
export { readMemory } from './reading.ts'
export { memoryUses } from './usage.ts'
