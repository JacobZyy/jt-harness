import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig, matchesConfigFile, userConfigPaths } from '@jacob-z/jt-harness/memo/config'
import { completeConfiguration, configurationScope, ensureUserConfig, loadWorkspaceConfig, promptConfigValue } from './configuration.ts'

test('user configuration survives source removal and upgrades old repository bindings without changing scope', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-config-migration-')))
  const root = resolve(import.meta.dirname, '../../..'), workspace = resolve(fixture, 'project'), source = resolve(fixture, 'old.env')
  const environment = { ...process.env, JTH_CONFIG_DIR: resolve(fixture, 'user') }, execute = promisify(execFile)
  const cli = async (...args: string[]) => JSON.parse((await execute(resolve(root, 'bin/jth.mjs'), [...args, '--workspace', workspace], { cwd: workspace, env: environment })).stdout)
  try {
    await mkdir(workspace)
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
    const upgraded = await cli('upgrade')
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
    await writeFile(resolve(workspace, '.jth/flow.json'), JSON.stringify({ version: 2, workspace: fixture, envFile: migrated.envFile }))
    await assert.rejects(loadWorkspaceConfig(root, undefined, workspace, environment), /工作区不一致/)
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
    await assert.rejects(promisify(execFile)(process.execPath, [resolve(root, 'bin/jth.mjs'), 'init', '--project', 'missing', '--env-file', empty],
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
