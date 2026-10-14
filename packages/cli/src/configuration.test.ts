import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, mkdir, readFile, writeFile, realpath, rename, rm, stat, symlink, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig, matchesConfigFile, userConfigPaths } from '@jacob-z/jt-harness/memo/config'
import { captureSettingsSchema, configureHooks, hash, installationPath, memoLocatorPath, readJson, writeJson } from '@jacob-z/jt-harness/codex-hooks'
import { completeConfiguration, configurationScope, ensureUserConfig, importLegacyBindings, legacyInstallations, loadWorkspaceConfig, promptConfigValue, removeWorkspaceBinding, saveWorkspaceBinding, workspaceBinding, workspaceBindings } from './configuration.ts'

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

test('single-workspace binding lookup preserves local identity and validates only the selected map', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-scoped-binding-')))
  const environment = { JTH_CONFIG_DIR: resolve(fixture, 'user') }, workspace = resolve(fixture, 'project'), alias = resolve(fixture, 'alias')
  try {
    await mkdir(workspace); await symlink(workspace, alias)
    const legacy = [{ workspace, env_file: resolve(fixture, 'old.env'), enabled_at: '2025-01-01T00:00:00Z',
      installation_path: resolve(fixture, 'installation.json'), project_ids: ['old-history'], business_ids: ['old-business'] }]
    const initial = await workspaceBinding(workspace, environment, { projectIds: ['local-write'], readProjectIds: ['read-alias'], businessIds: ['local-business'], legacy })
    const projects = resolve(environment.JTH_CONFIG_DIR, 'projects'), unrelated = resolve(projects, 'unrelated.json')
    await writeFile(unrelated, '{malformed unrelated map')
    const binding = await workspaceBinding(alias, environment)
    assert.deepEqual(binding, initial)
    assert.deepEqual(binding.project_ids, ['local-write'])
    assert.deepEqual(binding.read_project_ids, ['local-write', 'read-alias', 'old-history'])
    assert.deepEqual(binding.business_ids, ['local-business', 'old-business'])
    assert.deepEqual(binding.legacy, legacy)
    assert.equal(await readFile(unrelated, 'utf8'), '{malformed unrelated map')
    await assert.rejects(workspaceBindings(environment), SyntaxError)
    await saveWorkspaceBinding(workspace, resolve(fixture, 'pointer.env'), environment)
    const replacement = await workspaceBinding(workspace, environment, { dryRun: true })
    assert.notDeepEqual(replacement.project_ids, ['local-write'])
    assert.deepEqual(replacement.legacy, [])
    const selected = resolve(projects, `${hash(workspace)}.json`)
    await writeJson(selected, { version: 2, path: workspace })
    await assert.rejects(workspaceBinding(workspace, environment), { name: 'ZodError' })
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('scoped legacy import ignores unrelated manifests and maps and preserves repeated write IDs', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-scoped-import-')))
  const environment = { JTH_CONFIG_DIR: resolve(fixture, 'user') }, config = { dataDir: resolve(fixture, 'data') }
  const workspace = resolve(fixture, 'project'), alias = resolve(fixture, 'alias'), other = resolve(fixture, 'other')
  try {
    await mkdir(workspace); await mkdir(other); await symlink(workspace, alias)
    await workspaceBinding(workspace, environment, { projectIds: ['local-write'], readProjectIds: ['read-alias'], businessIds: ['local-business'] })
    const settings = captureSettingsSchema.parse({ workspace, codex_home: resolve(fixture, 'codex'), env_file: resolve(fixture, 'old.env'),
      enabled_at: '2025-01-01T00:00:00Z', scope: { project_ids: ['old-history'], business_ids: ['old-business'] } })
    const selectedManifest = installationPath(config, workspace), unrelatedManifest = installationPath(config, other)
    await writeJson(selectedManifest, { settings, disabled: true })
    await writeFile(unrelatedManifest, '{malformed unrelated installation')
    const unrelatedMap = resolve(environment.JTH_CONFIG_DIR, 'projects', `${hash(other)}.json`)
    await writeFile(unrelatedMap, '{malformed unrelated map')
    const installations = await legacyInstallations(config, [workspace, alias])
    assert.deepEqual(installations, [{ path: selectedManifest, settings, disabled: true }])
    assert.deepEqual(await legacyInstallations(config, []), [])
    assert.deepEqual(await legacyInstallations(config, [resolve(fixture, 'missing')]), [])
    const selectedMap = resolve(environment.JTH_CONFIG_DIR, 'projects', `${hash(workspace)}.json`), before = await readFile(selectedMap, 'utf8')
    const preview = await importLegacyBindings(config, environment, true, [alias])
    assert.equal(await readFile(selectedMap, 'utf8'), before)
    const imported = await importLegacyBindings(config, environment, false, [alias])
    assert.equal(imported.length, 1)
    await importLegacyBindings(config, environment, false, [workspace])
    const binding = await workspaceBinding(workspace, environment, { dryRun: true })
    assert.deepEqual(binding.project_ids, ['local-write'])
    assert.deepEqual(binding.read_project_ids, ['local-write', 'read-alias', 'old-history'])
    assert.deepEqual(binding.business_ids, ['local-business', 'old-business'])
    assert.deepEqual(binding.legacy, [{ workspace, env_file: settings.env_file, enabled_at: settings.enabled_at,
      installation_path: selectedManifest, project_ids: settings.scope.project_ids, business_ids: settings.scope.business_ids }])
    assert.deepEqual(preview[0].binding, binding)
    assert.equal(await readFile(unrelatedManifest, 'utf8'), '{malformed unrelated installation')
    assert.equal(await readFile(unrelatedMap, 'utf8'), '{malformed unrelated map')
    await assert.rejects(legacyInstallations(config), SyntaxError)
    await writeJson(selectedManifest, { settings: { ...settings, workspace: other } })
    const mismatched = await readFile(selectedManifest, 'utf8'), preserved = await readFile(selectedMap, 'utf8')
    await assert.rejects(legacyInstallations(config, [workspace]), /workspace 与选定目录不一致/)
    await assert.rejects(importLegacyBindings(config, environment, false, [workspace]), /workspace 与选定目录不一致/)
    assert.equal(await readFile(selectedManifest, 'utf8'), mismatched)
    assert.equal(await readFile(selectedMap, 'utf8'), preserved)
    assert.equal(await readFile(unrelatedMap, 'utf8'), '{malformed unrelated map')
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
