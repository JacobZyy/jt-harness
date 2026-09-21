import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseDeclaration } from '@jt-harness/memo/contracts'
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

test('Stop with no declaration is a no-op; source-bound declarations are staged once and malformed ones stay diagnostic', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.capture('工作完成，无新事实。'), null)
    assert.deepEqual(await collectDeclarations(f.config), { received: 0, skipped: 0, errors: [] })
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

test('installation replaces old six-event capture with one Stop and one static instruction block', async () => {
  const f = await fixture()
  try {
    await mkdir(resolve(f.directory, '.codex'))
    const original = '# Project\nKeep existing rules.\n'
    await writeFile(resolve(f.directory, 'AGENTS.md'), original)
    await writeFile(resolve(f.directory, '.codex/hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ command: 'old', statusMessage: 'jth memo capture' }] }],
      Stop: [{ hooks: [{ command: 'keep-other' }] }],
    } }))
    await configureHooks(f.directory, f.config, f.directory, f.settings.scope, f.home)
    const instructions = await readFile(resolve(f.directory, 'AGENTS.md'), 'utf8')
    assert(instructions.includes('短回复明确采纳前文方案'))
    assert(instructions.includes('confirmation_quote'))
    assert(instructions.includes('上下文压缩和恢复时接续'))
    await configureHooks(f.directory, f.config, f.directory, f.settings.scope, f.home)
    assert.equal(await readFile(resolve(f.directory, 'AGENTS.md'), 'utf8'), instructions)
    const hooks = JSON.parse(await readFile(resolve(f.directory, '.codex/hooks.json'), 'utf8')).hooks
    assert.deepEqual(Object.keys(hooks), ['Stop'])
    assert(hooks.Stop.flatMap((group: { hooks: { command: string }[] }) => group.hooks).some((hook: { command: string }) => hook.command.includes("'declare'")))
    await configureHooks(f.directory, f.config, f.directory, undefined, f.home)
    assert.equal(await readFile(resolve(f.directory, 'AGENTS.md'), 'utf8'), original)
  } finally { await f.cleanup() }
})
