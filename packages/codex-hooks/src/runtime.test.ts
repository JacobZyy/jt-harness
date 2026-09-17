import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadConfig } from '@jt-harness/memo/config'
import { captureEvent, captureStatus, hookEvents } from './capture.ts'
import { configureHooks, mergeHooks } from './install.ts'
import { prepareEvidence, readEvidence, stageRecord, registerCaptures, deliverRecords } from './evidence.ts'
import { startInstructions } from './instructions.ts'

const timestamp = '2026-09-17T00:00:00.000Z'
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload }) + '\n'
const message = (thread: string, id: string, type: string, text: string) => row('event_msg', { type: 'item_completed', thread_id: thread, item: { id, type, content: [{ type: 'text', text }] } })
async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-inline-hooks-'))
  const home = resolve(directory, 'codex'), dataDir = resolve(directory, 'data'), envFile = resolve(directory, '.env')
  await mkdir(resolve(home, 'sessions'), { recursive: true })
  await writeFile(envFile, `JTH_DATA_DIR=${dataDir}\n`)
  const settings = { workspace: directory, codex_home: home, env_file: envFile, enabled_at: timestamp, scope: { project_ids: ['test'], business_ids: [] } }
  const source = resolve(home, 'sessions/rollout-parent.jsonl')
  await writeFile(source, row('session_meta', { id: 'parent' }))
  const config = { dataDir, envFile }
  const capture = (event: typeof hookEvents[number], extra: Record<string, unknown> = {}) => captureEvent({ hook_event_name: event, session_id: 'parent', cwd: directory, transcript_path: source, model: 'test-codex', ...extra }, settings, config)
  return { directory, home, source, config, settings, capture, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('six hooks remain idempotent and preserve other tools; startup supplies the in-session protocol', async () => {
  const existing = { hooks: { Stop: [{ hooks: [{ command: 'another-tool' }] }] } }
  const installed = mergeHooks(existing, 'jth memo codex capture')
  assert.deepEqual(mergeHooks(installed, 'jth memo codex capture'), installed)
  assert.deepEqual(mergeHooks(installed), existing)
  assert.equal(Object.keys(installed.hooks).length, 6)
  const f = await fixture()
  try {
    const capture = await f.capture('SessionStart')
    assert(startInstructions(capture).includes('memo prepare --session parent'))
    assert(startInstructions(capture).includes('memo record'))
    assert.equal((await registerCaptures(f.config)).received, 1)
    assert.equal((await registerCaptures(f.config)).received, 0)
    const status = await captureStatus(f.config)
    assert.equal(status.mode, 'dsh')
    assert.equal(status.sessions[0].session_id, 'parent')
    assert.equal(status.pending_records, 0)
    assert.deepEqual((await deliverRecords(f.config, async () => { throw new Error('No implicit extraction or delivery is allowed') })).accepted, [])
  } finally { await f.cleanup() }
})

test('source previews omit tool dumps by default, record stages validated facts and survives a lost receipt', async () => {
  const f = await fixture()
  try {
    await appendFile(f.source, message('parent', 'a', 'AgentMessage', '建议请求超时设置为 17 秒。')
      + message('parent', 'u', 'UserMessage', '同意设置为 17 秒。')
      + row('event_msg', { type: 'item_completed', thread_id: 'parent', item: { id: 't', type: 'CommandExecution', command: ['test'], exit_code: 0, aggregated_output: 'large log '.repeat(10000) } }))
    await f.capture('Stop')
    const prepared = await prepareEvidence(f.config, 'parent')
    assert.deepEqual(prepared.messages.map(item => item.role), ['assistant', 'user'])
    const evidence = await readEvidence(f.config, prepared.evidence_id)
    const input = { evidence_id: prepared.evidence_id, extraction: { schema_version: 1 as const,
      memories: [{ content: '请求超时为 17 秒。', basis: 'user_confirmed' as const, scope: 'project' as const, source_message_ids: evidence.submission.messages.map(message => message.message_id) }], proposals: [], revisions: [] } }
    const first = await stageRecord(f.config, input)
    assert.deepEqual(await stageRecord(f.config, input), first)
    assert.equal((await deliverRecords(f.config, async () => { throw new Error('database offline') })).errors.length, 1)
    assert.equal((await readdir(resolve(f.config.dataDir, 'codex/records'))).length, 1)
    const delivered = await deliverRecords(f.config, async () => ({ submission_id: first.submission_id, status: 'accepted' }))
    assert.equal(delivered.accepted.length, 1)
    assert.equal((await deliverRecords(f.config, async () => { throw new Error('must not redeliver') })).accepted.length, 0)
    const forged = structuredClone(input)
    forged.extraction.memories[0].source_message_ids = ['invented']
    await assert.rejects(stageRecord(f.config, forged), /不存在/)
  } finally { await f.cleanup() }
})

test('child delegation stays assistant-authored and never imports inherited parent messages', async () => {
  const f = await fixture()
  try {
    const child = resolve(f.home, 'sessions/rollout-child.jsonl')
    await writeFile(child, row('session_meta', { id: 'child', parent_thread_id: 'parent' })
      + message('parent', 'inherited', 'UserMessage', '不要重复导入。')
      + message('child', 'delegated', 'UserMessage', '检查这条建议。'))
    await f.capture('SubagentStop', { agent_id: 'child', agent_transcript_path: child })
    const prepared = await prepareEvidence(f.config, 'child')
    assert.equal(prepared.source.parent_session_id, 'parent')
    assert.equal(prepared.messages.length, 1)
    assert.equal(prepared.messages[0].role, 'assistant')
    await assert.rejects(stageRecord(f.config, { evidence_id: prepared.evidence_id, extraction: { schema_version: 1,
      memories: [{ content: '假冒用户确认', basis: 'user_statement', scope: 'project', source_message_ids: [prepared.messages[0].message_id] }], proposals: [], revisions: [] } }), /对应角色/)
  } finally { await f.cleanup() }
})

test('partial writes wait; large evidence is paginated without clipping; pinned sources survive deletion', async () => {
  const f = await fixture()
  try {
    const text = '中文😀'.repeat(26000)
    const encoded = Buffer.from(message('parent', 'long', 'UserMessage', text))
    await appendFile(f.source, encoded.subarray(0, encoded.length - 6))
    await f.capture('Stop')
    await assert.rejects(prepareEvidence(f.config, 'parent'), /尚无完整/)
    await appendFile(f.source, encoded.subarray(encoded.length - 6))
    await f.capture('SessionEnd')
    await unlink(f.source)
    const newer = await prepareEvidence(f.config, 'parent', { limit: 40 })
    assert(newer.truncated && newer.next_before)
    const older = await prepareEvidence(f.config, 'parent', { limit: 40, before: newer.next_before })
    const all = [...(await readEvidence(f.config, older.evidence_id)).submission.messages, ...(await readEvidence(f.config, newer.evidence_id)).submission.messages]
    assert.equal(all.map(message => message.text).join(''), text)
  } finally { await f.cleanup() }
})

test('install/uninstall stays project-scoped and never replaces another handler', async () => {
  const f = await fixture()
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const config = await loadConfig(root, f.config.envFile, {})
    const first = await configureHooks(root, config, f.directory, f.settings.scope, f.home)
    const before = await readFile(first.hooks_path, 'utf8')
    await configureHooks(root, config, f.directory, f.settings.scope, f.home)
    assert.equal(await readFile(first.hooks_path, 'utf8'), before)
    await configureHooks(root, config, f.directory, undefined, f.home)
    await assert.rejects(f.capture('Stop'), /已卸载/)
  } finally { await f.cleanup() }
})

test('evidence rejects source mutation and an invalid preview limit', async () => {
  const f = await fixture()
  try {
    await appendFile(f.source, message('parent', 'u', 'UserMessage', '请求超时为 17 秒。'))
    await f.capture('Stop')
    await assert.rejects(prepareEvidence(f.config, 'parent', { limit: 0 }), /1..40/)
    const prepared = await prepareEvidence(f.config, 'parent')
    await writeFile(f.source, (await readFile(f.source, 'utf8')).replace('17 秒', '18 秒'))
    await assert.rejects(readEvidence(f.config, prepared.evidence_id), /原始会话记录不一致/)
  } finally { await f.cleanup() }
})
