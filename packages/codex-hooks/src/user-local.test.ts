import assert from 'node:assert/strict'
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sessionWorkspaceContext } from './workspace.ts'
import { captureSettingsSchema, codexDirectory, hash, readJson, userInstallationPath } from './capture.ts'
import { cleanupProjectInstallation, configureUserHooks, hookCommand, legacyCleanupCommand, legacyCleanupMarker, mergeHooks, ownsHook, quote } from './install.ts'
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
    const cleanupOtherCommand = { command: 'third-party', statusMessage: legacyCleanupMarker }
    const cleanupOtherMarker = { command: legacyCleanupCommand, statusMessage: 'team cleanup' }
    const cleanup = { type: 'command', command: legacyCleanupCommand, timeout: 3, statusMessage: legacyCleanupMarker, additionalContextLimit: 512 }
    const teamConfig = { description: 'team', hooks: {
      Stop: [{ matcher: 'team', hooks: [unrelated, otherMarker] }],
      SessionStart: [{ matcher: 'team', hooks: [cleanupOtherCommand, cleanupOtherMarker] }],
      SessionEnd: [{ hooks: [otherEvent, cleanup] }],
    } }
    await writeFile(resolve(f.home, 'hooks.json'), JSON.stringify({ ...teamConfig, hooks: {
      ...teamConfig.hooks, SessionStart: [...teamConfig.hooks.SessionStart, { hooks: [cleanup, cleanup] }],
    } }))
    const installed = await configureUserHooks(root, f.config, f.home, true, f.userHome)
    const before = await readFile(installed.hooks_path, 'utf8')
    await configureUserHooks(root, f.config, f.home, true, f.userHome)
    assert.equal(await readFile(installed.hooks_path, 'utf8'), before)
    const document = JSON.parse(before)
    assert.equal(document.description, 'team')
    assert.deepEqual(document.hooks.Stop[0], { matcher: 'team', hooks: [unrelated, otherMarker] })
    assert.deepEqual(document.hooks.SessionEnd, [{ hooks: [otherEvent, cleanup] }])
    assert.deepEqual(document.hooks.SessionStart[0], teamConfig.hooks.SessionStart[0])
    const sessionHandlers = document.hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) => group.hooks)
    assert.deepEqual(sessionHandlers.filter((handler: { command: string, statusMessage: string }) => handler.command === legacyCleanupCommand && handler.statusMessage === legacyCleanupMarker), [cleanup])
    assert(sessionHandlers.some((handler: { command: string }) => handler.command === hookCommand('memo', 'codex', 'cue')))
    assert(document.hooks.UserPromptSubmit.flatMap((group: { hooks: { command: string }[] }) => group.hooks).some((handler: { command: string }) => handler.command === hookCommand('flow', 'prompt')))
    assert.equal(document.hooks.Stop.flatMap((group: { hooks: unknown[] }) => group.hooks).length, 3)
    assert((await readFile(resolve(f.userHome, '.agents/skills/jth-memo/references/declarations.md'), 'utf8')).includes('workspaces'))
    assert((await readFile(resolve(f.userHome, '.agents/skills/jth-flow/references/acceptance.md'), 'utf8')).includes('任务验收'))
    for (const kind of ['memo', 'flow', 'analysis']) {
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

test('analysis Skill uses the existing Skill Manager canonical directory and preserves foreign projections', async () => {
  const f = await fixture()
  const manager = resolve(f.userHome, '.skills-manager/skills'), canonical = resolve(manager, 'jth-analysis'), projection = resolve(f.userHome, '.agents/skills/jth-analysis')
  try {
    await mkdir(manager, { recursive: true })
    await configureUserHooks(root, f.config, f.home, true, f.userHome)
    assert((await lstat(projection)).isSymbolicLink())
    assert((await lstat(canonical)).isDirectory())
    assert.equal(await realpath(projection), canonical)
    assert((await readFile(resolve(projection, 'SKILL.md'), 'utf8')).includes('jth analysis'))
    for (const kind of ['flow', 'memo']) assert((await lstat(resolve(f.userHome, '.agents/skills', `jth-${kind}`))).isDirectory())
    await configureUserHooks(root, f.config, f.home, true, f.userHome)
    assert.equal(await realpath(projection), canonical)
    assert.deepEqual(await readdir(manager), ['jth-analysis'])
    await configureUserHooks(root, f.config, f.home, false, f.userHome)
    await assert.rejects(lstat(projection), { code: 'ENOENT' })
    await assert.rejects(lstat(canonical), { code: 'ENOENT' })
    assert((await lstat(manager)).isDirectory())

    await configureUserHooks(root, f.config, f.home, true, f.userHome)
    const foreign = resolve(f.directory, 'foreign-analysis')
    await mkdir(foreign)
    await writeFile(resolve(foreign, 'SKILL.md'), '---\nname: foreign-analysis\n---\nKeep this Skill.\n')
    await rm(projection)
    await symlink(foreign, projection)
    await assert.rejects(configureUserHooks(root, f.config, f.home, true, f.userHome), /投影指向其他位置/)
    await configureUserHooks(root, f.config, f.home, false, f.userHome)
    assert.equal(await realpath(projection), foreign)
    assert.equal(await readFile(resolve(foreign, 'SKILL.md'), 'utf8'), '---\nname: foreign-analysis\n---\nKeep this Skill.\n')
  } finally { await f.cleanup() }
})

test('analysis installation refuses unrelated canonical content and uninstall preserves it', async () => {
  const f = await fixture()
  const canonical = resolve(f.userHome, '.skills-manager/skills/jth-analysis'), projection = resolve(f.userHome, '.agents/skills/jth-analysis')
  try {
    await mkdir(canonical, { recursive: true })
    await mkdir(dirname(projection), { recursive: true })
    const foreign = '---\nname: independent-analysis\n---\nIndependent Skill content.\n'
    await writeFile(resolve(canonical, 'SKILL.md'), foreign)
    await symlink(canonical, projection)
    await assert.rejects(configureUserHooks(root, f.config, f.home, true, f.userHome), /不属于 JTH/)
    assert.equal(await readFile(resolve(canonical, 'SKILL.md'), 'utf8'), foreign)
    await configureUserHooks(root, f.config, f.home, false, f.userHome)
    assert.equal(await realpath(projection), canonical)
    assert.equal(await readFile(resolve(canonical, 'SKILL.md'), 'utf8'), foreign)
  } finally { await f.cleanup() }
})

test('installation preserves content-addressed rule history and does not claim the rules were loaded', async () => {
  const f = await fixture()
  const source = resolve(f.directory, 'source'), snapshots = resolve(codexDirectory(f.config), 'rule-snapshots')
  try {
    await mkdir(source)
    for (const kind of ['flow', 'memo', 'analysis']) await cp(resolve(root, `packages/${kind}/skills/jth-${kind}`), resolve(source, `packages/${kind}/skills/jth-${kind}`), { recursive: true })
    await writeFile(resolve(source, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const first = await configureUserHooks(source, f.config, f.home, true, f.userHome)
    assert.match(first.settings.rule_snapshot_id!, /^[0-9a-f]{64}$/)
    const original = await readFile(resolve(snapshots, `${first.settings.rule_snapshot_id}.json`), 'utf8')
    const snapshot = JSON.parse(original)
    const { id, ...content } = snapshot
    assert.equal(hash(JSON.stringify(content)), id)
    assert.equal(snapshot.packageVersion, '1.0.0')
    for (const kind of ['flow', 'memo', 'analysis']) assert(snapshot.files.some((file: { path: string }) => file.path === `packages/${kind}/skills/jth-${kind}/SKILL.md`))
    for (const file of snapshot.files) assert.equal(file.sha256, hash(file.text))
    assert.equal(snapshot.loaded, undefined)
    const same = await configureUserHooks(source, f.config, f.home, true, f.userHome)
    assert.equal(same.settings.rule_snapshot_id, first.settings.rule_snapshot_id)
    await writeFile(resolve(snapshots, `${first.settings.rule_snapshot_id}.json`), 'null\n')
    await assert.rejects(configureUserHooks(source, f.config, f.home, true, f.userHome), /没有覆盖历史快照/)
    assert.equal(await readFile(resolve(snapshots, `${first.settings.rule_snapshot_id}.json`), 'utf8'), 'null\n')
    await writeFile(resolve(snapshots, `${first.settings.rule_snapshot_id}.json`), original)
    await writeFile(resolve(source, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    await appendFile(resolve(source, 'packages/analysis/skills/jth-analysis/SKILL.md'), '\nNew source rule.\n')
    const updated = await configureUserHooks(source, f.config, f.home, true, f.userHome)
    assert.notEqual(updated.settings.rule_snapshot_id, first.settings.rule_snapshot_id)
    assert.equal(await readFile(resolve(snapshots, `${first.settings.rule_snapshot_id}.json`), 'utf8'), original)
    assert.equal((await readdir(snapshots)).length, 2)
    await configureUserHooks(source, f.config, f.home, false, f.userHome)
    assert.equal((await readdir(snapshots)).length, 2)
  } finally { await f.cleanup() }
})

test('upgrade preflight leaves installed rules, hooks and manifest unchanged for foreign projections or conflicting snapshots', async () => {
  const f = await fixture()
  const source = resolve(f.directory, 'source'), manager = resolve(f.userHome, '.skills-manager/skills'), projection = resolve(f.userHome, '.agents/skills/jth-analysis')
  const snapshots = resolve(codexDirectory(f.config), 'rule-snapshots'), manifestPath = userInstallationPath(f.config, f.home), hooksPath = resolve(f.home, 'hooks.json')
  try {
    await mkdir(source)
    await mkdir(manager, { recursive: true })
    for (const kind of ['flow', 'memo', 'analysis']) await cp(resolve(root, `packages/${kind}/skills/jth-${kind}`), resolve(source, `packages/${kind}/skills/jth-${kind}`), { recursive: true })
    await writeFile(resolve(source, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const installed = await configureUserHooks(source, f.config, f.home, true, f.userHome)
    const paths = ['flow', 'memo', 'analysis'].map(kind => resolve(f.userHome, `.agents/skills/jth-${kind}/SKILL.md`))
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')))
    const hooks = await readFile(hooksPath, 'utf8'), manifest = await readFile(manifestPath, 'utf8')
    const snapshot = JSON.parse(await readFile(resolve(snapshots, `${installed.settings.rule_snapshot_id}.json`), 'utf8')) as { files: { path: string, text: string, sha256: string }[] }
    const memoPath = 'packages/memo/skills/jth-memo/SKILL.md'
    await appendFile(resolve(source, memoPath), '\nChanged Memo source before rejected upgrade.\n')
    await writeFile(resolve(source, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    const memoText = await readFile(resolve(source, memoPath), 'utf8')
    const foreign = resolve(f.directory, 'foreign')
    await mkdir(foreign)
    await writeFile(resolve(foreign, 'SKILL.md'), '---\nname: unrelated\n---\nKeep external content.\n')
    await rm(projection)
    await symlink(foreign, projection)
    await assert.rejects(configureUserHooks(source, f.config, f.home, true, f.userHome), /投影指向其他位置/)
    assert.deepEqual(await Promise.all(paths.slice(0, 2).map(path => readFile(path, 'utf8'))), before.slice(0, 2))
    assert.equal(await readFile(hooksPath, 'utf8'), hooks)
    assert.equal(await readFile(manifestPath, 'utf8'), manifest)
    assert.equal(await realpath(projection), foreign)
    await rm(projection)
    await symlink(resolve(manager, 'jth-analysis'), projection)
    const content = { schemaVersion: 1, packageVersion: '1.1.0', files: snapshot.files.map(file => file.path === memoPath ? { ...file, text: memoText, sha256: hash(memoText) } : file) }
    const prospectiveId = hash(JSON.stringify(content)), prospectivePath = resolve(snapshots, `${prospectiveId}.json`)
    await writeFile(prospectivePath, 'null\n')
    await assert.rejects(configureUserHooks(source, f.config, f.home, true, f.userHome), /没有覆盖历史快照/)
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before)
    assert.equal(await readFile(hooksPath, 'utf8'), hooks)
    assert.equal(await readFile(manifestPath, 'utf8'), manifest)
    assert.equal(await readFile(prospectivePath, 'utf8'), 'null\n')
  } finally { await f.cleanup() }
})

test('an update failure after preflight invalidates the previous rule snapshot instead of mislabeling new rules', async () => {
  const f = await fixture()
  const source = resolve(f.directory, 'source'), manifestPath = userInstallationPath(f.config, f.home)
  try {
    await mkdir(source)
    for (const kind of ['flow', 'memo', 'analysis']) await cp(resolve(root, `packages/${kind}/skills/jth-${kind}`), resolve(source, `packages/${kind}/skills/jth-${kind}`), { recursive: true })
    await writeFile(resolve(source, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const installed = await configureUserHooks(source, f.config, f.home, true, f.userHome)
    await appendFile(resolve(source, 'packages/memo/skills/jth-memo/SKILL.md'), '\nNew rule in an interrupted installation.\n')
    await writeFile(resolve(source, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    await writeFile(resolve(f.home, 'hooks.json'), '{"hooks":false}\n')
    await assert.rejects(configureUserHooks(source, f.config, f.home, true, f.userHome), /已有 Hook 配置无效/)
    assert((await readFile(resolve(f.userHome, '.agents/skills/jth-memo/SKILL.md'), 'utf8')).includes('New rule in an interrupted installation.'))
    const manifest = await readJson(manifestPath) as { settings: { rule_snapshot_id?: string, env_file: string }, disabled: boolean }
    assert.equal(manifest.settings.rule_snapshot_id, undefined)
    assert.equal(manifest.settings.env_file, f.config.envFile)
    assert.equal(manifest.disabled, false)
    assert(await readJson(resolve(codexDirectory(f.config), 'rule-snapshots', `${installed.settings.rule_snapshot_id}.json`)))
  } finally { await f.cleanup() }
})

test('legacy cleanup ownership requires the exact SessionStart command and marker', () => {
  const handler = { command: legacyCleanupCommand, statusMessage: legacyCleanupMarker }
  assert(ownsHook(handler, legacyCleanupMarker, 'SessionStart'))
  assert(!ownsHook(handler, legacyCleanupMarker, 'UserPromptSubmit'))
  assert(!ownsHook(handler))
  assert(!ownsHook({ ...handler, statusMessage: 'team cleanup' }, legacyCleanupMarker, 'SessionStart'))
  for (const command of ['jth migrate --session-start', `${legacyCleanupCommand} --workspace /project`, hookCommand('migrate'), hookCommand('migrate', '--dry-run')]) {
    assert(!ownsHook({ ...handler, command }, legacyCleanupMarker, 'SessionStart'))
  }
})

test('migration dry run and cleanup preserve teams, other Skills, AGENTS instructions and all historical runtime queues without backups', async () => {
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
    await assert.rejects(readdir(resolve(f.config.dataDir, 'codex/backups')), { code: 'ENOENT' })
    assert((await readFile(resolve(f.a, '.jth/flow.json'), 'utf8')).includes('old'))
    const actual = await cleanupProjectInstallation(f.a, { ...f.config, registered: true })
    assert.deepEqual(actual.removed, dry.removed)
    assert.deepEqual(JSON.parse(await readFile(resolve(f.a, '.codex/hooks.json'), 'utf8')), { hooks: { Stop: [{ matcher: 'team', hooks: [teams] }] } })
    assert.equal(await readFile(resolve(f.a, 'AGENTS.md'), 'utf8'), '# Team\nKeep this.\n')
    assert.equal(await readFile(resolve(f.a, '.gitignore'), 'utf8'), 'node_modules/\nkeep-custom/\n/.jth/\n')
    for (const name of preserved) assert.equal(await readFile(resolve(f.a, '.jth', name), 'utf8'), 'historical')
    assert((await readdir(resolve(f.a, '.agents/skills'))).includes('custom'))
    for (const directory of ['.codex/skills', '.claude/skills']) assert.deepEqual(await readdir(resolve(f.a, directory)), ['custom'])
    assert.equal(Object.hasOwn(actual, 'backup_directory'), false)
    await assert.rejects(readdir(resolve(f.config.dataDir, 'codex/backups')), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('existing-only cleanup leaves registered clean projects alone and removes only exact legacy ignore rules', async () => {
  const f = await fixture()
  try {
    const options = { ...f.config, registered: true, existingOnly: true }
    assert.deepEqual((await cleanupProjectInstallation(f.a, options)).removed, [])
    assert.deepEqual(await readdir(f.a), [])
    const custom = 'node_modules/\n# /.jth/*\n /.codex/hooks.json\n/.agents/skills/jth-memo-extra\n'
    await writeFile(resolve(f.a, '.gitignore'), custom)
    assert.deepEqual((await cleanupProjectInstallation(f.a, options)).removed, [])
    assert.equal(await readFile(resolve(f.a, '.gitignore'), 'utf8'), custom)
    await writeFile(resolve(f.a, '.gitignore'), custom + '/.jth/*\n!/.jth/flow.json\n!/.jth/workflow.json\n/.agents/skills/jth-flow\n/.agents/skills/jth-memo\n/.codex/hooks.json')
    assert.deepEqual((await cleanupProjectInstallation(f.a, options)).removed, [`${f.a}/.gitignore#JTH`])
    assert.equal(await readFile(resolve(f.a, '.gitignore'), 'utf8'), custom + '/.jth/\n')
    assert.deepEqual((await cleanupProjectInstallation(f.a, options)).removed, [])
    await mkdir(resolve(f.b, '.jth'))
    await writeFile(resolve(f.b, '.jth/memo.json'), '{"version":3,"scope":{"project_ids":["old"],"business_ids":[]}}')
    await cleanupProjectInstallation(f.b, options)
    assert.equal(await readFile(resolve(f.b, '.gitignore'), 'utf8'), '/.jth/\n')
    await assert.rejects(readdir(resolve(f.config.dataDir, 'codex/backups')), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('cleanup preflight rejects configuration leaf symlinks before changing any owned files', async () => {
  for (const name of ['.codex/hooks.json', '.jth/memo.json', 'AGENTS.md', '.gitignore']) {
    const f = await fixture()
    try {
      await mkdir(resolve(f.a, '.codex'))
      await mkdir(resolve(f.a, '.jth'))
      const locator = '{"version":3,"scope":{"project_ids":["old"],"business_ids":[]}}'
      await writeFile(resolve(f.a, '.jth/flow.json'), locator)
      const outside = resolve(f.b, 'outside'), content = name.endsWith('hooks.json')
        ? JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: hookCommand('memo', 'codex', 'declare'), statusMessage: 'jth memo declaration' }] }] } })
        : name.endsWith('memo.json') ? locator : name === 'AGENTS.md' ? '<!-- JTH_MEMORY_START -->\nold\n<!-- JTH_MEMORY_END -->\n' : '/.jth/*\n'
      await writeFile(outside, content)
      await symlink(outside, resolve(f.a, name))
      await assert.rejects(cleanupProjectInstallation(f.a, { ...f.config, registered: true, existingOnly: true }), /符号链接；保留内容/)
      assert.equal(await readFile(outside, 'utf8'), content)
      assert.equal(await readFile(resolve(f.a, '.jth/flow.json'), 'utf8'), locator)
      assert((await lstat(resolve(f.a, name))).isSymbolicLink())
      await assert.rejects(readdir(resolve(f.config.dataDir, 'codex/backups')), { code: 'ENOENT' })
    } finally { await f.cleanup() }
  }
})

test('cleanup preflight rejects external Skill parents without deleting the other checkout or local artifacts', async () => {
  const f = await fixture()
  try {
    await mkdir(resolve(f.a, '.agents'))
    await mkdir(resolve(f.a, '.jth'))
    await mkdir(resolve(f.b, 'jth-memo'))
    const skill = '---\nname: jth-memo\n---\njth memo read\n'
    await writeFile(resolve(f.b, 'jth-memo/SKILL.md'), skill)
    await symlink(f.b, resolve(f.a, '.agents/skills'))
    const locator = '{"version":3,"scope":{"project_ids":["old"],"business_ids":[]}}'
    await writeFile(resolve(f.a, '.jth/memo.json'), locator)
    await assert.rejects(cleanupProjectInstallation(f.a, { ...f.config, registered: true, existingOnly: true }), /父目录不在项目内/)
    assert.equal(await readFile(resolve(f.b, 'jth-memo/SKILL.md'), 'utf8'), skill)
    assert.equal(await readFile(resolve(f.a, '.jth/memo.json'), 'utf8'), locator)
    await assert.rejects(readdir(resolve(f.config.dataDir, 'codex/backups')), { code: 'ENOENT' })
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
