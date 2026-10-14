import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { parse } from '@decimalturn/toml-patch'
import { configureHooks, configureFlowHooks, hookCommand, installationPath, readJson, writeJson } from '@jacob-z/jt-harness/codex-hooks'
import { loadConfig } from '@jacob-z/jt-harness/memo/config'
import { automaticWorkspaceScope, findLegacyWorkspace, importLegacyBindings, loadLegacyWorkspaceConfig, loadWorkspaceConfig, saveUserConfigBinding, workspaceBinding } from './configuration.ts'

const root = resolve(import.meta.dirname, '../../..')
const execute = promisify(execFile)
const fixtureEnv = (fixture: string) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(JTH_|EMBEDDING_|CODEX_)/.test(name))), HOME: fixture, CODEX_HOME: resolve(fixture, 'codex'), JTH_CONFIG_DIR: resolve(fixture, 'user'),
  JTH_ENV_FILE: undefined, JTH_DATA_DIR: undefined, JTH_DATABASE_URL: undefined, CODEX_THREAD_ID: undefined, EMBEDDING_BASE_URL: undefined })

test('automatic groups distinguish same-name directories, read legacy aliases and default to the bound primary', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-directory-groups-')))
  const environment = fixtureEnv(fixture), a = resolve(fixture, 'a/project'), b = resolve(fixture, 'b/project'), home = environment.CODEX_HOME
  try {
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true }); await mkdir(resolve(home, 'sessions'), { recursive: true })
    const bindingA = await workspaceBinding(a, environment, { projectIds: ['legacy-a'] })
    const bindingB = await workspaceBinding(b, environment, { readProjectIds: ['legacy-a'] })
    assert.deepEqual(bindingA.project_ids, ['legacy-a'])
    assert.notDeepEqual(bindingB.project_ids, bindingA.project_ids)
    assert(bindingB.read_project_ids.includes('legacy-a'))
    const transcript = resolve(home, 'sessions/rollout-session-bindings.jsonl')
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'session-bindings', cwd: a, runtime_workspace_roots: [a, b] } }) + '\n')
    const context = await automaticWorkspaceScope({ cwd: b, session_id: 'session-bindings', transcript_path: transcript }, home, environment)
    assert.equal(context.workspaces[0].path, a)
    assert.deepEqual(context.workspaces[1].project_ids, bindingB.project_ids)
    assert(context.scope.project_ids.includes('legacy-a'))
    assert.equal(context.workspaces.length, 2)
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'session-bindings', cwd: a, runtime_workspace_roots: [] } }) + '\n')
    const unbound = await automaticWorkspaceScope({ cwd: a, session_id: 'session-bindings', transcript_path: transcript }, home, environment)
    assert.deepEqual(unbound.scope.project_ids, ['default'])
    assert.deepEqual(unbound.workspaces, [{ path: a, project_ids: ['default'], business_ids: [] }])
    const manual = await automaticWorkspaceScope({ cwd: a }, home, environment)
    assert.deepEqual(manual.scope.project_ids, ['legacy-a'])
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('global config selection overrides old per-project bindings and survives outside that project', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-global-config-')))
  const environment = fixtureEnv(fixture), selected = resolve(fixture, 'selected.env'), explicit = resolve(fixture, 'explicit.env')
  try {
    await mkdir(environment.JTH_CONFIG_DIR, { recursive: true })
    await writeFile(resolve(environment.JTH_CONFIG_DIR, '.env'), 'EMBEDDING_API_KEY=default\n')
    await writeFile(selected, 'EMBEDDING_API_KEY=selected\n')
    await writeFile(explicit, 'EMBEDDING_API_KEY=explicit\n')
    await saveUserConfigBinding(selected, environment)
    assert.equal((await loadWorkspaceConfig(root, undefined, fixture, environment)).embedding.apiKey, 'selected')
    assert.equal((await loadWorkspaceConfig(root, explicit, fixture, environment)).embedding.apiKey, 'explicit')
    assert.equal((await loadWorkspaceConfig(root, undefined, fixture, { ...environment, JTH_ENV_FILE: explicit })).embedding.apiKey, 'explicit')
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('legacy import preserves an existing local write identity and adds historical IDs only for reads', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-write-identity-')))
  const environment = fixtureEnv(fixture), workspace = resolve(fixture, 'project'), config = { dataDir: resolve(fixture, 'data') }
  try {
    await mkdir(workspace)
    await workspaceBinding(workspace, environment, { projectIds: ['new-write'] })
    await writeJson(installationPath(config, workspace), { settings: { workspace, codex_home: environment.CODEX_HOME,
      env_file: resolve(fixture, 'old.env'), enabled_at: '2025-01-01T00:00:00Z', scope: { project_ids: ['old-history'], business_ids: [] } } })
    await importLegacyBindings(config, environment)
    await importLegacyBindings(config, environment)
    const binding = await workspaceBinding(workspace, environment, { dryRun: true })
    assert.deepEqual(binding.project_ids, ['new-write'])
    assert.deepEqual(binding.read_project_ids, ['new-write', 'old-history'])
    assert.equal(binding.legacy.length, 1)
    assert.equal(binding.legacy[0].enabled_at, '2025-01-01T00:00:00Z')
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('migration discovers worktrees, preserves historical IDs and removes only owned project configuration', { timeout: 30000 }, async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-user-migration-')))
  const environment = fixtureEnv(fixture), workspace = resolve(fixture, 'project'), worktree = resolve(fixture, 'extra-worktree'), home = environment.CODEX_HOME
  const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.ts'), ...args], { cwd: workspace, env: environment })).stdout)
  try {
    await mkdir(workspace); await mkdir(environment.JTH_CONFIG_DIR); await mkdir(home)
    await writeFile(resolve(environment.JTH_CONFIG_DIR, '.env'), `JTH_DATA_DIR=${fixture}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/no_live_connection\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nEMBEDDING_API_KEY=fixture\n`)
    const config = await loadConfig(root, undefined, environment)
    await execute('git', ['init', workspace])
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: workspace })
    await execute('git', ['worktree', 'add', '--detach', worktree], { cwd: workspace })
    const old = await configureHooks(root, config, workspace, { project_ids: ['historical-project'], business_ids: [] }, home)
    await configureHooks(root, config, worktree, { project_ids: ['historical-project'], business_ids: [] }, home)
    await configureFlowHooks(root, workspace)
    await writeJson(resolve(workspace, '.jth/flow.json'), { version: 3, scope: old.settings!.scope })
    await writeJson(resolve(worktree, '.jth/flow.json'), { version: 3, scope: old.settings!.scope })
    await writeJson(resolve(workspace, '.jth/workflow.json'), { mode: 'strict' })
    await mkdir(resolve(workspace, '.jth/flow-events')); await writeFile(resolve(workspace, '.jth/flow-events/pending.json'), 'keep exactly')
    await writeFile(resolve(workspace, '.jth/flow.sqlite'), 'historical SQLite bytes')
    await writeFile(resolve(workspace, '.jth/flow-entry.json'), '{"historical":"receipt"}')
    await writeFile(resolve(workspace, '.codex/config.toml'), 'model = "keep-model"\n[memories]\nuse_memories = false\ngenerate_memories = true\n[tools.update_plan]\nenabled = true\nother = "keep"\n')
    const nativeUser = '[memories]\nuse_memories = true\ngenerate_memories = true\n'
    await writeFile(resolve(home, 'config.toml'), nativeUser)
    const hooksFile = resolve(workspace, '.codex/hooks.json'), hooks = await readJson(hooksFile) as { hooks: Record<string, { hooks: object[] }[]> }
    hooks.hooks.Stop.push({ hooks: [{ type: 'command', statusMessage: 'jth memo declaration', command: 'third-party' }] })
    hooks.hooks.PreToolUse = [{ hooks: [{ type: 'command', statusMessage: 'jth flow entry', command: hookCommand('flow', 'prompt') }] }]
    await writeJson(hooksFile, hooks)
    const hooksBefore = await readFile(hooksFile, 'utf8'), ignoreBefore = await readFile(resolve(workspace, '.gitignore'), 'utf8')
    const dry = await cli('migrate', '--dry-run')
    assert.equal(dry.dry_run, true); assert(dry.projects.some((project: { workspace: string }) => project.workspace === worktree))
    assert.equal(await readFile(hooksFile, 'utf8'), hooksBefore)
    assert.equal(await readFile(resolve(workspace, '.gitignore'), 'utf8'), ignoreBefore)
    await assert.rejects(readdir(resolve(config.dataDir, 'codex/migrations')), { code: 'ENOENT' })
    const migrated = await cli('migrate')
    const identities = (report: typeof migrated) => report.projects.map((project: { workspace: string, binding: { project_ids: string[], read_project_ids: string[] } }) =>
      ({ workspace: project.workspace, write: project.binding.project_ids, read: project.binding.read_project_ids }))
    assert.deepEqual(identities(migrated), identities(dry), 'Preview and execution must report identical groups')
    assert.equal(migrated.database_preserved, true); assert.equal(migrated.queues_preserved, true)
    assert((await readFile(resolve(migrated.backup_directory, 'report.json'), 'utf8')).includes('historical-project'))
    const remaining = await readJson(hooksFile) as typeof hooks
    assert.deepEqual(remaining.hooks.Stop, [{ hooks: [{ type: 'command', statusMessage: 'jth memo declaration', command: 'third-party' }] }])
    assert.deepEqual(remaining.hooks.PreToolUse, hooks.hooks.PreToolUse)
    assert.equal(await readFile(resolve(workspace, '.jth/flow-events/pending.json'), 'utf8'), 'keep exactly')
    assert.equal(await readFile(resolve(workspace, '.jth/flow.sqlite'), 'utf8'), 'historical SQLite bytes')
    assert.equal(await readFile(resolve(workspace, '.jth/flow-entry.json'), 'utf8'), '{"historical":"receipt"}')
    assert.equal(await readFile(resolve(home, 'config.toml'), 'utf8'), nativeUser)
    const native = structuredClone(parse(await readFile(resolve(workspace, '.codex/config.toml'), 'utf8')))
    assert.deepEqual(native, { model: 'keep-model', memories: { generate_memories: true }, tools: { update_plan: { other: 'keep' } } })
    await assert.rejects(readFile(resolve(workspace, '.jth/flow.json')), { code: 'ENOENT' })
    const preserved = await readJson(installationPath(config, workspace)) as { settings: typeof old.settings }
    assert.equal(preserved.settings!.enabled_at, old.settings!.enabled_at)
    const a = await workspaceBinding(workspace, environment, { dryRun: true }), b = await workspaceBinding(worktree, environment, { dryRun: true })
    assert.deepEqual(a.project_ids, ['historical-project'])
    assert(!b.project_ids.includes('historical-project')); assert(b.read_project_ids.includes('historical-project'))
    await mkdir(resolve(workspace, 'nested'))
    assert.equal(await findLegacyWorkspace(resolve(workspace, 'nested'), environment), workspace)
    assert.equal((await loadLegacyWorkspaceConfig(root, workspace, undefined, environment)).envFile, config.envFile)
    await importLegacyBindings(config, environment)
    const uninstalled = await cli('uninstall', '--workspace', worktree)
    assert.equal(uninstalled.uninstall_scope, 'workspace-legacy')
    assert((await readFile(resolve(home, 'hooks.json'), 'utf8')).includes('jth flow entry'))
    const removed = await cli('uninstall')
    assert.equal(removed.uninstall_scope, 'user')
    assert(!((await readFile(resolve(home, 'hooks.json'), 'utf8')).includes('jth flow entry')))
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
