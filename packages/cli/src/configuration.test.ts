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
      { cwd: workspace, env: { ...process.env, ...environment, HOME: fixture, CODEX_HOME: resolve(fixture, 'codex'),
        JTH_ENV_FILE: undefined, JTH_DATABASE_URL: undefined, JTH_DATA_DIR: undefined,
        EMBEDDING_BASE_URL: undefined, EMBEDDING_MODEL: undefined, EMBEDDING_API_KEY: undefined, EMBEDDING_DIMENSIONS: undefined } }), /配置不完整/)
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
