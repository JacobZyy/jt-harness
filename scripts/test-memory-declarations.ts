import assert from 'node:assert/strict'
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { Pool } from 'pg'
import { loadConfig, prepareDatabase, MemoStorage, runIndexWorker, retryJob, enqueue, executionProfile, storageDoctor } from '@jt-harness/memo'
import { captureDeclaration, rememberEntryRead } from '@jt-harness/codex-hooks'
import { receiveRecords } from '../packages/cli/src/ingest.ts'

const { values } = parseArgs({ options: { 'env-file': { type: 'string' } } })
assert(values['env-file'] && process.env.JTH_TEST_DATABASE_URL, 'Use test-postgres.mjs --declaration-live --env-file ...')
const configured = await loadConfig(process.cwd(), values['env-file'])
const runId = new Date().toISOString().replaceAll(':', '-')
const directory = resolve('artifacts/declaration-verification', runId), home = resolve(directory, 'codex')
await mkdir(resolve(home, 'sessions'), { recursive: true, mode: 0o700 })
const config = { ...configured, databaseUrl: process.env.JTH_TEST_DATABASE_URL, dataDir: resolve(directory, 'data'), agent: { ...configured.agent, dshBin: '/must-not-run-dsh' } }
const hooksPath = resolve(dirname(configured.envFile), '.codex/hooks.json'), hooksBefore = await readFile(hooksPath, 'utf8')
const pool = new Pool({ connectionString: config.databaseUrl }), storage = new MemoStorage(pool)
const sourceFile = resolve(home, 'sessions/manual.jsonl')
const settings = { workspace: directory, codex_home: home, env_file: config.envFile, enabled_at: '2026-01-01T00:00:00Z', scope: { project_ids: ['declaration-manual'], business_ids: [] } }
const row = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n'
await writeFile(sourceFile, row('session_meta', { id: 'declaration-manual-session' }))
const save = (name: string, value: unknown) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const originalFetch = globalThis.fetch
let failNext = false, sequence = 0, injectedFailures = 0
const requests: { characters: number, usage: unknown }[] = []
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), `${config.embedding.baseUrl}/embeddings`, 'Only Embedding requests are allowed')
  const body = JSON.parse(String(init?.body))
  assert(body.input.every((text: string) => Array.from(text).length <= 500))
  if (failNext) { failNext = false; injectedFailures++; return Response.json({}, { status: 503 }) }
  const response = await originalFetch(url, init)
  const payload = await response.clone().json().catch(() => ({})) as { usage?: unknown }
  requests.push({ characters: body.input.reduce((sum: number, text: string) => sum + Array.from(text).length, 0), usage: payload.usage ?? null })
  return response
}
const capture = (text: string) => captureDeclaration({ hook_event_name: 'Stop', session_id: 'declaration-manual-session', cwd: directory, transcript_path: sourceFile, last_assistant_message: text }, settings, config)
const declare = async (text: string, change?: object) => {
  sequence++
  const answer = `<!-- jth-memory ${JSON.stringify({ items: [{ text, scope: 'project', basis: 'user_statement', quote: text, ...(change ? { change } : {}) }] })} -->`
  await appendFile(sourceFile, row('event_msg', { type: 'item_completed', thread_id: 'declaration-manual-session', item: { type: 'UserMessage', id: `u${sequence}`, content: [{ type: 'text', text }] } })
    + row('event_msg', { type: 'item_completed', thread_id: 'declaration-manual-session', item: { type: 'AgentMessage', id: `a${sequence}`, content: [{ type: 'text', text: answer }] } }))
  await capture(answer)
  return answer
}
const receive = async () => {
  const result = await receiveRecords(pool, config)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.declaration_errors, [])
  return result.accepted as { declaration_id: string, submission_id: string | null, entry_ids: string[], new_facts: number, linked_sources: number }[]
}
const work = () => runIndexWorker(pool, async () => config)
const cases: object[] = []
try {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'jth_test')
  await prepareDatabase(pool, true)
  assert.equal(await capture('任务完成，无新增长期事实。'), null)
  assert.equal((await receive()).length, 0)
  assert.equal(requests.length, 0)
  cases.push({ name: 'no-declaration', passed: true, embeddingCalls: 0 })

  const answer = await declare('项目使用 pnpm 管理依赖。')
  await capture(answer)
  const [initial] = await receive()
  assert.equal((await work()).completed, 1)
  assert.equal(requests.length, 1)
  const first = await storage.getEntry(initial.entry_ids[0])
  assert.equal(first.state, 'active')
  cases.push({ name: 'new-and-repeated-stop', passed: true, receipt: initial, embeddingCalls: 1 })

  await declare('项目使用 pnpm 管理依赖。')
  const [duplicate] = await receive()
  assert.equal(duplicate.new_facts, 0)
  assert.deepEqual(duplicate.entry_ids, initial.entry_ids)
  assert.equal((await work()).completed, 0)
  assert.equal(requests.length, 1)
  assert.equal((await storage.getEntry(first.id)).additional_sources.length, 1)
  cases.push({ name: 'cross-turn-exact-duplicate', passed: true, receipt: duplicate, embeddingCalls: 0 })

  await rememberEntryRead(config, 'declaration-manual-session', first.id, first.version!)
  await declare('明确更正：项目改用 npm，之前的 pnpm 约定作废。', { kind: 'correction', target: first.id })
  const [correction] = await receive()
  assert.equal((await work()).completed, 1)
  assert.equal((await storage.getEntry(first.id)).state, 'superseded')
  assert.equal((await storage.getEntry(correction.entry_ids[0])).state, 'active')
  cases.push({ name: 'explicit-correction', passed: true, receipt: correction, embeddingCalls: 1 })

  await declare('请求超时为 17 秒。')
  const [recovery] = await receive()
  const saved = await storage.getSubmission(recovery.submission_id!)
  await enqueue(pool, { ...saved.submission, submission_id: 'untouched-legacy-job' }, executionProfile(config))
  failNext = true
  assert.equal((await work()).failed, 1)
  await retryJob(pool, recovery.submission_id!)
  assert.equal((await work()).completed, 1)
  assert.deepEqual((await storage.getSubmission(recovery.submission_id!)).submission, saved.submission)
  assert.equal((await pool.query("SELECT status FROM jt_memo.jobs WHERE id='untouched-legacy-job'")).rows[0].status, 'queued')
  cases.push({ name: 'embedding-failure-and-recovery', passed: true, receipt: recovery, injectedFailures: 1, embeddingCalls: 1 })

  assert.equal((await pool.query('SELECT count(*)::int AS count FROM jt_memo.agent_outputs')).rows[0].count, 0)
  const doctor = await storageDoctor(pool)
  assert.equal(doctor.ok, true)
  assert.equal(await readFile(hooksPath, 'utf8'), hooksBefore)
  assert.deepEqual(JSON.parse(hooksBefore).hooks, {})
  const report = { runId, directory, cases, networkEmbeddingCalls: requests.length, requests, injectedFailures,
    dshCalls: 0, productionHooksUnchanged: true, productionQueueUntouched: true, isolatedDatabase: true,
    fixtureDeclarations: true, doctor }
  await save('report.json', report)
  console.log(JSON.stringify(report))
} catch (error) {
  await save('failure.json', { error: String(error), cases, requests, injectedFailures })
  console.error(JSON.stringify({ directory, error: String(error) }))
  process.exitCode = 1
} finally { globalThis.fetch = originalFetch; await pool.end() }
