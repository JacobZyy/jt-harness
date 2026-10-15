import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Pool, PoolClient } from 'pg'
import type { Config } from './config.ts'
import type { IndexWriteUsage } from './write-usage.ts'
import { MemoStorage } from './storage/storage.ts'
import { processIndexJob, runIndexWorker } from './index-worker.ts'

test('index retries keep independent write usage records without changing queue or vector contracts', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'jth-index-usage-'))
  const space = { id: 'test', provider: 'test', model: 'test', dimensions: 2, input_version: 'content-v1' as const }
  const config = { dataDir, embedding: { baseUrl: 'https://example.invalid/v1', apiKey: 'test-only', timeoutMs: 200, space } } as Config
  const job = { id: 'declaration-test', execution: { dataDir, envFile: resolve(dataDir, '.env'), space }, record_plan: { relations: [], expected_versions: {} } }
  const originalFetch = globalThis.fetch
  const getSubmission = MemoStorage.prototype.getSubmission, index = MemoStorage.prototype.index
  const entry = { id: '11111111-1111-4111-8111-111111111111', content: 'fact', content_sha256: 'a'.repeat(64) }
  let succeed = false, indexCalls = 0
  MemoStorage.prototype.getSubmission = async () => ({ entries: [entry], index_receipts: [] }) as unknown as Awaited<ReturnType<typeof getSubmission>>
  MemoStorage.prototype.index = async input => {
    indexCalls++
    assert.deepEqual(input.embeddings, [{ entry_id: entry.id, content_sha256: entry.content_sha256, vector: [1, Math.fround(0.1)] }])
    return { id: 'index-test', space_id: space.id, status: 'indexed' } as Awaited<ReturnType<typeof index>>
  }
  globalThis.fetch = (async () => succeed
    ? Response.json({ model: 'test', data: [{ index: 0, embedding: [1, 0.1] }], usage: { prompt_tokens: 5, total_tokens: 5 } })
    : Response.json({}, { status: 429 })) as typeof fetch
  try {
    await assert.rejects(processIndexJob({} as PoolClient, { ...job, attempts: 1 }, config), /HTTP 429/)
    succeed = true
    assert.equal((await processIndexJob({} as PoolClient, { ...job, attempts: 2 }, config)).status, 'indexed')
    const files = await readdir(resolve(dataDir, 'codex/write-usage'))
    const records: IndexWriteUsage[] = await Promise.all(files.map(async file => JSON.parse(await readFile(resolve(dataDir, 'codex/write-usage', file), 'utf8'))))
    records.sort((a, b) => a.job_attempt! - b.job_attempt!)
    assert.deepEqual(records.map(record => [record.job_attempt, record.status]), [[1, 'failed'], [2, 'indexed']])
    assert.equal(records[0].embedding_attempts[0].usage.prompt_tokens, null)
    assert.equal(records[1].embedding_attempts[0].usage.prompt_tokens, 5)
    assert.equal(records[1].embedding_attempts[0].entry_id, entry.id)
    assert.equal(records[1].declaration_tokens, null)
    assert.equal(records[1].background_extraction_model_calls, 0)
    assert(!JSON.stringify(records).includes(config.embedding.apiKey!))
    assert(!JSON.stringify(records).includes('"content":'))
    assert.equal(indexCalls, 1)
    const warnings: string[] = [], originalError = console.error
    await writeFile(resolve(dataDir, 'blocked'), 'not a directory')
    console.error = value => { warnings.push(String(value)) }
    try {
      const unavailableLogJob = { ...job, attempts: 3, execution: { ...job.execution, dataDir: resolve(dataDir, 'blocked') } }
      assert.equal((await processIndexJob({} as PoolClient, unavailableLogJob, config)).status, 'indexed')
      assert(warnings.some(warning => warning.includes('不会改变索引结果')))
    } finally { console.error = originalError }
  } finally {
    globalThis.fetch = originalFetch
    MemoStorage.prototype.getSubmission = getSubmission
    MemoStorage.prototype.index = index
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a failed configuration load leaves a write attempt record before the unchanged queue failure update', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'jth-index-config-'))
  let dequeued = false
  const statements: string[] = []
  const client = { on() {}, off() {}, release() {}, async query(statement: string) {
    statements.push(statement)
    if (statement.includes('RETURNING id,execution,record_plan,attempts') && !dequeued) {
      dequeued = true
      return { rows: [{ id: 'declaration-config', attempts: 4, execution: { dataDir, envFile: resolve(dataDir, '.env'), space: { id: 'test' } }, record_plan: {} }] }
    }
    return { rows: [] }
  } }
  const pool = { async connect() { return client } } as unknown as Pool
  try {
    assert.deepEqual(await runIndexWorker(pool, async () => { throw new Error('invalid configuration') }), { completed: 0, failed: 1 })
    const files = await readdir(resolve(dataDir, 'codex/write-usage'))
    const record: IndexWriteUsage = JSON.parse(await readFile(resolve(dataDir, 'codex/write-usage', files[0]), 'utf8'))
    assert.equal(record.job_attempt, 4)
    assert.equal(record.status, 'failed')
    assert.equal(record.error, 'invalid configuration')
    assert.deepEqual(record.embedding_attempts, [])
    assert(statements.some(statement => statement.includes("SET status='failed',error=$2")))
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})
