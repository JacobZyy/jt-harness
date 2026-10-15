import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, lstat, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseDeclaration } from '@jacob-z/jt-harness/memo/contracts'
import { captureDeclaration, collectDeclarations, rememberEntryRead } from './declarations.ts'
import { readEvidence, deliverRecords } from './evidence.ts'
import { configureHooks } from './install.ts'

const at = '2026-01-01T00:00:00Z'
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + '\n'
const message = (id: string, type: string, text: string) => row('event_msg', { type: 'item_completed', thread_id: 'parent', item: { id, type, content: [{ type: 'text', text }] } })
const declaration = (extra: object = {}) => `<!-- jth-memory ${JSON.stringify({ items: [{ text: '项目使用 pnpm。', scope: 'project', basis: 'user_statement', quote: '项目使用 pnpm', ...extra }] })} -->`
async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-declaration-'))
  const home = resolve(directory, 'codex'), source = resolve(home, 'sessions/parent.jsonl')
  await mkdir(resolve(home, 'sessions'), { recursive: true })
  await writeFile(source, row('session_meta', { id: 'parent' }))
  const config = { dataDir: resolve(directory, 'data'), envFile: resolve(directory, '.env') }
  const settings = { workspace: directory, codex_home: home, env_file: config.envFile, enabled_at: at, scope: { project_ids: ['test'], business_ids: [] } }
  const capture = (text?: string) => captureDeclaration({ hook_event_name: 'Stop', session_id: 'parent', cwd: directory, transcript_path: source, last_assistant_message: text }, settings, config)
  return { directory, home, source, config, settings, capture, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('declaration parser ignores normal replies and fenced examples, and bounds accepted statements', () => {
  assert.equal(parseDeclaration('工作完成。'), null)
  assert.equal(parseDeclaration('```text\n' + declaration() + '\n```'), null)
  assert.equal(parseDeclaration('引用示例：' + declaration()), null)
  assert.equal(parseDeclaration('任务完成。\n' + declaration())!.items[0].text, '项目使用 pnpm。')
  assert.throws(() => parseDeclaration('<!-- jth-memory {} -->'))
  assert.throws(() => parseDeclaration(declaration({ text: '长'.repeat(501) })), /500/)
  assert.equal(parseDeclaration(declaration({ basis: 'user_confirmed', confirmation_quote: '可以，按这个做' }))!.items[0].confirmation_quote, '可以，按这个做')
  assert.throws(() => parseDeclaration(declaration({ confirmation_quote: '可以，按这个做' })), /仅用于 user_confirmed/)
  assert.throws(() => parseDeclaration(declaration({ basis: 'user_confirmed', confirmation_quote: '长'.repeat(241) })), /240/)
})

test('every main Stop stays observable; source-bound declarations are staged once and malformed ones stay diagnostic', async () => {
  const f = await fixture()
  try {
    await appendFile(f.source, message('u0', 'UserMessage', '完成这次工作。') + message('a0', 'AgentMessage', '工作完成，无新事实。'))
    assert(await f.capture('工作完成，无新事实。'))
    assert.deepEqual(await collectDeclarations(f.config), { received: 0, skipped: 1, errors: [] })
    const observed = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/declaration-events', (await readdir(resolve(f.config.dataDir, 'codex/declaration-events')))[0]), 'utf8'))
    assert.equal(observed.observation.declaration, 'missing')
    assert.equal(observed.observation.decision, null)
    assert.equal(observed.observation.turn_usage.input_tokens, null)
    assert.equal(observed.observation.write_usage.declaration_tokens, null)
    await appendFile(f.source, message('u1', 'UserMessage', '本项目使用 pnpm，已经确定。') + message('a1', 'AgentMessage', '已完成。\n' + declaration()))
    await f.capture('已完成。\n' + declaration())
    await f.capture('已完成。\n' + declaration())
    assert.equal((await collectDeclarations(f.config)).received, 2)
    const files = await readdir(resolve(f.config.dataDir, 'codex/records'))
    assert.equal(files.length, 1)
    const staged = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', files[0]), 'utf8'))
    assert.equal(staged.declaration, true)
    const evidence = await readEvidence(f.config, staged.evidence_id)
    const fact = staged.draft.extraction.memories[0]
    assert.equal(evidence.submission.messages.find(item => item.message_id === fact.source_message_ids[0])!.role, 'user')
    assert.equal((await deliverRecords(f.config, async () => { throw new Error('offline') })).errors.length, 1)
    assert.equal((await readdir(resolve(f.config.dataDir, 'codex/records'))).length, 1)
    const delivered = await deliverRecords(f.config, async (_draft, _evidence, isDeclaration) => { assert.equal(isDeclaration, true); return { status: 'accepted' } })
    assert.equal(delivered.accepted.length, 1)
    await appendFile(f.source, message('a2', 'AgentMessage', '<!-- jth-memory bad -->'))
    await f.capture('<!-- jth-memory bad -->')
    assert.equal((await collectDeclarations(f.config)).errors.length, 1)
    assert.equal((await collectDeclarations(f.config)).errors.length, 0)
    assert.equal((await readdir(resolve(f.config.dataDir, 'codex/declaration-errors'))).length, 1)
    const diagnostic = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/declaration-errors', (await readdir(resolve(f.config.dataDir, 'codex/declaration-errors')))[0]), 'utf8'))
    assert.equal(diagnostic.observation.declaration, 'invalid')
    assert.equal(diagnostic.observation.stage, 'failed')
    assert(diagnostic.observation.error)
  } finally { await f.cleanup() }
})

test('skip decisions remain operational evidence and turn counters never claim exact declaration cost', async () => {
  const f = await fixture()
  const skip = `<!-- jth-memory ${JSON.stringify({ items: [], decision: { action: 'skip', reason: '这轮只有临时操作。' } })} -->`
  const tokens = (total: object, last?: object) => row('event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } })
  try {
    const snapshotId = 'a'.repeat(64)
    await appendFile(f.source, tokens({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 130 })
      + message('user', 'UserMessage', '这轮只查询状态。')
      + tokens({ input_tokens: 400, cached_input_tokens: 140, output_tokens: 90, reasoning_output_tokens: 20, total_tokens: 490 })
      + message('final', 'AgentMessage', skip))
    const capture = await captureDeclaration({ hook_event_name: 'Stop', session_id: 'parent', cwd: f.directory, transcript_path: f.source, last_assistant_message: skip },
      { ...f.settings, rule_snapshot_id: snapshotId }, f.config)
    assert.deepEqual(await collectDeclarations(f.config), { received: 0, skipped: 1, errors: [] })
    const observed = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/declaration-events', `${capture!.id}.json`), 'utf8'))
    assert.equal(observed.observation.rule_snapshot_id, snapshotId)
    assert.deepEqual(observed.observation.decision, { action: 'skip', reason: '这轮只有临时操作。' })
    assert.deepEqual(observed.observation.submission_ids, [])
    assert.deepEqual(observed.observation.turn_usage, { attribution: 'turn_context', input_tokens: 300, cached_input_tokens: 100, output_tokens: 60, reasoning_output_tokens: 10, total_tokens: 360 })
    assert.equal(observed.observation.write_usage.background_extraction_model_calls, 0)
    await assert.rejects(readdir(resolve(f.config.dataDir, 'codex/records')), { code: 'ENOENT' })
    assert.equal(await captureDeclaration({ hook_event_name: 'Stop', session_id: 'parent', agent_id: 'child', cwd: f.directory }, f.settings, f.config), null)
  } finally { await f.cleanup() }
})

test('old declarations preserve a missing decision and incomplete usage stays unknown', async () => {
  const f = await fixture()
  try {
    await appendFile(f.source, message('user', 'UserMessage', '项目使用 pnpm。')
      + row('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 7 }, total_token_usage: { input_tokens: 7 } } })
      + message('final', 'AgentMessage', declaration()))
    const capture = await f.capture(declaration())
    assert.equal((await collectDeclarations(f.config)).received, 1)
    const observed = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/declaration-events', `${capture!.id}.json`), 'utf8'))
    assert.equal(observed.observation.declaration, 'present')
    assert.equal(observed.observation.decision, null)
    assert.equal(observed.observation.turn_usage.input_tokens, 7)
    assert.equal(observed.observation.turn_usage.output_tokens, null)
  } finally { await f.cleanup() }
})

test('native WebSearch records retain tool evidence and do not block later declarations', async () => {
  const f = await fixture()
  try {
    const action = { type: 'search', query: '包管理器文档', queries: ['包管理器文档'] }
    const text = `<!-- jth-memory ${JSON.stringify({ items: [
      { text: '本轮搜索了包管理器文档。', scope: 'current_task', basis: 'tool_observation', quote: '包管理器文档' },
      { text: '项目使用 pnpm。', scope: 'project', basis: 'user_statement', quote: '项目使用 pnpm' },
    ] })} -->`
    await appendFile(f.source, row('event_msg', { type: 'item_completed', thread_id: 'parent', item: { type: 'WebSearch', id: 'search', query: action.query, action } })
      + message('user', 'UserMessage', '项目使用 pnpm。') + message('final', 'AgentMessage', text))
    await f.capture(text)
    assert.deepEqual(await collectDeclarations(f.config), { received: 1, skipped: 0, errors: [] })
    const file = (await readdir(resolve(f.config.dataDir, 'codex/records')))[0]
    const staged = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', file), 'utf8'))
    assert.equal(staged.draft.extraction.memories.length, 2)
    const evidence = await readEvidence(f.config, staged.evidence_id)
    const search = evidence.submission.messages.find(item => item.role === 'tool')!
    assert.deepEqual(JSON.parse(search.text), { tool: 'web_search', query: action.query, action })
    assert.equal(evidence.submission.messages.find(item => item.role === 'user')!.text, '项目使用 pnpm。')
  } finally { await f.cleanup() }
})

test('short approvals bind the preceding proposal and user changes across turns, without promoting other options', async () => {
  const f = await fixture(), target = randomUUID(), version = 'b'.repeat(64)
  try {
    await rememberEntryRead(f.config, 'parent', target, version)
    const proposal = '方案 A：每分钟反馈。方案 B：每 15 分钟反馈，最多 300 字。'
    const confirmation = '采用方案 B，改成 200 字以内，可以，你做吧。'
    const approved = '用户已批准每 15 分钟反馈，最多 200 字；待实施。'
    const text = declaration({ text: approved, basis: 'user_confirmed', quote: '方案 B：每 15 分钟反馈，最多 300 字。', confirmation_quote: confirmation,
      change: { kind: 'correction', target } })
    await appendFile(f.source, message('older-approval', 'UserMessage', confirmation)
      + message('proposal', 'AgentMessage', proposal) + message('approval', 'UserMessage', confirmation)
      + row('compacted', { message: '继续已确认的方案，保留待声明决策及两段来源引文。' })
      + message('progress', 'AgentMessage', `执行中，重述确认：${confirmation}`)
      + message('final', 'AgentMessage', text))
    await f.capture(text)
    await f.capture(text)
    assert.deepEqual(await collectDeclarations(f.config), { received: 2, skipped: 0, errors: [] })
    const files = await readdir(resolve(f.config.dataDir, 'codex/records'))
    assert.equal(files.length, 1)
    const staged = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', files[0]), 'utf8'))
    const evidence = await readEvidence(f.config, staged.evidence_id)
    assert.equal(staged.draft.extraction.memories.length, 1)
    assert.deepEqual(staged.draft.extraction.proposals, [])
    const fact = staged.draft.extraction.memories[0]
    assert.equal(fact.content, approved)
    assert.equal(fact.basis, 'user_confirmed')
    const sources = fact.source_message_ids.map((id: string) => evidence.submission.messages.find(message => message.message_id === id))
    assert.deepEqual(sources.map((message: { role: string, text: string }) => [message.role, message.text]), [['assistant', proposal], ['user', confirmation]])
    assert.equal(evidence.submission.messages.length, 3)
    assert.deepEqual(staged.draft.changes[0].source_message_ids, fact.source_message_ids)
    assert.equal(staged.draft.changes[0].evidence_quote, confirmation)
    assert.equal(staged.draft.changes[0].expected_version, version)
  } finally { await f.cleanup() }
})

test('approval evidence rejects missing user confirmation and reversed source order', async () => {
  for (const preceding of [
    message('proposal', 'AgentMessage', '采用方案 B。') + message('echo', 'AgentMessage', '可以，你做吧。'),
    message('approval', 'UserMessage', '可以，你做吧。') + message('proposal', 'AgentMessage', '采用方案 B。'),
  ]) {
    const f = await fixture()
    try {
      const text = declaration({ text: '方案 B 已获批准。', basis: 'user_confirmed', quote: '采用方案 B。', confirmation_quote: '可以，你做吧。' })
      await appendFile(f.source, preceding + message('final', 'AgentMessage', text))
      await f.capture(text)
      const result = await collectDeclarations(f.config)
      assert.equal(result.received, 0)
      assert.match(result.errors[0].error, /真实用户消息|确认之前的助手消息/)
      await assert.rejects(readdir(resolve(f.config.dataDir, 'codex/records')), { code: 'ENOENT' })
    } finally { await f.cleanup() }
  }
})

test('correction versions come from a prior read receipt and statements cannot cite themselves', async () => {
  const f = await fixture(), target = randomUUID(), version = 'a'.repeat(64)
  try {
    await rememberEntryRead(f.config, 'parent', target, version)
    await appendFile(f.source, message('u1', 'UserMessage', '项目使用 pnpm，替代旧约定。'))
    const text = declaration({ change: { kind: 'correction', target } })
    await appendFile(f.source, message('a1', 'AgentMessage', text))
    await f.capture(text)
    assert.equal((await collectDeclarations(f.config)).errors.length, 0)
    const file = (await readdir(resolve(f.config.dataDir, 'codex/records')))[0]
    const staged = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', file), 'utf8'))
    assert.equal(staged.draft.changes[0].expected_version, version)
    const invented = declaration({ quote: '只存在于声明中的话' })
    await appendFile(f.source, message('a2', 'AgentMessage', invented))
    await f.capture(invented)
    assert.match((await collectDeclarations(f.config)).errors[0].error, /不会用声明自身/)
  } finally { await f.cleanup() }
})

test('usage-only declarations require a prior read and do not create memory facts', async () => {
  const f = await fixture(), id = randomUUID(), version = 'c'.repeat(64)
  const text = `<!-- jth-memory ${JSON.stringify({ items: [], used: [id] })} -->`
  try {
    await appendFile(f.source, message('final', 'AgentMessage', text))
    await f.capture(text)
    assert.match((await collectDeclarations(f.config)).errors[0].error, /读取回执/)
    await rememberEntryRead(f.config, 'parent', id, version, 'evidence')
    await f.capture(text)
    assert.equal((await collectDeclarations(f.config)).received, 1)
    const file = (await readdir(resolve(f.config.dataDir, 'codex/records')))[0]
    const staged = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', file), 'utf8'))
    assert.deepEqual(staged.draft.extraction.memories, [])
    assert.deepEqual(staged.draft.used, [{ entry_id: id, read_version: version }])
    assert.throws(() => parseDeclaration('<!-- jth-memory {"items":[]} -->'))
  } finally { await f.cleanup() }
})

test('recalled tool output and earlier declaration blocks cannot echo into fresh facts', async () => {
  const f = await fixture()
  try {
    const output = JSON.stringify({ memory_context: { kind: 'jth_memory_context', source: 'jth-memo', channel: 'cli', trust: 'untrusted' },
      entries: [{ preview: '项目使用 pnpm' }] })
    await appendFile(f.source, row('event_msg', { type: 'item_completed', thread_id: 'parent', item: {
      type: 'CommandExecution', id: 'recall', command: 'jth memo recall pnpm', aggregated_output: output,
    } }) + message('old-declaration', 'AgentMessage', declaration()) + message('final', 'AgentMessage', declaration({ basis: 'tool_observation' })))
    await f.capture(declaration({ basis: 'tool_observation' }))
    assert.match((await collectDeclarations(f.config)).errors[0].error, /真实来源/)
    await appendFile(f.source, message('real-user', 'UserMessage', '项目使用 pnpm，当前确认。') + message('new-final', 'AgentMessage', declaration()))
    await f.capture(declaration())
    assert.equal((await collectDeclarations(f.config)).received, 1)
    const file = (await readdir(resolve(f.config.dataDir, 'codex/records')))[0]
    const staged = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', file), 'utf8'))
    const evidence = await readEvidence(f.config, staged.evidence_id)
    assert.equal(evidence.submission.messages[0].role, 'user')
  } finally { await f.cleanup() }
})

test('derived candidates bind evidence-level reads in this session and cannot masquerade as facts', async () => {
  const f = await fixture(), source = randomUUID(), version = 'd'.repeat(64)
  const text = declaration({ text: '建议统一项目依赖安装入口。', basis: 'agent_inference', quote: '统一项目依赖安装入口', derived_from: [source] })
  try {
    assert.throws(() => parseDeclaration(declaration({ derived_from: [source] })), /仅用于候选/)
    assert.throws(() => parseDeclaration(declaration({ basis: 'agent_inference', derived_from: [source, source] })), /不得重复/)
    await rememberEntryRead(f.config, 'another-session', source, version, 'full')
    await rememberEntryRead(f.config, 'parent', source, version, 'summary')
    await appendFile(f.source, message('proposal', 'AgentMessage', '建议统一项目依赖安装入口，尚待确认。') + message('final', 'AgentMessage', text))
    await f.capture(text)
    assert.match((await collectDeclarations(f.config)).errors[0].error, /--level evidence/)
    await rememberEntryRead(f.config, 'parent', source, version, 'evidence')
    await f.capture(text)
    assert.equal((await collectDeclarations(f.config)).received, 1)
    const file = (await readdir(resolve(f.config.dataDir, 'codex/records')))[0]
    const staged = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', file), 'utf8'))
    assert.deepEqual(staged.draft.extraction.memories, [])
    assert.equal(staged.draft.extraction.proposals.length, 1)
    assert.deepEqual(staged.draft.derivations, [{ proposal_index: 0, sources: [{ entry_id: source, read_version: version }] }])
    await readEvidence(f.config, staged.evidence_id)
  } finally { await f.cleanup() }
})

test('installation replaces legacy capture with declaration and bounded cue hooks', async () => {
  const f = await fixture()
  const root = resolve(import.meta.dirname, '../../..')
  try {
    await mkdir(resolve(f.directory, '.codex'))
    const original = '# Project\nKeep existing rules.\n'
    await writeFile(resolve(f.directory, 'AGENTS.md'), `${original}\n<!-- JTH_MEMORY_START -->\nOld memory instructions.\n<!-- JTH_MEMORY_END -->\n`)
    await writeFile(resolve(f.directory, '.codex/hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ command: 'old', statusMessage: 'jth memo capture' }] }],
      Stop: [{ hooks: [{ command: 'keep-other' }] }],
    } }))
    await configureHooks(root, f.config, f.directory, f.settings.scope, f.home)
    assert.equal(await readFile(resolve(f.directory, 'AGENTS.md'), 'utf8'), original)
    assert((await lstat(resolve(f.directory, '.agents/skills/jth-memo'))).isDirectory())
    const installedDeclaration = await readFile(resolve(f.directory, '.agents/skills/jth-memo/references/declarations.md'), 'utf8')
    assert(installedDeclaration.includes('confirmation_quote'))
    assert(installedDeclaration.includes('derived_from'))
    await configureHooks(root, f.config, f.directory, f.settings.scope, f.home)
    assert.equal(await readFile(resolve(f.directory, 'AGENTS.md'), 'utf8'), original)
    const hooks = JSON.parse(await readFile(resolve(f.directory, '.codex/hooks.json'), 'utf8')).hooks
    assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
    assert(hooks.Stop.flatMap((group: { hooks: { command: string }[] }) => group.hooks).some((hook: { command: string }) => hook.command.includes("'declare'")))
    await configureHooks(root, f.config, f.directory, undefined, f.home)
    assert.equal(await readFile(resolve(f.directory, 'AGENTS.md'), 'utf8'), original)
    await assert.rejects(lstat(resolve(f.directory, '.agents/skills/jth-memo')), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})
