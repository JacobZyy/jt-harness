import assert from 'node:assert/strict'
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sessionWorkspaceContext } from './workspace.ts'
import { captureSettingsSchema, readJson, userInstallationPath } from './capture.ts'
import { cleanupProjectInstallation, configureUserHooks, hookCommand, mergeHooks, ownsHook, quote } from './install.ts'
import { captureDeclaration, collectDeclarations, rememberEntryRead } from './declarations.ts'
import { readEvidence } from './evidence.ts'
import { memoryCues } from './cues.ts'
import { flowEntryHook, flowEntryReceiptPath } from './flow-entry.ts'
import { captureMonitor, monitorDirectory } from './monitor.ts'

const at = '2026-01-01T00:00:00Z'
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + '\n'
const message = (id: string, type: string, text: string) => row('event_msg', { type: 'item_completed', thread_id: 'parent', item: { id, type, content: [{ type: 'text', text }] } })
const root = resolve(import.meta.dirname, '../../..')
async function fixture() {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-user-hooks-')))
  const home = resolve(directory, 'codex'), userHome = resolve(directory, 'user'), a = resolve(directory, 'a'), b = resolve(directory, 'b'), source = resolve(home, 'sessions/parent.jsonl')
  await Promise.all([mkdir(resolve(home, 'sessions'), { recursive: true }), mkdir(userHome), mkdir(a), mkdir(b)])
  const config = { dataDir: resolve(directory, 'data'), envFile: resolve(directory, '.env') }
  const settings = captureSettingsSchema.parse({ workspace: a, codex_home: home, env_file: config.envFile, enabled_at: at,
    scope: { project_ids: ['a', 'b', 'old-read-alias'], business_ids: ['biz-a', 'biz-b'] },
    workspaces: [{ path: a, project_ids: ['a'], business_ids: ['biz-a'] }, { path: b, project_ids: ['b'], business_ids: ['biz-b'] }],
  })
  const event = { session_id: 'parent', cwd: a, transcript_path: source }
  await writeFile(source, row('session_meta', { id: 'parent', cwd: a, runtime_workspace_roots: [a, b] }))
  return { directory, home, userHome, a, b, source, config, settings, event, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('session binding reads trusted first-line roots, discovers a missing path, and never treats permission roots as groups', async () => {
  const f = await fixture()
  try {
    await appendFile(f.source, row('turn_context', { workspace_roots: [resolve(f.directory, 'visualizations')] }) + 'not-json-after-first-line\n')
    assert.deepEqual(await sessionWorkspaceContext({ session_id: 'parent', cwd: f.b }, f.home), { cwd: f.b, primary: f.a, roots: [f.a, f.b], source: 'session_meta' })
    assert.deepEqual(await sessionWorkspaceContext({ cwd: f.a }, resolve(f.directory, 'missing-home')), { cwd: f.a, primary: f.a, roots: [f.a], source: 'cwd' })
    await writeFile(f.source, row('session_meta', { id: 'parent', runtime_workspace_roots: [] }))
    assert.deepEqual(await sessionWorkspaceContext(f.event, f.home), { cwd: f.a, primary: null, roots: [], source: 'session_meta' })
    await writeFile(f.source, row('session_meta', { id: 'parent' }) + row('turn_context', { workspace_roots: [f.b] }))
    assert.deepEqual(await sessionWorkspaceContext(f.event, f.home), { cwd: f.a, primary: f.a, roots: [f.a], source: 'cwd' })
    await assert.rejects(sessionWorkspaceContext({ ...f.event, session_id: 'other' }, f.home), /会话不一致/)
    const foreign = resolve(f.directory, 'foreign.jsonl')
    await writeFile(foreign, row('session_meta', { id: 'parent', runtime_workspace_roots: [f.b] }))
    await assert.rejects(sessionWorkspaceContext({ ...f.event, transcript_path: foreign }, f.home), /CODEX_HOME/)
  } finally { await f.cleanup() }
})

test('user installation preserves third-party same-status hooks and copies referenced Skills outside projects', async () => {
  const f = await fixture()
  try {
    const unrelated = { type: 'command', command: 'third-party', statusMessage: 'jth memo declaration' }
    const otherMarker = { command: hookCommand('memo', 'codex', 'declare'), statusMessage: 'team declaration' }
    const otherEvent = { command: hookCommand('memo', 'codex', 'declare'), statusMessage: 'jth memo declaration' }
    const teamConfig = { description: 'team', hooks: { Stop: [{ matcher: 'team', hooks: [unrelated, otherMarker] }], SessionEnd: [{ hooks: [otherEvent] }] } }
    await writeFile(resolve(f.home, 'hooks.json'), JSON.stringify(teamConfig))
    const installed = await configureUserHooks(root, f.config, f.home, true, f.userHome)
    const before = await readFile(installed.hooks_path, 'utf8')
    await configureUserHooks(root, f.config, f.home, true, f.userHome)
    assert.equal(await readFile(installed.hooks_path, 'utf8'), before)
    const document = JSON.parse(before)
    assert.equal(document.description, 'team')
    assert.deepEqual(document.hooks.Stop[0], { matcher: 'team', hooks: [unrelated, otherMarker] })
    assert.deepEqual(document.hooks.SessionEnd, [{ hooks: [otherEvent] }])
    assert.equal(document.hooks.Stop.flatMap((group: { hooks: unknown[] }) => group.hooks).length, 3)
    assert((await readFile(resolve(f.userHome, '.agents/skills/jth-memo/references/declarations.md'), 'utf8')).includes('workspaces'))
    assert((await readFile(resolve(f.userHome, '.agents/skills/jth-flow/references/acceptance.md'), 'utf8')).includes('任务验收'))
    for (const kind of ['memo', 'flow']) {
      const path = resolve(f.userHome, '.agents/skills', `jth-${kind}`, 'SKILL.md')
      const skill = await readFile(path, 'utf8')
      for (const link of skill.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (link[1].startsWith('http') || link[1].startsWith('#')) continue
        assert((await readFile(resolve(dirname(path), link[1]), 'utf8')).length > 0)
      }
    }
    assert.equal(await readJson(resolve(f.a, '.codex/hooks.json')), undefined)
    assert.equal((await readJson(userInstallationPath(f.config, f.home)) as { disabled: boolean }).disabled, false)
    await configureUserHooks(root, f.config, f.home, false, f.userHome)
    assert.deepEqual(JSON.parse(await readFile(installed.hooks_path, 'utf8')), teamConfig)
    assert.deepEqual(mergeHooks({ hooks: { Stop: [{ hooks: [unrelated] }] } }, undefined, { marker: unrelated.statusMessage, events: ['Stop'] }), { hooks: { Stop: [{ hooks: [unrelated] }] } })
  } finally { await f.cleanup() }
})

test('migration dry run and backup preserve teams, other Skills, AGENTS instructions and all historical runtime queues', async () => {
  const f = await fixture()
  try {
    await mkdir(resolve(f.a, '.codex'))
    await mkdir(resolve(f.a, '.jth/flow-events'), { recursive: true })
    await mkdir(resolve(f.a, '.jth/monitor/pending'), { recursive: true })
    await mkdir(resolve(f.a, '.agents/skills/custom'), { recursive: true })
    await mkdir(resolve(f.a, '.agents/skills/jth-memo'), { recursive: true })
    await writeFile(resolve(f.a, '.agents/skills/jth-memo/SKILL.md'), '---\nname: jth-memo\n---\njth memo read\n')
    for (const directory of ['.codex/skills', '.claude/skills']) {
      await mkdir(resolve(f.a, directory, 'jth-flow'), { recursive: true })
      await writeFile(resolve(f.a, directory, 'jth-flow/SKILL.md'), '---\nname: jth-flow\n---\njth flow context\n')
      await mkdir(resolve(f.a, directory, 'custom'), { recursive: true })
    }
    await symlink('/retired/lib/node_modules/@jacob-z/jt-harness/packages/memo/skills/jth-memo', resolve(f.a, '.claude/skills/jth-memo'))
    const teams = { command: 'keep-team', statusMessage: 'jth memo declaration' }
    await writeFile(resolve(f.a, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ matcher: 'team', hooks: [teams, { command: hookCommand('memo', 'codex', 'declare'), statusMessage: 'jth memo declaration' }] }] } }))
    await writeFile(resolve(f.a, '.jth/flow.json'), JSON.stringify({ version: 3, scope: { project_ids: ['old'], business_ids: [] } }))
    await writeFile(resolve(f.a, '.jth/workflow.json'), '{"mode":"strict"}')
    await writeFile(resolve(f.a, '.jth/monitor.json'), '{"enabled":true}')
    const preserved = ['flow-entry.json', 'flow-events/pending.json', 'monitor/pending/old.json', 'tasks.json', 'index-queue.json', 'runtime.json']
    for (const name of preserved) await writeFile(resolve(f.a, '.jth', name), 'historical')
    await writeFile(resolve(f.a, 'AGENTS.md'), '# Team\nKeep this.\n\n<!-- JTH_MEMORY_START -->\nOld JTH guidance.\n<!-- JTH_MEMORY_END -->\n')
    await writeFile(resolve(f.a, '.gitignore'), 'node_modules/\n/.jth/*\n!/.jth/flow.json\n!/.jth/workflow.json\nkeep-custom/\n')
    const dry = await cleanupProjectInstallation(f.a, { ...f.config, dryRun: true, registered: true })
    assert.equal(dry.handlers.length, 1)
    assert.equal(dry.backup_directory, null)
    assert((await readFile(resolve(f.a, '.jth/flow.json'), 'utf8')).includes('old'))
    const actual = await cleanupProjectInstallation(f.a, { ...f.config, registered: true })
    assert.deepEqual(actual.removed, dry.removed)
    assert.deepEqual(JSON.parse(await readFile(resolve(f.a, '.codex/hooks.json'), 'utf8')), { hooks: { Stop: [{ matcher: 'team', hooks: [teams] }] } })
    assert.equal(await readFile(resolve(f.a, 'AGENTS.md'), 'utf8'), '# Team\nKeep this.\n')
    assert.equal(await readFile(resolve(f.a, '.gitignore'), 'utf8'), 'node_modules/\nkeep-custom/\n/.jth/\n')
    for (const name of preserved) assert.equal(await readFile(resolve(f.a, '.jth', name), 'utf8'), 'historical')
    assert((await readdir(resolve(f.a, '.agents/skills'))).includes('custom'))
    for (const directory of ['.codex/skills', '.claude/skills']) assert.deepEqual(await readdir(resolve(f.a, directory)), ['custom'])
    assert(actual.backup_directory && (await readdir(actual.backup_directory)).length >= 5)
    const backedUpSkills = (await readdir(actual.backup_directory!)).filter(name => name.endsWith('-jth-memo'))
    assert(await Promise.all(backedUpSkills.map(name => lstat(resolve(actual.backup_directory!, name)))).then(stats => stats.some(info => info.isSymbolicLink())))
  } finally { await f.cleanup() }
})

test('historical packaged Hook commands require exact command, marker, event and supported options', () => {
  const memo = ['/runtime/bin/node', '--', '/packages/lib/node_modules/@jacob-z/jt-harness/bin/jth.mjs', 'memo', 'codex', 'declare',
    '--env-file', '/user/.jt-harness/.env', '--workspace', '/source/workspace', '--codex-home', '/user/.codex', '--since', at, '--project', 'old']
  const handler = { command: memo.map(quote).join(' '), statusMessage: 'jth memo declaration' }
  assert(ownsHook(handler, handler.statusMessage, 'Stop'))
  assert(!ownsHook(handler, handler.statusMessage, 'SessionEnd'))
  assert(!ownsHook({ ...handler, statusMessage: 'team declaration' }, handler.statusMessage, 'Stop'))
  assert(!ownsHook({ ...handler, command: memo.concat('--unknown', 'value').map(quote).join(' ') }, handler.statusMessage, 'Stop'))
  assert(!ownsHook({ ...handler, command: memo.map(word => word.endsWith('/jth.mjs') ? '/other/bin/jth.mjs' : word).map(quote).join(' ') }, handler.statusMessage, 'Stop'))
  assert(!ownsHook({ ...handler, command: `${handler.command}; third-party` }, handler.statusMessage, 'Stop'))
  const flow = { command: ['/runtime/bin/node', '--', '/packages/lib/node_modules/@jacob-z/jt-harness/bin/jth.mjs', 'flow', 'prompt', '--workspace', '/source/workspace'].map(quote).join(' '), statusMessage: 'jth flow entry' }
  assert(ownsHook(flow, flow.statusMessage, 'UserPromptSubmit'))
})

test('project declarations route each selected set once and preserve source locations, corrections, derivations and used receipts', async () => {
  const f = await fixture(), target = randomUUID(), derived = randomUUID(), used = randomUUID()
  try {
    await Promise.all([
      rememberEntryRead(f.config, 'parent', target, 'a'.repeat(64)),
      rememberEntryRead(f.config, 'parent', derived, 'b'.repeat(64), 'evidence'),
      rememberEntryRead(f.config, 'parent', used, 'c'.repeat(64), 'summary'),
    ])
    const text = `<!-- jth-memory ${JSON.stringify({ items: [
      { text: 'A 使用 pnpm。', quote: 'A 使用 pnpm', scope: 'project', basis: 'user_statement' },
      { text: 'B 使用 bun。', quote: 'B 使用 bun', scope: 'project', basis: 'user_statement', workspaces: [f.b], change: { kind: 'correction', target } },
      { text: '共同使用 TypeScript。', quote: '共同使用 TypeScript', scope: 'project', basis: 'user_statement', workspaces: [f.b, f.a] },
    ], used: [used] })} -->`
    await appendFile(f.source, message('u', 'UserMessage', 'A 使用 pnpm，B 使用 bun，共同使用 TypeScript。') + message('p', 'AgentMessage', '建议 B 统一入口。')
      + row('event_msg', { type: 'item_completed', thread_id: 'parent', item: { type: 'CollabAgentToolCall', id: 'collab' } })
      + row('event_msg', { type: 'item_completed', thread_id: 'parent', item: { type: 'HookPrompt', id: 'injected', content: '禁止作为真实证据' } })
      + message('final', 'AgentMessage', text))
    const capture = () => captureDeclaration({ ...f.event, hook_event_name: 'Stop', transcript_path: undefined, last_assistant_message: text }, f.settings, f.config)
    await capture(); await capture()
    assert.deepEqual(await collectDeclarations(f.config), { received: 2, skipped: 0, errors: [] })
    const files = await readdir(resolve(f.config.dataDir, 'codex/records'))
    assert.equal(files.length, 3)
    const records = await Promise.all(files.map(async file => {
      const record = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', file), 'utf8'))
      return { record, evidence: await readEvidence(f.config, record.evidence_id) }
    }))
    const forScope = (ids: string[]) => records.find(({ evidence }) => JSON.stringify(evidence.submission.scope.project_ids) === JSON.stringify(ids))!
    assert.equal(forScope(['a']).record.draft.extraction.memories[0].content, 'A 使用 pnpm。')
    assert.deepEqual(forScope(['a']).record.draft.used, [{ entry_id: used, read_version: 'c'.repeat(64) }])
    assert.equal(forScope(['b']).record.draft.changes[0].expected_version, 'a'.repeat(64))
    assert.equal(forScope(['a', 'b']).record.draft.extraction.memories.length, 1)
    for (const { evidence } of records) {
      assert(!evidence.submission.scope.project_ids.includes('old-read-alias'))
      assert(evidence.submission.messages.every(item => item.location?.path === f.source && item.location.end > item.location.start))
      assert(!evidence.submission.messages.some(item => item.text.includes('禁止作为真实证据')))
    }
    const inference = `<!-- jth-memory ${JSON.stringify({ items: [
      { text: '建议 B 统一入口。', quote: '建议 B 统一入口', scope: 'project', basis: 'agent_inference', workspaces: [f.b], derived_from: [derived] },
    ] })} -->`
    await appendFile(f.source, message('inference', 'AgentMessage', inference))
    await captureDeclaration({ ...f.event, hook_event_name: 'Stop', last_assistant_message: inference }, f.settings, f.config)
    assert.equal((await collectDeclarations(f.config)).received, 1)
    const newFile = (await readdir(resolve(f.config.dataDir, 'codex/records'))).find(file => !files.includes(file))!
    const proposal = JSON.parse(await readFile(resolve(f.config.dataDir, 'codex/records', newFile), 'utf8'))
    assert.equal(proposal.draft.derivations[0].sources[0].read_version, 'b'.repeat(64))
    assert.deepEqual((await readEvidence(f.config, proposal.evidence_id)).submission.scope.project_ids, ['b'])
    const invalid = `<!-- jth-memory ${JSON.stringify({ items: [{ text: 'A 使用 pnpm。', quote: 'A 使用 pnpm', scope: 'project', basis: 'user_statement', workspaces: [f.directory] }] })} -->`
    await appendFile(f.source, message('invalid', 'AgentMessage', invalid))
    await captureDeclaration({ ...f.event, hook_event_name: 'Stop', last_assistant_message: invalid }, f.settings, f.config)
    assert.match((await collectDeclarations(f.config)).errors[0].error, /绑定工作目录/)
  } finally { await f.cleanup() }
})

test('global cues read joined aliases while routing guidance and user runtime stay out of project files', async () => {
  const f = await fixture()
  try {
    await configureUserHooks(root, f.config, f.home, true, f.userHome)
    const calls: unknown[] = []
    const storage = { retrieve: async (input: unknown) => { calls.push(input); return { entries: [] } } } as unknown as Parameters<typeof memoryCues>[3]
    await memoryCues({ ...f.event, hook_event_name: 'SessionStart' }, f.settings, f.config, storage)
    const cue = await memoryCues({ ...f.event, hook_event_name: 'UserPromptSubmit', prompt: '历史依据' }, f.settings, f.config, storage)
    assert.deepEqual((calls[0] as { scope: unknown }).scope, { kind: 'project', project_ids: ['a', 'b', 'old-read-alias'] })
    const context = JSON.parse(cue.hookSpecificOutput!.additionalContext)
    assert.deepEqual(context.workspace_routing.workspaces.map((workspace: { path: string }) => workspace.path), [f.a, f.b])
    assert.equal(context.workspace_routing.primary, f.a)
    const flow = await flowEntryHook({ ...f.event, hook_event_name: 'UserPromptSubmit' }, f.a, { ...f.config, userHome: f.userHome })
    assert(flow.hookSpecificOutput?.additionalContext)
    assert(await readJson(flowEntryReceiptPath(f.a, f.config)))
    const monitor = await captureMonitor({ ...f.event, hook_event_name: 'UserPromptSubmit', transcript_path: undefined }, f.a, f.home, { ...f.config, enabled: true })
    assert(monitor?.startsWith(monitorDirectory(f.a, f.config)))
    assert.equal(await readJson(resolve(f.a, '.jth/flow-entry.json')), undefined)
    assert.equal(await readJson(resolve(f.a, '.jth/monitor.json')), undefined)
  } finally { await f.cleanup() }
})
