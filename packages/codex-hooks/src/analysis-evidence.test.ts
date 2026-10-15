import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { evidenceBundleSchema } from '@jacob-z/jt-harness/analysis'
import { hash, writeJson } from './capture.ts'
import { analysisVisibleValue, appendAnalysisWriteUsage, collectAnalysisEvidence } from './analysis-evidence.ts'
import type { CollectedAnalysisEvidence } from './analysis-evidence.ts'

const day = (number: number) => `2026-01-0${number}T00:00:00Z`
const row = (at: string, type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + '\n'
const message = (at: string, role: string, text: string) => row(at, 'response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
async function fixture() {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-analysis-source-')))
  const home = resolve(directory, 'codex'), dataDir = resolve(directory, 'data'), a = resolve(directory, 'a'), b = resolve(directory, 'b')
  await Promise.all([mkdir(resolve(home, 'sessions'), { recursive: true }), mkdir(resolve(home, 'archived_sessions'), { recursive: true }), mkdir(a), mkdir(b)])
  const transcript = async (id: string, root: string, text: string, extra: object = {}, archived = false) => {
    const path = resolve(home, archived ? 'archived_sessions' : 'sessions', `${id}.jsonl`)
    await writeFile(path, row(day(1), 'session_meta', { id, cwd: root, runtime_workspace_roots: [root], ...extra }) + text)
    return path
  }
  return { directory, home, dataDir, a, b, transcript, options: { codexHome: home, dataDir, cutoff: day(4) }, cleanup: () => rm(directory, { recursive: true, force: true }) }
}
function validate(collected: CollectedAnalysisEvidence) {
  const { sessions: _sessions, ...bundle } = collected
  return evidenceBundleSchema.parse({ schemaVersion: 1, analysisId: 'test-analysis', cutoff: day(4), ...bundle })
}

test('workspace selection uses session metadata, since selects sessions while preserving early goals, and source ranges hash exact UTF-8 bytes', async () => {
  const f = await fixture()
  try {
    const path = await f.transcript('selected', f.a, message(day(1), 'user', '原始目标：只修改一个函数。中文😀')
      + row(day(2), 'event_msg', { type: 'item_completed', thread_id: 'delegated-child', item: { type: 'UserMessage', content: [{ type: 'text', text: '子任务授权不是人类授权。' }] } })
      + row(day(2), 'turn_context', { model: 'test-model', workspace_roots: [f.b], permission_profile: { filesystem: { workspace_roots: [f.b] } } })
      + row(day(2), 'world_state', { model: 'test-model', skills: ['configured-skill'], api_key: 'private-config-key' })
      + row(day(2), 'token_usage_record', { usage: { input_tokens: 999, output_tokens: 888 }, source: 'request-detail' })
      + row(day(2), 'inter_agent_communication_metadata', { sender: 'root', recipient: 'child', message_type: 'task' })
      + row(day(2), 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 12 } } })
      + message(day(3), 'user', '补充：保留原函数签名。')
      + row(day(3), 'response_item', { type: 'function_call', name: 'functions.update_plan', call_id: 'plan', arguments: '{"plan":[]}' })
      + row(day(3), 'response_item', { type: 'function_call_output', call_id: 'plan', output: '计划已更新。' })
      + row(day(3), 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 7, total_tokens: 25 } } })
      + message(day(5), 'assistant', '未来的完成声明不能纳入。'))
    await f.transcript('foreign', f.b, 'bad-json-in-unrelated-body\n')
    const selected = await collectAnalysisEvidence({ ...f.options, workspace: f.a, since: day(2) })
    const bundle = validate(selected)
    assert.deepEqual(bundle.selection.sessionIds, ['selected'])
    assert.deepEqual(bundle.selection.workspacePaths, [f.a])
    assert(bundle.evidence.some(item => item.text.includes('原始目标')))
    assert(bundle.evidence.some(item => item.text.includes('保留原函数签名')))
    assert(bundle.evidence.some(item => item.text === '子任务授权不是人类授权。' && item.kind === 'delegated_user_message'))
    assert(!JSON.stringify(bundle.evidence).includes('未来的完成声明'))
    assert.equal(bundle.evidence.filter(item => item.kind === 'goal_plan').length, 2)
    assert(bundle.evidence.some(item => item.kind === 'session_configuration'))
    assert(bundle.evidence.some(item => item.kind === 'usage_detail'))
    assert(bundle.evidence.some(item => item.kind === 'delegation'))
    assert(!JSON.stringify(bundle.evidence).includes('private-config-key'))
    assert(!bundle.chainFacts.some(fact => fact.stage === 'workflow_source_format'))
    assert.deepEqual(bundle.usage, { inputTokens: 20, outputTokens: 5, cachedInputTokens: 7, totalTokens: 25 })
    assert(bundle.chainFacts.some(fact => fact.stage === 'configured_rules' && fact.status === 'unknown'))
    const source = bundle.sources.find(source => source.path === path && source.start! > 0)!
    const bytes = (await readFile(path)).subarray(source.start, source.end)
    assert.equal(source.sha256, hash(bytes.toString('utf8')))
    await assert.rejects(collectAnalysisEvidence({ ...f.options, workspace: f.b, since: day(5) }), /since 晚于/)
  } finally { await f.cleanup() }
})

test('visible analysis values reuse credential sanitizing, retain Unicode and never mutate originals', () => {
  const original = { api_key: 'private-api', nested: [{ token: 'private-token', text: '普通中文😀' }], content: [{ type: 'image', data: 'private-image-base64' }], reasoning: 'private-reasoning' }
  const text = JSON.stringify(analysisVisibleValue(original))
  assert(text.includes('普通中文😀'))
  for (const secret of ['private-api', 'private-token', 'private-image-base64', 'private-reasoning']) assert(!text.includes(secret))
  assert.equal(original.api_key, 'private-api')
  assert.equal(original.reasoning, 'private-reasoning')
})

test('explicit sessions ignore unrelated corrupt metadata and delegated prompts cannot become human approvals; reasoning and media stay excluded', async () => {
  const f = await fixture()
  try {
    await f.transcript('child', f.a, message(day(2), 'user', '可以，你做吧。')
      + row(day(2), 'response_item', { type: 'reasoning', summary: [{ text: 'secret-reasoning' }], encrypted_content: 'secret-encrypted' })
      + row(day(2), 'response_item', { type: 'function_call_output', call_id: 'image', output: JSON.stringify({ content: [{ type: 'image', data: 'hidden-base64' }, { type: 'text', text: '可见工具结果。' }] }) })
      + row(day(3), 'event_msg', { type: 'item_completed', item: { type: 'Reasoning', text: 'more-secret-reasoning' } })
      + row(day(3), 'compacted', { summary: '恢复摘要属于生成材料。' }), { parent_thread_id: 'root', source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } } }, true)
    await writeFile(resolve(f.home, 'sessions/unrelated.jsonl'), 'not-json\n')
    const selected = await collectAnalysisEvidence({ ...f.options, sessionIds: ['child'] })
    const bundle = validate(selected), text = JSON.stringify(bundle.evidence)
    assert(bundle.evidence.some(item => item.kind === 'delegated_user_message' && item.text === '可以，你做吧。'))
    assert(!bundle.evidence.some(item => item.kind === 'human_user_message'))
    assert(text.includes('可见工具结果'))
    assert(!text.includes('secret-reasoning'))
    assert(!text.includes('secret-encrypted'))
    assert(!text.includes('hidden-base64'))
    assert(bundle.evidence.some(item => item.kind === 'recovery'))
    assert.deepEqual(bundle.usage, { inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null })
    await assert.rejects(collectAnalysisEvidence({ ...f.options, sessionIds: ['missing'] }), /未找到所选范围内会话/)
  } finally { await f.cleanup() }
})

test('local collection, reads and historical rules are scoped and chronological; configuring rules never proves loading', async () => {
  const f = await fixture()
  try {
    const path = await f.transcript('selected', f.a, message(day(2), 'user', '保存项目约定。') + message(day(3), 'assistant', '已处理。'))
    const snapshot = { schemaVersion: 1, packageVersion: 'test', files: [{ path: 'skills/rule.md', text: '当时的规则。', sha256: hash('当时的规则。') }] }
    const snapshotId = hash(JSON.stringify(snapshot))
    await writeJson(resolve(f.dataDir, 'codex/rule-snapshots', `${snapshotId}.json`), { id: snapshotId, ...snapshot })
    const capture = { id: 'event', received_at: day(3), event: { session_id: 'selected' }, settings: { rule_snapshot_id: snapshotId, scope: { project_ids: ['a'] } }, snapshot: { path, end: (await readFile(path)).length } }
    await writeJson(resolve(f.dataDir, 'codex/declaration-events/event.json'), { capture, result: [{ submission_id: 'staged-job', status: 'staged' }],
      observation: { processed_at: day(3), declaration: 'missing', decision: null, stage: 'skipped', submission_ids: [], error: null } })
    await writeJson(resolve(f.dataDir, 'codex/declaration-errors/late.json'), { capture: { ...capture, id: 'late' },
      observation: { processed_at: day(5), declaration: 'present', decision: { action: 'record', reason: 'future-reason' }, stage: 'staged' } })
    await writeJson(resolve(f.dataDir, 'codex/declaration-events/foreign.json'), { capture: { event: { session_id: 'foreign' }, received_at: day(3) }, observation: { reason: 'foreign-private-content' } })
    await mkdir(resolve(f.dataDir, 'codex/declaration-inbox'), { recursive: true })
    await writeFile(resolve(f.dataDir, 'codex/declaration-inbox/damaged.json'), '{foreign-private-damaged')
    await writeJson(resolve(f.dataDir, 'codex/reads/thread/read.json'), { session_id: 'selected', entry_id: 'entry', version: 'b'.repeat(64), read_at: day(3), level: 'summary' })
    await writeJson(resolve(f.dataDir, 'codex/reads/thread/future.json'), { session_id: 'selected', read_at: day(5), entry_id: 'future-private-read' })
    const selected = await collectAnalysisEvidence({ ...f.options, sessionIds: ['selected'] })
    const bundle = validate(selected), text = JSON.stringify(bundle.evidence)
    assert(bundle.chainFacts.some(fact => fact.stage === 'declaration' && fact.status === 'missing' && fact.detail.includes('原因未知')))
    assert(bundle.chainFacts.some(fact => fact.stage === 'memory_decision' && fact.status === 'unknown'))
    assert(bundle.chainFacts.some(fact => fact.stage === 'configured_rules' && fact.status === 'observed' && fact.detail.includes('不证明')))
    assert(bundle.chainFacts.some(fact => fact.stage === 'rule_loading' && fact.status === 'unknown'))
    assert(bundle.chainFacts.some(fact => fact.stage === 'declaration_processing' && fact.status === 'unknown'))
    assert(bundle.evidence.some(item => item.kind === 'memo_read_receipt'))
    assert(!text.includes('foreign-private-content'))
    assert(!text.includes('foreign-private-damaged'))
    assert(!text.includes('future-private-read'))
    assert(!text.includes('future-reason'))
    assert.deepEqual(selected.sessions[0].submissionIds, ['staged-job'])
  } finally { await f.cleanup() }
})

test('actual database job IDs append write usage without rescanning transcripts, preserving retries and cutoff uncertainty', async () => {
  const f = await fixture()
  try {
    const path = await f.transcript('selected', f.a, message(day(2), 'user', '项目约定。'))
    const selected = await collectAnalysisEvidence({ ...f.options, sessionIds: ['selected'] })
    await writeFile(path, 'the transcript is no longer readable\n')
    await writeJson(resolve(f.dataDir, 'codex/write-usage/attempt1.json'), { submission_id: 'actual-job', job_attempt: 1, started_at: day(2), completed_at: day(3), status: 'failed',
      embedding_attempts: [{ entry_id: 'entry', completed_at: day(3), usage: { prompt_tokens: null, total_tokens: null }, error: 'HTTP 429' }] })
    await writeJson(resolve(f.dataDir, 'codex/write-usage/attempt2.json'), { submission_id: 'actual-job', job_attempt: 2, started_at: day(3), completed_at: day(5), status: 'indexed', error: 'future-error',
      embedding_attempts: [{ entry_id: 'entry', completed_at: day(3), usage: { prompt_tokens: 5, total_tokens: 5 } }, { completed_at: day(5), future: 'future-attempt' }] })
    await appendAnalysisWriteUsage(selected, f.options, { selected: ['actual-job'] })
    const bundle = validate(selected), writes = bundle.evidence.filter(item => item.kind === 'memo_write_usage').map(item => JSON.parse(item.text))
    assert.equal(writes.length, 2)
    assert.equal(writes[0].embedding_attempts[0].usage.prompt_tokens, null)
    assert.equal(writes[1].status, 'unknown_at_cutoff')
    assert.equal(writes[1].embedding_attempts.length, 1)
    assert(!JSON.stringify(writes).includes('future-error'))
    assert(!JSON.stringify(writes).includes('future-attempt'))
    await appendAnalysisWriteUsage(selected, f.options, { selected: ['actual-job'] })
    assert.equal(selected.evidence.filter(item => item.kind === 'memo_write_usage').length, 2)
  } finally { await f.cleanup() }
})
