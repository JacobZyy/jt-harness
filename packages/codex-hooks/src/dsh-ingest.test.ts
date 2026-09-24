import assert from 'node:assert/strict'
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { parseExtraction, submissionSchema } from '@jacob-z/jt-harness/memo/contracts'
import type { Submission } from '@jacob-z/jt-harness/memo/contracts'
import { captureEvent, captureStatus, configureHooks, hookEvents, mergeHooks } from './index.ts'
import type { CaptureSettings } from './index.ts'
import { drainCaptureFiles } from './dsh-ingest.ts'
import { loadConfig } from '@jacob-z/jt-harness/memo/config'
import { fileURLToPath } from 'node:url'

const time = (second: number) => `2026-09-16T00:00:${String(second).padStart(2, '0')}.000Z`
const row = (second: number, type: string, payload: unknown) => `${JSON.stringify({ timestamp: time(second), type, payload })}\n`
const meta = (id: string, parent?: string) => row(0, 'session_meta', { id, session_id: parent ?? id, parent_thread_id: parent })
const item = (second: number, thread: string, id: string, type: string, fields: Record<string, unknown>) => row(second, 'event_msg', {
  type: 'item_completed', thread_id: thread, turn_id: 'turn-one', item: { type, id, ...fields },
})
const text = (second: number, thread: string, id: string, role: 'UserMessage' | 'AgentMessage', value: string) => item(second, thread, id, role, { content: [{ type: 'text', text: value }] })

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-codex-'))
  const home = resolve(directory, 'codex')
  const sessions = resolve(home, 'sessions', '2026', '09', '16')
  await mkdir(sessions, { recursive: true })
  const config = { dataDir: resolve(directory, 'jth'), envFile: resolve(directory, '.env') }
  const settings: CaptureSettings = { workspace: directory, codex_home: home, env_file: config.envFile, enabled_at: time(1), scope: { project_ids: ['hook-test'], business_ids: [] } }
  const root = resolve(sessions, 'rollout-root.jsonl')
  const child = resolve(sessions, 'rollout-child.jsonl')
  await writeFile(root, meta('root'))
  await writeFile(child, meta('child', 'root'))
  const sent = new Map<string, Submission>()
  const deliver = async (source: Submission) => {
    const value = submissionSchema.parse(source)
    if (sent.has(value.submission_id)) assert.deepEqual(sent.get(value.submission_id), value, 'Retries must preserve the exact accepted payload')
    sent.set(value.submission_id, value)
    return { submission_id: value.submission_id }
  }
  const capture = (event: typeof hookEvents[number], extra: Record<string, unknown> = {}) => captureEvent({
    hook_event_name: event, session_id: 'root', cwd: directory, transcript_path: root, turn_id: 'turn-one', ...extra,
  }, settings, config)
  return { directory, home, root, child, config, settings, sent, deliver, capture, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('six hook definitions are idempotent and preserve unrelated handlers and metadata', () => {
  const existing = { description: 'existing', hooks: { Stop: [{ matcher: 'custom', hooks: [{ type: 'command', command: 'existing' }] }], PostToolUse: [{ hooks: [{ command: 'tool-hook' }] }] } }
  const once = mergeHooks(existing, 'jth memo codex capture')
  assert.deepEqual(mergeHooks(once, 'jth memo codex capture'), once)
  for (const event of hookEvents) assert.equal(once.hooks[event]!.flatMap(group => group.hooks!).filter(handler => handler.statusMessage === 'jth memo capture').length, 1)
  assert.deepEqual(mergeHooks(once), existing)
  assert.throws(() => mergeHooks({ hooks: { Stop: [{}] } }, 'capture'), /无效/)
})

test('six lifecycle events keep parent/child identity, source roles, context and duplicate delivery correct', async () => {
  const f = await fixture()
  try {
    await appendFile(f.root, row(0, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected AGENTS.md instructions' }] })
      + text(0, 'root', 'historical', 'UserMessage', 'Before installation; do not backfill.')
      + item(0, 'root', 'old-format', 'HistoricalItemNotSupported', { text: 'Old events outside the capture window do not require adaptation.' })
      + text(2, 'root', 'u1', 'UserMessage', '项目采用 PostgreSQL。')
      + item(3, 'root', 't1', 'CommandExecution', { command: ['psql'], exit_code: 0, aggregated_output: 'PostgreSQL 18.6' })
      + text(4, 'root', 'a1', 'AgentMessage', '建议超时设为 30 秒。')
      + row(4, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'duplicate response representation' }] })
      + row(4, 'response_item', { type: 'reasoning', summary: [{ text: 'private reasoning excluded' }] }))
    await f.capture('SessionStart')
    await f.capture('SubagentStart', { agent_id: 'child', agent_type: 'researcher' })
    await appendFile(f.child, text(2, 'root', 'inherited', 'UserMessage', 'Copied parent history must not become child input.')
      + row(5, 'response_item', { type: 'agent_message', id: 'assignment', author: '/root', content: [{ type: 'input_text', text: '检查数据库版本，不代表用户确认。' }] })
      + text(6, 'child', 'delegated-user', 'UserMessage', 'A delegated user-role message is still authored by an agent.')
      + text(7, 'child', 'child-answer', 'AgentMessage', '子 Agent 报告。'))
    await f.capture('SubagentStop', { agent_id: 'child', agent_type: 'researcher', agent_transcript_path: f.child })
    await f.capture('Stop')
    assert.equal((await drainCaptureFiles(f.config, f.deliver)).failed, 0)
    assert.equal(f.sent.size, 2)
    const parent = [...f.sent.values()].find(source => source.source.session_id === 'root')!
    const child = [...f.sent.values()].find(source => source.source.session_id === 'child')!
    assert.deepEqual(parent.messages.map(message => message.role), ['user', 'tool', 'assistant'])
    assert.equal(child.source.codex?.parent_session_id, 'root')
    assert(child.messages.every(message => message.role === 'assistant'))
    assert(!JSON.stringify([...f.sent.values()]).includes('injected AGENTS'))
    assert(!JSON.stringify([...f.sent.values()]).includes('Copied parent'))
    await appendFile(f.root, text(8, 'root', 'u2', 'UserMessage', '同意这个超时设置。'))
    await f.capture('Interrupt')
    await f.capture('SessionEnd')
    const report = await drainCaptureFiles(f.config, f.deliver)
    assert.equal(report.failed, 0)
    assert.equal(f.sent.size, 3)
    const confirmation = [...f.sent.values()].find(source => source.messages.some(message => message.text === '同意这个超时设置。'))!
    assert(confirmation.messages.some(message => message.context_only && message.text === '建议超时设为 30 秒。'))
    const before = confirmation.messages.find(message => message.text === '建议超时设为 30 秒。')!
    const after = confirmation.messages.find(message => !message.context_only)!
    assert.doesNotThrow(() => parseExtraction(JSON.stringify({ schema_version: 1, memories: [{ content: '超时为 30 秒。', basis: 'user_confirmed', scope: 'project', source_message_ids: [before.message_id, after.message_id] }], proposals: [], revisions: [] }), confirmation))
    assert.doesNotThrow(() => parseExtraction(JSON.stringify({ schema_version: 1, memories: [], proposals: [{ content: before.text, basis: 'assistant_proposal', scope: 'project', source_message_ids: [before.message_id] }], revisions: [] }), confirmation))
    await Promise.all([f.capture('Stop'), f.capture('SessionEnd')])
    assert.equal((await drainCaptureFiles(f.config, f.deliver)).accepted, 0)
    assert.equal((await captureStatus(f.config)).pending_events, 0)
  } finally { await f.cleanup() }
})

test('uncertain receipt freezes the batch; later growth and source deletion replay without loss', async () => {
  const f = await fixture()
  try {
    await appendFile(f.root, text(2, 'root', 'first', 'UserMessage', '第一条事实。'))
    await f.capture('Stop')
    assert.equal((await drainCaptureFiles({ ...f.config, envFile: resolve(f.directory, 'other.env') }, f.deliver)).received, 0)
    assert.equal((await captureStatus(f.config)).pending_events, 1)
    const first = await drainCaptureFiles(f.config, async value => { await f.deliver(value); throw new Error('receipt connection lost') })
    assert.equal(first.failed, 1)
    const status = await captureStatus(f.config)
    assert.equal(status.streams[0].pending_batch, true)
    await appendFile(f.root, text(3, 'root', 'second', 'UserMessage', '第二条事实。'))
    await f.capture('SessionEnd')
    await unlink(f.root)
    const replay = await drainCaptureFiles(f.config, f.deliver)
    assert.equal(replay.failed, 0, JSON.stringify(replay.errors))
    assert.equal(f.sent.size, 2)
    assert.equal((await captureStatus(f.config)).streams[0].message_count, 2)
    const sourceNames = await readdir(resolve(f.config.dataDir, 'codex', 'sources'))
    assert.equal((await stat(resolve(f.config.dataDir, 'codex', 'sources', sourceNames[0]))).isFile(), true)
  } finally { await f.cleanup() }
})

test('partial UTF-8 writes wait; large records split on character boundaries without truncation', async () => {
  const f = await fixture()
  try {
    const body = '中文😀'.repeat(25_000)
    const full = Buffer.from(text(2, 'root', 'huge', 'UserMessage', body))
    await appendFile(f.root, full.subarray(0, full.length - 7))
    await f.capture('Stop')
    assert.equal((await drainCaptureFiles(f.config, f.deliver)).accepted, 0)
    await appendFile(f.root, full.subarray(full.length - 7))
    await f.capture('Stop')
    assert.equal((await drainCaptureFiles(f.config, f.deliver)).failed, 0)
    const parts = [...f.sent.values()].flatMap(source => source.messages.filter(message => !message.context_only))
    assert.equal(parts.map(part => part.text).join(''), body)
    assert(parts.every(part => !part.text.includes('\uFFFD')))
    assert([...f.sent.values()].every(source => Buffer.byteLength(JSON.stringify(source)) <= 256_000))
    const count = f.sent.size
    assert.equal((await drainCaptureFiles(f.config, f.deliver)).accepted, 0)
    assert.equal(f.sent.size, count)
  } finally { await f.cleanup() }
})

test('foreign paths, wrong parent identity and rewritten logs cannot advance accepted cursors', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.capture('Stop', { transcript_path: '/etc/hosts' }), /CODEX_HOME/)
    await assert.rejects(f.capture('SubagentStart'), /agent_id/)
    const waiting = await f.capture('SubagentStop', { agent_id: 'waiting-child', agent_transcript_path: resolve(f.home, 'sessions', 'rollout-waiting-child.jsonl') })
    assert.equal(waiting.snapshot, undefined)
    await appendFile(f.root, text(2, 'root', 'a', 'UserMessage', 'A'))
    await f.capture('Stop')
    await drainCaptureFiles(f.config, f.deliver)
    await writeFile(f.root, meta('root') + text(2, 'root', 'a', 'UserMessage', 'B'))
    assert.equal((await drainCaptureFiles(f.config, f.deliver)).failed, 1)
    assert.equal(f.sent.size, 1)
    await f.capture('SubagentStop', { agent_id: 'wrong-child', agent_transcript_path: f.child })
    assert((await drainCaptureFiles(f.config, f.deliver)).errors.some(error => /ID/.test(error.error)))
    const files = await readdir(resolve(f.config.dataDir, 'codex', 'streams'))
    for (const file of files) assert.equal((await stat(resolve(f.config.dataDir, 'codex', 'streams', file))).mode & 0o777, 0o600)
  } finally { await f.cleanup() }
})

test('install/uninstall keep unrelated hooks; uninstall stops discovering new content', async () => {
  const f = await fixture()
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const envFile = resolve(f.directory, '.env')
    await writeFile(envFile, `JTH_DATA_DIR=${f.config.dataDir}\n`)
    const config = await loadConfig(root, envFile, {})
    const installed = await configureHooks(root, config, f.directory, f.settings.scope, f.home)
    const hookPath = resolve(f.directory, '.codex', 'hooks.json')
    const original = await readFile(hookPath, 'utf8')
    await configureHooks(root, config, f.directory, f.settings.scope, f.home)
    assert.equal(await readFile(hookPath, 'utf8'), original)
    const current = new Date().toISOString()
    await appendFile(f.root, JSON.stringify({ timestamp: current, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'root', item: { type: 'UserMessage', id: 'installed-content', content: [{ type: 'text', text: '采集开启时的内容。' }] } } }) + '\n')
    await captureEvent({ hook_event_name: 'Stop', session_id: 'root', cwd: f.directory, transcript_path: f.root }, installed.settings!, config)
    assert.equal((await drainCaptureFiles(config, f.deliver)).accepted, 1)
    await configureHooks(root, config, f.directory, undefined, f.home)
    await appendFile(f.root, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'root', item: { type: 'UserMessage', id: 'after-uninstall', content: [{ type: 'text', text: '卸载后不再采集。' }] } } }) + '\n')
    assert.equal((await drainCaptureFiles(config, f.deliver)).accepted, 0)
    assert.deepEqual(JSON.parse(await readFile(hookPath, 'utf8')).hooks, {})
    await assert.rejects(f.capture('Stop'), /已卸载/)
    assert.deepEqual(installed.events, ['Stop', 'SessionStart', 'UserPromptSubmit'])
  } finally { await f.cleanup() }
})

test('FunctionCallOutput remains tool evidence and does not block later conversation messages', async () => {
  const f = await fixture()
  try {
    await appendFile(f.root, item(2, 'root', 'function-output', 'FunctionCallOutput', { name: 'lookup', namespace: 'tools', output: 'Result: 17' })
      + text(3, 'root', 'next-user', 'UserMessage', '继续处理。'))
    await f.capture('Stop')
    assert.equal((await drainCaptureFiles(f.config, f.deliver)).failed, 0)
    const messages = [...f.sent.values()][0].messages
    assert.deepEqual(messages.map(message => message.role), ['tool', 'user'])
    assert.equal(JSON.parse(messages[0].text).output, 'Result: 17')
  } finally { await f.cleanup() }
})
