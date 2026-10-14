import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { configureHooks, configureUserHooks, codexDirectory, hash, legacyCleanupCommand, readJson, writeJson, quote } from '@jacob-z/jt-harness/codex-hooks'
import { loadConfig } from '@jacob-z/jt-harness/memo/config'
import { workspaceBinding } from './configuration.ts'
import { configureWorkflowPolicy, workflowSettingsPaths } from './workflow-settings.ts'

const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)

async function fixture() {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-session-cleanup-')))
  const home = resolve(directory, 'codex'), user = resolve(directory, 'user'), a = resolve(directory, 'a'), b = resolve(directory, 'b'), other = resolve(directory, 'other')
  let connections = 0
  const server = createServer(socket => { connections++; socket.destroy() })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string')
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(JTH_|EMBEDDING_|CODEX_)/.test(name))),
    HOME: directory, CODEX_HOME: home, JTH_CONFIG_DIR: user, PATH: `${directory}/bin:${process.env.PATH}` }
  for (const path of [a, b, other, user, resolve(home, 'sessions'), resolve(directory, 'bin')]) await mkdir(path, { recursive: true })
  await symlink(resolve(root, 'bin/jth.ts'), resolve(directory, 'bin/jth'))
  await writeFile(resolve(user, '.env'), `JTH_DATA_DIR=${directory}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:${address.port}/must_not_connect\nEMBEDDING_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBEDDING_API_KEY=fixture\nEMBEDDING_MODEL=fixture\nEMBEDDING_DIMENSIONS=2\n`)
  const config = await loadConfig(root, undefined, environment)
  await configureUserHooks(root, config, home, true, directory)
  const input = resolve(directory, 'event.json'), transcript = resolve(home, 'sessions/rollout-cleanup-session.jsonl')
  const bind = async (roots: string[]) => {
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'cleanup-session', cwd: a, runtime_workspace_roots: roots } }) + '\n')
    await writeJson(input, { hook_event_name: 'SessionStart', session_id: 'cleanup-session', cwd: a, transcript_path: transcript })
  }
  await bind([a, b])
  const hook = async () => {
    const result = await execute('/bin/sh', ['-c', `${legacyCleanupCommand} < ${quote(input)}`], { cwd: a, env: environment })
    return { ...result, output: JSON.parse(result.stdout) }
  }
  const legacy = async (workspace: string, project: string) => {
    await configureHooks(root, config, workspace, { project_ids: [project], business_ids: [] }, home)
    await writeJson(resolve(workspace, '.jth/flow.json'), { version: 3, scope: { project_ids: [project], business_ids: [] } })
    await writeFile(resolve(workspace, '.codex/config.toml'), 'model = "keep-model"\n[memories]\nuse_memories = false\ngenerate_memories = false\n[tools.update_plan]\nenabled = true\n')
  }
  const dispose = async () => { assert.equal(connections, 0); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }) }
  return { directory, home, user, a, b, other, environment, config, input, bind, hook, legacy, dispose }
}

test('SessionStart cleans restored bound directories, preserves local policy and IDs, and leaves unrelated installations untouched', { timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    await f.legacy(f.a, 'old-a'); await f.legacy(f.b, 'old-b'); await f.legacy(f.other, 'old-other')
    await writeJson(resolve(f.b, '.jth/workflow.json'), { mode: 'bogus' })
    await workspaceBinding(f.a, f.environment, { projectIds: ['current-a'] })
    await configureWorkflowPolicy(f.a, 'project', 'adaptive', f.environment)
    await writeJson(resolve(f.a, '.jth/workflow.json'), { mode: 'strict' })
    await writeFile(resolve(f.a, 'business.txt'), 'keep business bytes')
    await writeFile(resolve(f.a, '.jth/flow.sqlite'), 'keep history bytes')
    const hooksPath = resolve(f.a, '.codex/hooks.json'), hooks = await readJson(hooksPath) as { hooks: Record<string, unknown[]> }
    const team = { hooks: [{ type: 'command', command: 'team-check', statusMessage: 'team' }], matcher: 'startup' }
    hooks.hooks.SessionStart.push(team); await writeJson(hooksPath, hooks)
    const globalBefore = await readFile(resolve(f.home, 'hooks.json'), 'utf8'), otherBefore = await readFile(resolve(f.other, '.codex/hooks.json'), 'utf8')
    // A malformed unrelated registry entry must not affect this session's two directories.
    await writeFile(resolve(f.user, 'projects/unrelated.json'), '{invalid unrelated mapping')
    await writeFile(resolve(codexDirectory(f.config), 'installations/unrelated.json'), '{invalid unrelated installation')
    const result = await f.hook()
    assert.equal(result.stderr, '')
    assert.match(result.output.hookSpecificOutput.additionalContext, /已清理旧仓库接入/)
    assert.doesNotMatch(result.output.hookSpecificOutput.additionalContext, /备份/)
    assert.deepEqual((await readJson(hooksPath) as typeof hooks).hooks, { SessionStart: [team] })
    for (const workspace of [f.a, f.b]) await assert.rejects(readFile(resolve(workspace, '.jth/flow.json')), { code: 'ENOENT' })
    assert.equal(await readFile(resolve(f.other, '.codex/hooks.json'), 'utf8'), otherBefore)
    assert.equal(await readFile(resolve(f.home, 'hooks.json'), 'utf8'), globalBefore)
    assert.equal(await readFile(resolve(f.a, 'business.txt'), 'utf8'), 'keep business bytes')
    assert.equal(await readFile(resolve(f.a, '.jth/flow.sqlite'), 'utf8'), 'keep history bytes')
    const binding = await workspaceBinding(f.a, f.environment, { dryRun: true })
    assert.deepEqual(binding.project_ids, ['current-a']); assert(binding.read_project_ids.includes('old-a'))
    assert.deepEqual(await readJson(workflowSettingsPaths(f.a, f.environment).project), { mode: 'adaptive' })
    assert.deepEqual(await readJson(resolve(f.b, '.jth/workflow.json')), { mode: 'bogus' })
    assert.equal(await readJson(workflowSettingsPaths(f.b, f.environment).project), undefined)
    assert.equal(await readFile(resolve(f.a, '.codex/config.toml'), 'utf8'), 'model = "keep-model"\n')
    await assert.rejects(readdir(resolve(codexDirectory(f.config), 'migrations')), { code: 'ENOENT' })
    const mapBefore = await readFile(resolve(f.user, 'projects', `${hash(f.a)}.json`), 'utf8')
    assert.deepEqual((await f.hook()).output, {})
    await assert.rejects(readdir(resolve(codexDirectory(f.config), 'migrations')), { code: 'ENOENT' })
    assert.equal(await readFile(resolve(f.user, 'projects', `${hash(f.a)}.json`), 'utf8'), mapBefore)
    // Checking out an old branch restores tracked entrances; the next start must clean them again.
    await f.legacy(f.a, 'old-a')
    assert.match((await f.hook()).output.hookSpecificOutput.additionalContext, /已清理旧仓库接入/)
    assert.deepEqual((await workspaceBinding(f.a, f.environment, { dryRun: true })).project_ids, ['current-a'])
  } finally { await f.dispose() }
})

test('one unsafe directory does not block another bound directory; unbound and malformed inputs never mutate projects', { timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    await f.legacy(f.a, 'old-a'); await f.legacy(f.b, 'old-b')
    const external = resolve(f.directory, 'external-agents.md'); await writeFile(external, '<!-- JTH_MEMORY_START -->keep external<!-- JTH_MEMORY_END -->')
    await symlink(external, resolve(f.a, 'AGENTS.md'))
    const aBefore = await readFile(resolve(f.a, '.codex/hooks.json'), 'utf8')
    const result = await f.hook()
    assert.match(result.stderr, /符号链接/)
    assert.match(result.output.hookSpecificOutput.additionalContext, /未完成/)
    assert.equal(await readFile(resolve(f.a, '.codex/hooks.json'), 'utf8'), aBefore)
    assert.equal(await readFile(external, 'utf8'), '<!-- JTH_MEMORY_START -->keep external<!-- JTH_MEMORY_END -->')
    await assert.rejects(readFile(resolve(f.b, '.jth/flow.json')), { code: 'ENOENT' })
    await f.bind([])
    assert.deepEqual((await f.hook()).output, {})
    assert.equal(await readFile(resolve(f.a, '.codex/hooks.json'), 'utf8'), aBefore)
    await writeFile(f.input, '{invalid JSON')
    const invalid = await f.hook(); assert.deepEqual(invalid.output, {}); assert.match(invalid.stderr, /Hook 输入不是有效 JSON/)
  } finally { await f.dispose() }
})

test('concurrent starts clean without backups and recover a dead cleanup owner without waiting', { timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    await f.bind([f.a]); await f.legacy(f.a, 'old-a')
    const lock = resolve(codexDirectory(f.config), 'migration-locks', hash(f.a))
    const owner = `owner-${process.pid}-face.json`
    await mkdir(lock, { recursive: true }); await writeJson(resolve(lock, owner), { pid: process.pid })
    const busy = await f.hook(); assert.match(busy.output.hookSpecificOutput.additionalContext, /另一会话/)
    await readFile(resolve(f.a, '.jth/flow.json'))
    await rm(resolve(lock, owner))
    await writeJson(resolve(lock, 'owner-1000000000-dead.json'), { pid: 1_000_000_000 })
    const results = await Promise.all([f.hook(), f.hook()])
    assert(results.some(result => result.output.hookSpecificOutput?.additionalContext.includes('已清理旧仓库接入')))
    assert(results.every(result => result.stderr === ''))
    await assert.rejects(readFile(resolve(f.a, '.jth/flow.json')), { code: 'ENOENT' })
    await assert.rejects(readdir(resolve(codexDirectory(f.config), 'migrations')), { code: 'ENOENT' })
    assert.deepEqual((await f.hook()).output, {})
    await f.legacy(f.a, 'old-a'); await mkdir(lock)
    assert.match((await f.hook()).output.hookSpecificOutput.additionalContext, /已清理旧仓库接入/)
    await assert.rejects(readdir(lock), { code: 'ENOENT' })
  } finally { await f.dispose() }
})

test('custom team workflow is preserved without importing it as a local JTH policy', { timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    await f.bind([f.a]); await f.legacy(f.a, 'old-a')
    const teamPolicy = { mode: 'strict', custom: 'team-owned' }
    await writeJson(resolve(f.a, '.jth/workflow.json'), teamPolicy)
    assert.match((await f.hook()).output.hookSpecificOutput.additionalContext, /已清理旧仓库接入/)
    assert.deepEqual(await readJson(resolve(f.a, '.jth/workflow.json')), teamPolicy)
    assert.equal(await readJson(workflowSettingsPaths(f.a, f.environment).project), undefined)
  } finally { await f.dispose() }
})
