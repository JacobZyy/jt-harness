import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, mkdir, readFile, writeFile, realpath, rename, rm, stat, symlink, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig, matchesConfigFile, userConfigPaths } from '@jacob-z/jt-harness/memo/config'
import { captureSettingsSchema, configureHooks, installationPath, memoLocatorPath, readJson } from '@jacob-z/jt-harness/codex-hooks'
import { completeConfiguration, configurationScope, ensureUserConfig, loadWorkspaceConfig, promptConfigValue, removeWorkspaceBinding, saveWorkspaceBinding } from './configuration.ts'

test('standalone Memo hook resolves custom configuration from nested cwd without embedding paths', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-memo-location-')))
  const root = resolve(import.meta.dirname, '../../..'), workspace = resolve(fixture, 'project'), envFile = resolve(fixture, 'custom.env')
  const environment: NodeJS.ProcessEnv = { ...process.env, JTH_CONFIG_DIR: resolve(fixture, 'unused-default') }
  try {
    await mkdir(resolve(workspace, 'nested'), { recursive: true })
    await mkdir(resolve(workspace, 'bin'))
    await symlink(resolve(root, 'bin/jth.ts'), resolve(workspace, 'bin/jth'))
    environment.PATH = `${workspace}/bin:${process.env.PATH ?? ''}`
    await writeFile(envFile, 'JTH_DATA_DIR=./state\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/test\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nEMBEDDING_API_KEY=test\n')
    const config = await loadConfig(root, envFile, environment)
    await configureHooks(root, config, workspace, { project_ids: ['fixture'], business_ids: [] }, resolve(fixture, 'codex'))
    await saveWorkspaceBinding(workspace, config.envFile, environment)
    await mkdir(resolve(workspace, '.jth'), { recursive: true })
    await writeFile(resolve(workspace, '.jth/flow.json'), JSON.stringify({ version: 3, scope: { project_ids: ['fixture'], business_ids: [] } }))
    const command = JSON.parse(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')).hooks.Stop[0].hooks[0].command
    assert.equal(command, "'jth' '--' 'memo' 'codex' 'declare'")
    assert.equal((await loadWorkspaceConfig(root, undefined, resolve(workspace, 'nested'), environment)).envFile, config.envFile)
    const captured = await new Promise<{ stdout: string, stderr: string }>((done, reject) => {
      const child = execFile('/bin/sh', ['-c', command], { cwd: resolve(workspace, 'nested'), env: environment, timeout: 10000 },
        (error, stdout, stderr) => error ? reject(error) : done({ stdout, stderr }))
      child.stdin!.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'standalone', cwd: workspace, last_assistant_message: 'No declaration.' }))
    })
    assert.deepEqual(captured, { stdout: '', stderr: '' })
    await configureHooks(root, config, workspace, undefined, resolve(fixture, 'codex'))
    await assert.rejects(readFile(memoLocatorPath(workspace)), { code: 'ENOENT' })
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('user configuration survives source removal and reuses old repository bindings without changing scope', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-config-migration-')))
  const root = resolve(import.meta.dirname, '../../..'), workspace = resolve(fixture, 'project'), source = resolve(fixture, 'old.env')
  const environment: NodeJS.ProcessEnv = { ...process.env, JTH_CONFIG_DIR: resolve(fixture, 'user') }, execute = promisify(execFile)
  const cli = async (...args: string[]) => JSON.parse((await execute(resolve(root, 'bin/jth.ts'), [...args, '--workspace', workspace], { cwd: workspace, env: environment })).stdout)
  try {
    await mkdir(workspace)
    await mkdir(resolve(workspace, 'bin'))
    await symlink(resolve(root, 'bin/jth.ts'), resolve(workspace, 'bin/jth'))
    environment.PATH = `${workspace}/bin:${process.env.PATH ?? ''}`
    const original = 'JTH_DATA_DIR=./state\nJTH_PG_DATA_DIR=./postgres\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/test\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nEMBEDDING_API_KEY=old-private-key\n'
    await writeFile(source, original)
    const installed = await cli('install', '--project', 'migration-project', '--env-file', source)
    const hook = JSON.parse(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')).hooks.Stop[0].hooks[0].command
    const migrated = await ensureUserConfig(fixture, source, environment)
    assert.equal((await stat(migrated.envFile)).mode & 0o777, 0o600)
    assert.equal((await stat(migrated.directory)).mode & 0o777, 0o700)
    assert.equal(await readFile(source, 'utf8'), original)
    await rename(source, `${source}.retained`)
    const config = await loadConfig(root, source, environment)
    assert.equal(config.envFile, migrated.envFile)
    assert.equal(config.dataDir, resolve(fixture, 'state'))
    assert.equal(config.postgres?.dataDir, resolve(fixture, 'postgres'))
    assert.equal(config.embedding.apiKey, 'old-private-key')
    assert(matchesConfigFile(config, source))
    assert(!matchesConfigFile(config, resolve(fixture, 'foreign.env')))
    assert.equal((await cli('install', '--env-file', source)).configuration.envFile, migrated.envFile)
    const captured = await new Promise<{ stdout: string, stderr: string }>((done, reject) => {
      const child = execFile('/bin/sh', ['-c', hook], { cwd: workspace, env: environment, timeout: 10000 },
        (error, stdout, stderr) => error ? reject(error) : done({ stdout, stderr }))
      child.stdin!.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'migration-check', cwd: workspace, last_assistant_message: 'No declaration.' }))
    })
    assert.deepEqual(captured, { stdout: '', stderr: '' })
    const upgraded = await cli('install')
    assert.equal(upgraded.memo.settings.env_file, migrated.envFile)
    assert.equal(upgraded.memo.settings.enabled_at, installed.memo.settings.enabled_at)
    assert.deepEqual(upgraded.memo.settings.scope, installed.memo.settings.scope)
    assert.equal(upgraded.configuration.scope, 'user')
    assert(!JSON.stringify(upgraded).includes('old-private-key'))
    await assert.rejects(cli('install', '--project', 'different-project'), /已有安装的范围不同/)
    await mkdir(resolve(workspace, 'src'))
    assert.equal((await loadWorkspaceConfig(root, undefined, resolve(workspace, 'src'), environment)).envFile, migrated.envFile)
    const override = resolve(fixture, 'override.env')
    await writeFile(override, original.replace('old-private-key', 'override-key'))
    assert.equal((await loadWorkspaceConfig(root, override, workspace, environment)).embedding.apiKey, 'override-key')
    assert.equal((await loadWorkspaceConfig(root, undefined, workspace, { ...environment, JTH_ENV_FILE: override })).embedding.apiKey, 'override-key')
    assert.equal((await configurationScope(await loadConfig(root, override, environment), environment)).scope, 'override')
    await writeFile(resolve(fixture, '.env'), 'EMBEDDING_API_KEY=must-not-load\n')
    assert.equal((await loadConfig(fixture, undefined, environment)).embedding.apiKey, 'old-private-key')
    assert.deepEqual(await ensureUserConfig(fixture, undefined, environment), { ...migrated, created: false, imported: false })
    await writeFile(resolve(workspace, '.jth/flow.json'), JSON.stringify({ version: 2, workspace: fixture, envFile: override }))
    assert.equal((await loadWorkspaceConfig(root, undefined, workspace, environment)).envFile, migrated.envFile)
    await removeWorkspaceBinding(workspace, environment)
    assert.equal((await loadWorkspaceConfig(root, undefined, workspace, environment)).envFile, migrated.envFile)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('shared project files use each device CLI configuration and Memo store', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-two-devices-')))
  const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
  const devices = ['alice', 'bob'].map(name => ({ name, directory: resolve(fixture, name), workspace: resolve(fixture, name, 'project'),
    configDirectory: resolve(fixture, name, 'device-config'), dataDirectory: resolve(fixture, name, 'memo-data'), codexHome: resolve(fixture, name, 'codex-home') }))
  const [alice, bob] = devices
  const environment = (device: typeof alice) => ({ ...process.env, JTH_CONFIG_DIR: device.configDirectory,
    JTH_DATA_DIR: device.dataDirectory, CODEX_HOME: device.codexHome, JTH_ENV_FILE: undefined })
  const cli = async (device: typeof alice, ...args: string[]) => execute(process.execPath,
    [resolve(root, 'bin/jth.ts'), ...args, '--workspace', device.workspace], { cwd: device.workspace, env: environment(device) })
  try {
    for (const device of devices) {
      await mkdir(device.workspace, { recursive: true })
      await mkdir(device.configDirectory, { recursive: true })
      await writeFile(resolve(device.configDirectory, '.env'), `JTH_DATA_DIR=${device.dataDirectory}\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/${device.name}\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nEMBEDDING_API_KEY=fixture\n`)
    }
    await writeFile(resolve(alice.workspace, '.gitignore'), '/.jth/\n/.codex/hooks.json\n/.agents/skills/jth-flow\n/.agents/skills/jth-memo\n')
    await cli(alice, 'flow', 'install', '--project', 'shared-project')
    for (const file of ['.gitignore', '.jth/flow.json', '.codex/hooks.json']) {
      await mkdir(resolve(bob.workspace, file, '..'), { recursive: true })
      await cp(resolve(alice.workspace, file), resolve(bob.workspace, file))
    }
    for (const name of ['jth-flow', 'jth-memo']) {
      const path = `.agents/skills/${name}`
      await mkdir(resolve(bob.workspace, '.agents/skills'), { recursive: true })
      await cp(resolve(alice.workspace, path), resolve(bob.workspace, path), { recursive: true })
      assert((await lstat(resolve(bob.workspace, path))).isDirectory())
    }
    const shared = JSON.parse(await readFile(resolve(bob.workspace, '.jth/flow.json'), 'utf8'))
    assert.deepEqual(shared, { version: 3, scope: { project_ids: ['shared-project'], business_ids: [] } })
    const hooks = await readFile(resolve(bob.workspace, '.codex/hooks.json'), 'utf8')
    assert(!hooks.includes(alice.directory))
    assert(!hooks.includes(alice.configDirectory))
    assert(!await readJson(memoLocatorPath(bob.workspace)))
    const ignore = await readFile(resolve(bob.workspace, '.gitignore'), 'utf8')
    assert(ignore.includes('!/.jth/flow.json'))
    assert(!ignore.includes('/.agents/skills/jth-'))
    const configA = await loadWorkspaceConfig(root, undefined, alice.workspace, environment(alice))
    const configB = await loadWorkspaceConfig(root, undefined, bob.workspace, environment(bob))
    assert.equal(configA.envFile, resolve(alice.configDirectory, '.env'))
    assert.equal(configB.envFile, resolve(bob.configDirectory, '.env'))
    assert.notEqual(configA.databaseUrl, configB.databaseUrl)
    assert.notEqual(configA.dataDir, configB.dataDir)
    assert.deepEqual(JSON.parse((await cli(bob, 'flow', 'status')).stdout).memo_scope, shared.scope)
    assert.equal(await readJson(installationPath(configB, bob.workspace)), undefined)
    const child = execFile(process.execPath, [resolve(root, 'bin/jth.ts'), 'memo', 'codex', 'declare', '--workspace', bob.workspace],
      { cwd: bob.workspace, env: environment(bob) })
    child.stdin!.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'bob-session', cwd: bob.workspace, last_assistant_message: 'No declaration.' }))
    await new Promise<void>((done, reject) => child.once('close', code => code === 0 ? done() : reject(new Error(`Hook exit ${code}`))))
    const installedA = await readJson(installationPath(configA, alice.workspace)) as { settings: unknown }
    const installedB = await readJson(installationPath(configB, bob.workspace)) as { settings: unknown }
    const settingsA = captureSettingsSchema.parse(installedA.settings), settingsB = captureSettingsSchema.parse(installedB.settings)
    assert.deepEqual(settingsA.scope, settingsB.scope)
    assert.equal(settingsA.env_file, configA.envFile)
    assert.equal(settingsB.env_file, configB.envFile)
    assert.equal(settingsA.workspace, alice.workspace)
    assert.equal(settingsB.workspace, bob.workspace)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('initialization requests missing values, preserves complete configuration and rejects incomplete noninteractive setup', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-config-setup-')))
  const root = resolve(import.meta.dirname, '../../..'), environment = { JTH_CONFIG_DIR: resolve(fixture, 'user') }
  try {
    await writeFile(resolve(fixture, '.env.example'), 'JTH_DATABASE_URL=postgresql://localhost/jth\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nEMBEDDING_DIMENSIONS=1024\nEMBEDDING_API_KEY=\n')
    const setup = await ensureUserConfig(fixture, undefined, environment)
    const config = await loadConfig(root, undefined, environment), before = await readFile(config.envFile, 'utf8')
    await assert.rejects(completeConfiguration(root, config, { environment, interactive: false }), /缺少 EMBEDDING_API_KEY/)
    assert.equal(await readFile(config.envFile, 'utf8'), before)
    let questions = 0
    const completed = await completeConfiguration(root, config, { environment, interactive: true, ask: async (label, options) => {
      questions++
      assert(label.includes('API Key'))
      assert.equal(options?.secret, true)
      assert.equal(options?.value, undefined)
      return 'secret-never-echoed'
    } })
    assert.equal(questions, 1)
    assert.equal(completed.embedding.apiKey, 'secret-never-echoed')
    assert.equal((await stat(setup.envFile)).mode & 0o777, 0o600)
    await completeConfiguration(root, completed, { environment, interactive: false, ask: async () => assert.fail('Complete configuration must not prompt again') })
    const workspace = resolve(fixture, 'project'); await mkdir(workspace)
    const empty = resolve(fixture, 'empty.env'); await writeFile(empty, '')
    await assert.rejects(promisify(execFile)(process.execPath, [resolve(root, 'bin/jth.ts'), 'init', '--project', 'missing', '--env-file', empty],
      { cwd: workspace, env: { ...process.env, ...environment } }), /配置不完整/)
    await assert.rejects(readFile(resolve(workspace, '.jth/flow.json')), { code: 'ENOENT' })
    assert.equal((await loadConfig(root, undefined, environment)).envFile, userConfigPaths(environment).envFile)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('secret prompts suppress input and defaults; cancellation never returns a credential', async () => {
  const input = new PassThrough(), output = new PassThrough()
  let displayed = ''; output.on('data', chunk => { displayed += chunk })
  const answer = promptConfigValue('API Key', { secret: true, value: 'private-default', input, output })
  input.write('typed-private-key\r')
  assert.equal(await answer, 'typed-private-key')
  assert(!displayed.includes('typed-private-key'))
  assert(!displayed.includes('private-default'))
  const canceled = promptConfigValue('API Key', { secret: true, input, output })
  input.write('\x03')
  await assert.rejects(canceled, /已取消初始化/)
  input.end(); output.end()
})
