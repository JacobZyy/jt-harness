import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { captureEvent } from '@jt-harness/codex-hooks'

if (!process.argv.includes('--live')) throw new Error('真实 Embedding / PostgreSQL 验收仅允许显式 --live；使用隔离的合成来源项目')
const root = fileURLToPath(new URL('../', import.meta.url))
const project = `jth-inline-check-${Date.now()}`
const directory = resolve(root, 'artifacts/jth', project)
const home = resolve(directory, 'codex'), dataDir = resolve(directory, 'data')
await mkdir(resolve(home, 'sessions'), { recursive: true, mode: 0o700 })
const execute = promisify(execFile)
const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.ts'), 'memo', ...args], {
  cwd: root, timeout: 70_000, maxBuffer: 2_000_000,
  // An inaccessible DSH executable proves the normal write/index path does not launch it.
  env: { ...process.env, JTH_DATA_DIR: dataDir, JTH_DSH_BIN: '/nonexistent/jth-no-dsh' },
})).stdout)
const timestamp = new Date().toISOString()
const source = resolve(home, 'sessions', `rollout-${project}.jsonl`)
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload }) + '\n'
await writeFile(source, row('session_meta', { id: project }) + row('event_msg', {
  type: 'item_completed', thread_id: project,
  item: { id: 'synthetic-user-1', type: 'UserMessage', content: [{ type: 'text', text: '一次性验收项目的请求超时为 17 秒。' }] },
}), { mode: 0o600 })
await captureEvent({ hook_event_name: 'Stop', session_id: project, cwd: directory, transcript_path: source, model: 'synthetic-fixture' },
  { workspace: directory, codex_home: home, env_file: resolve(root, '.env'), enabled_at: timestamp, scope: { project_ids: [project], business_ids: [] } }, { dataDir })
const prepared = await cli('prepare', '--session', project)
const file = resolve(directory, 'record.json')
await writeFile(file, JSON.stringify({ evidence_id: prepared.evidence_id, extraction: { schema_version: 1, memories: [{
  content: '一次性验收项目的请求超时为 17 秒。', scope: 'project', basis: 'user_statement', source_message_ids: [prepared.messages[0].message_id],
}], proposals: [], revisions: [] }, changes: [] }), { mode: 0o600 })
const start = performance.now()
const accepted = await cli('record', file)
const acceptanceMs = Math.round(performance.now() - start)
assert.equal(accepted.status, 'accepted')
assert.equal(accepted.kind, 'index')
assert.equal(accepted.extraction_run.provider, 'codex')
const stored = await cli('read', '--submission', accepted.submission_id)
assert.equal(stored.entries.length, 1)
assert.equal((await cli('record', file)).submission_id, accepted.submission_id)
let indexed
for (let attempt = 0; attempt < 70; attempt++) {
  indexed = await cli('status', accepted.submission_id)
  if (indexed.status === 'complete' || indexed.status === 'failed') break
  await setTimeout(1000)
}
assert.equal(indexed.status, 'complete', indexed.error)
const indexingMs = Math.round(performance.now() - start)
assert.equal(indexed.agent, null)
assert.equal(indexed.reconciliation_run, null)
assert.equal(indexed.entry_count, 1)
const found = await cli('search', '请求超时是多少秒', '--project', project)
assert.equal(found.entries[0].id, stored.entries[0].id)
assert.equal((await cli('doctor')).ok, true)
await cli('archive', stored.entries[0].id, '--reason', '隔离的合成来源验收已完成')
const report = { project, source: 'synthetic Codex JSONL fixture; not an end-to-end native hook event',
  submission_id: accepted.submission_id, entry_id: stored.entries[0].id, receipt_id: indexed.index_receipt_id,
  acceptance_ms: acceptanceMs, indexed_after_ms: indexingMs, embedding_model: indexed.embedding_space.model,
  dimensions: indexed.embedding_space.dimensions, dsh_executable: 'inaccessible throughout verification',
  duplicate: 'same submission and entry', vector_search: 'matched', cleanup: 'test entry archived', verified_at: new Date().toISOString() }
await writeFile(resolve(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
