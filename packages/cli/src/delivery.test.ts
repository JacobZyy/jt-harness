import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { installCli, isManagedHook } from './delivery.ts'
import { configureProjectMemories } from './codex-client.ts'
import { parse } from '@decimalturn/toml-patch'
import { quote } from '@jt-harness/codex-hooks'
import { readPrimaryInstallation } from '../../../scripts/setup-worktree.ts'

test('trust selection excludes foreign markers, events, commands and ancestor projects', () => {
  const root = '/tool', workspace = '/project'
  const hook = { key: 'fixture', source: 'project', sourcePath: '/project/.codex/hooks.json', eventName: 'userPromptSubmit', currentHash: 'hash',
    statusMessage: 'jth flow entry', command: [process.execPath, '/tool/bin/jth.mjs', 'flow', 'prompt'].map(quote).join(' '), enabled: true, trustStatus: 'untrusted' }
  assert(isManagedHook(hook, root, workspace, false))
  for (const changed of [{ statusMessage: 'jth unknown' }, { eventName: 'preToolUse' }, { sourcePath: '/parent/.codex/hooks.json' },
    { command: `echo ${hook.command}` }, { statusMessage: 'jth monitor' }]) assert.equal(isManagedHook({ ...hook, ...changed }, root, workspace, false), false)
})

test('versioned CLI install/upgrade preserves credentials and refuses an unrelated binary', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-delivery-')))
  const prefix = resolve(root, 'prefix'), envFile = resolve(root, 'original.env')
  try {
    await writeFile(envFile, 'EMBEDDING_API_KEY=keep-private\nJTH_DATA_DIR=state\n')
    for (const build of ['first-build', 'second-build']) {
      const source = resolve(root, build)
      await mkdir(resolve(source, 'bin'), { recursive: true })
      await writeFile(resolve(source, 'bin/jth.mjs'), '#!/usr/bin/env node\nconsole.log("fixture CLI")\n')
      await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'jt-harness', version: '0.1.0', jthDistribution: { build } }))
      const installed = await installCli(source, prefix, envFile)
      assert.equal(await realpath(installed.binary), resolve(installed.root, 'bin/jth.mjs'))
      assert.equal(await realpath(resolve(installed.root, '.env')), envFile)
      assert((await readFile(installed.envFile, 'utf8')).includes('keep-private'))
    }
    assert.equal(await readFile(envFile, 'utf8'), 'EMBEDDING_API_KEY=keep-private\nJTH_DATA_DIR=state\n')
    const before = await readFile(resolve(prefix, 'share/jth/.env'), 'utf8')
    const replacement = resolve(root, 'replacement.env')
    await writeFile(replacement, 'EMBEDDING_API_KEY=do-not-replace\n')
    await installCli(resolve(root, 'second-build'), prefix, replacement)
    assert.equal(await readFile(resolve(prefix, 'share/jth/.env'), 'utf8'), before)
    await mkdir(resolve(root, 'unrelated/bin'), { recursive: true })
    await writeFile(resolve(root, 'unrelated/bin/jth'), 'another tool')
    await assert.rejects(installCli(resolve(root, 'first-build'), resolve(root, 'unrelated'), envFile), /保留已有/)
    assert.equal(await readFile(resolve(root, 'unrelated/bin/jth'), 'utf8'), 'another tool')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('project install and upgrade are idempotent; uninstall preserves data and other hooks', async () => {
  const root = resolve(import.meta.dirname, '../../..'), workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-project-')))
  const execute = promisify(execFile), envFile = resolve(workspace, '.env')
  const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), ...args, '--workspace', workspace], { cwd: workspace })).stdout)
  try {
    await mkdir(resolve(workspace, '.codex'), { recursive: true })
    await writeFile(resolve(workspace, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-other-tool' }] }] } }))
    await writeFile(envFile, `JTH_DATA_DIR=${workspace}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/test\n`)
    await cli('install', '--project', 'fixture', '--env-file', envFile)
    await mkdir(resolve(workspace, 'bin'))
    await symlink(resolve(root, 'bin/jth.mjs'), resolve(workspace, 'bin/jth.mjs'))
    assert.deepEqual(await readPrimaryInstallation(workspace), { envFile, projectIds: ['fixture'], businessIds: [] })
    const first = await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')
    await cli('upgrade')
    assert.equal(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8'), first)
    await writeFile(resolve(workspace, '.jth/keep-data'), 'keep')
    await cli('uninstall')
    assert.equal(await readFile(resolve(workspace, '.jth/keep-data'), 'utf8'), 'keep')
    assert((await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')).includes('keep-other-tool'))
    await assert.rejects(readlink(resolve(workspace, '.agents/skills/jth-flow')), { code: 'ENOENT' })
    assert((await readFile(envFile, 'utf8')).includes('JTH_DATABASE_URL'))
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('project memory settings preserve TOML comments and unrelated values; inherit removes only the two overrides', async () => {
  const workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-memory-config-')))
  const path = resolve(workspace, '.codex/config.toml')
  try {
    await mkdir(resolve(workspace, '.codex'))
    for (const original of [
      '# Keep project guidance\nmodel = "gpt-5.6-sol"\n',
      '# Keep project guidance\n[memories]\nuse_memories = true # Keep explanation\ngenerate_memories = true\nmin_rate_limit_remaining_percent = 40\n',
      'memories.use_memories = true\nmemories.generate_memories = true\n',
      'memories = { use_memories = true, generate_memories = true }\n',
    ]) {
      await writeFile(path, original)
      await configureProjectMemories(workspace, 'off')
      const disabled = await readFile(path, 'utf8'), before = parse(original)
      assert.deepEqual(structuredClone(parse(disabled)), { ...before, memories: { ...before.memories, use_memories: false, generate_memories: false } })
      if (original.includes('# Keep project guidance')) assert(disabled.includes('# Keep project guidance'))
      if (original.includes('# Keep explanation')) assert(disabled.includes('# Keep explanation'))
      await configureProjectMemories(workspace, 'off')
      assert.equal(await readFile(path, 'utf8'), disabled)
      await configureProjectMemories(workspace, 'inherit')
      const inherited = parse(await readFile(path, 'utf8'))
      const expected = { ...before }, memories = { ...before.memories }
      delete memories.use_memories; delete memories.generate_memories
      if (Object.keys(memories).length) expected.memories = memories
      else delete expected.memories
      assert.deepEqual(structuredClone(inherited), structuredClone(expected))
    }
    const malformed = '[memories\n'
    await writeFile(path, malformed)
    await assert.rejects(configureProjectMemories(workspace, 'off'), /不是有效 TOML/)
    assert.equal(await readFile(path, 'utf8'), malformed)
    for (const invalid of ['memories = true\n', 'memories = []\n', 'memories = 2026-09-21\n']) {
      await writeFile(path, invalid)
      await assert.rejects(configureProjectMemories(workspace, 'off'), /必须是 TOML table/)
      assert.equal(await readFile(path, 'utf8'), invalid)
    }
    const shared = resolve(workspace, 'global.toml')
    await writeFile(shared, '# shared config\n')
    await rm(path)
    await symlink(shared, path)
    await assert.rejects(configureProjectMemories(workspace, 'off'), /不是普通文件/)
    assert.equal(await readFile(shared, 'utf8'), '# shared config\n')
    await rm(resolve(workspace, '.codex'), { recursive: true })
    await mkdir(resolve(workspace, 'shared'))
    await symlink(resolve(workspace, 'shared'), resolve(workspace, '.codex'))
    await assert.rejects(configureProjectMemories(workspace, 'off'), /符号链接/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('init disables project native memory; install and upgrade preserve it', async () => {
  const root = resolve(import.meta.dirname, '../../..'), workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-init-')))
  const execute = promisify(execFile), envFile = resolve(workspace, '.env'), path = resolve(workspace, '.codex/config.toml')
  const cli = (...args: string[]) => execute(process.execPath, [resolve(root, 'bin/jth.mjs'), ...args, '--workspace', workspace], { cwd: workspace })
  try {
    await writeFile(envFile, `JTH_DATA_DIR=${workspace}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/test\n`)
    await assert.rejects(cli('init', '--codex-memory', 'invalid'), /仅支持 off 或 inherit/)
    await assert.rejects(readFile(path), { code: 'ENOENT' })
    const result = JSON.parse((await cli('init', '--project', 'fixture', '--env-file', envFile)).stdout)
    assert.deepEqual(result.memo.events, ['Stop'])
    assert.equal(result.codex_memory.policy, 'off')
    assert.equal(result.codex_memory.path, path)
    assert.deepEqual({ ...parse(await readFile(path, 'utf8')).memories }, { use_memories: false, generate_memories: false })
    // An explicit project preference remains owned by the user through upgrades and uninstall.
    const changed = '# User preference\n[memories]\nuse_memories = true\ngenerate_memories = false\n'
    await writeFile(path, changed)
    await cli('install')
    await cli('upgrade')
    assert.equal(await readFile(path, 'utf8'), changed)
    await cli('init', '--codex-memory', 'inherit')
    assert.equal(parse(await readFile(path, 'utf8')).memories, undefined)
    await cli('install', '--codex-memory', 'off')
    const configured = await readFile(path, 'utf8')
    await cli('uninstall')
    assert.equal(await readFile(path, 'utf8'), configured)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('Codex resolves project memory overrides without changing user or sibling configuration', { skip: !process.env.JTH_NATIVE_CONFIG_TEST }, async () => {
  const root = resolve(import.meta.dirname, '../../..'), fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-native-memory-')))
  const workspace = resolve(fixture, 'project'), sibling = resolve(fixture, 'sibling'), home = resolve(fixture, 'codex-home')
  const execute = promisify(execFile)
  try {
    for (const path of [workspace, sibling, home]) await mkdir(path)
    const global = `[features]\nmemories = true\n[memories]\nuse_memories = true\ngenerate_memories = true\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`
    await writeFile(resolve(home, 'config.toml'), global)
    const inspect = async (cwd: string) => JSON.parse((await execute(process.execPath, ['--input-type=module', '-e',
      `import { withCodex } from ${JSON.stringify(resolve(root, 'packages/cli/src/codex-client.ts'))};
       await withCodex(async call => { const {config} = await call('config/read', {cwd: process.cwd()});
         console.log(JSON.stringify({use:config.memories.use_memories, generate:config.memories.generate_memories})); });`,
    ], { cwd, env: { ...process.env, CODEX_HOME: home } })).stdout)
    await configureProjectMemories(workspace, 'off')
    assert.deepEqual(await inspect(workspace), { use: false, generate: false })
    assert.deepEqual(await inspect(sibling), { use: true, generate: true })
    await configureProjectMemories(workspace, 'inherit')
    assert.deepEqual(await inspect(workspace), { use: true, generate: true })
    assert.equal(await readFile(resolve(home, 'config.toml'), 'utf8'), global)
  } finally { await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
})
