import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, stat, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseEnv, promisify } from 'node:util'
import { Pool } from 'pg'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { installCli, isManagedHook } from './delivery.ts'
import { configureProjectCodex, withCodex } from './codex-client.ts'
import { parse } from '@decimalturn/toml-patch'
import { hookCommand, memoHookCommand, type CaptureSettings } from '@jacob-z/jt-harness/codex-hooks'
import { readPrimaryInstallation } from '../../../scripts/setup-worktree.ts'
import { schemaVersion } from '@jacob-z/jt-harness/memo'

test('trust selection excludes foreign markers, events, commands and ancestor projects', () => {
  const workspace = '/project'
  const settings: CaptureSettings = { workspace, codex_home: '/codex', env_file: '/config/.env', enabled_at: '2026-01-01T00:00:00Z',
    scope: { project_ids: ['project'], business_ids: [] } }
  const hook = { key: 'fixture', source: 'project', sourcePath: '/project/.codex/hooks.json', eventName: 'userPromptSubmit', currentHash: 'hash',
    statusMessage: 'jth flow entry', command: hookCommand('flow', 'prompt'), enabled: true, trustStatus: 'untrusted' }
  assert(isManagedHook(hook, workspace, settings, false))
  for (const changed of [{ statusMessage: 'jth unknown' }, { eventName: 'preToolUse' }, { sourcePath: '/parent/.codex/hooks.json' },
    { command: `echo ${hook.command}` }, { command: `${hook.command}; echo injected` }, { statusMessage: 'jth monitor' }]) {
    assert.equal(isManagedHook({ ...hook, ...changed }, workspace, settings, false), false)
  }
  const cue = { ...hook, eventName: 'sessionStart', statusMessage: 'jth memo cues', command: memoHookCommand(settings, 'cue') }
  assert(isManagedHook(cue, workspace, settings, false))
  assert.equal(isManagedHook({ ...cue, command: `${cue.command}; echo injected` }, workspace, settings, false), false)
})

test('published TypeScript launcher runs directly through Bun', async () => {
  const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
  const { stdout } = await execute('bun', ['--', resolve(root, 'bin/jth.ts'), 'init', '--help'])
  assert.match(stdout, /^jth init /)
})

test('versioned CLI install preserves credentials and refuses an unrelated binary', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-delivery-')))
  const prefix = resolve(root, 'prefix'), envFile = resolve(root, 'original.env')
  const environment = { JTH_CONFIG_DIR: resolve(root, 'user-config') }
  try {
    await writeFile(envFile, 'EMBEDDING_API_KEY=keep-private\nJTH_DATA_DIR=state\n')
    for (const build of ['first-build', 'second-build']) {
      const source = resolve(root, build)
      await mkdir(resolve(source, 'bin'), { recursive: true })
      await writeFile(resolve(source, 'bin/jth.ts'), '#!/usr/bin/env bun\nconsole.log("fixture CLI")\n')
      if (build === 'first-build') {
        await mkdir(resolve(source, 'fixture-runtime'))
        await writeFile(resolve(source, 'fixture-runtime/package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0' }))
      }
      await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'jt-harness', version: '0.1.0', jthDistribution: { build },
        dependencies: build === 'first-build' ? { 'fixture-runtime': 'file:./fixture-runtime' } : {} }))
      const installed = await installCli(source, prefix, envFile, environment)
      assert.equal(await realpath(installed.binary), resolve(installed.root, 'bin/jth.ts'))
      if (build === 'first-build') assert((await readFile(resolve(installed.root, 'node_modules/fixture-runtime/package.json'), 'utf8')).includes('fixture-runtime'))
      assert.equal(await realpath(resolve(installed.root, '.env')), resolve(environment.JTH_CONFIG_DIR, '.env'))
      assert.notEqual(installed.envFile, envFile)
      assert((await readFile(installed.envFile, 'utf8')).includes('keep-private'))
    }
    assert.equal(await readFile(envFile, 'utf8'), 'EMBEDDING_API_KEY=keep-private\nJTH_DATA_DIR=state\n')
    const before = await readFile(resolve(prefix, 'share/jth/.env'), 'utf8')
    const replacement = resolve(root, 'replacement.env')
    await writeFile(replacement, 'EMBEDDING_API_KEY=do-not-replace\n')
    await installCli(resolve(root, 'second-build'), prefix, replacement, environment)
    assert.equal(await readFile(resolve(prefix, 'share/jth/.env'), 'utf8'), before)
    await mkdir(resolve(root, 'unrelated/bin'), { recursive: true })
    await writeFile(resolve(root, 'unrelated/bin/jth'), 'another tool')
    await assert.rejects(installCli(resolve(root, 'first-build'), resolve(root, 'unrelated'), envFile, environment), /保留已有/)
    assert.equal(await readFile(resolve(root, 'unrelated/bin/jth'), 'utf8'), 'another tool')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('upgrade command is removed in favor of init', async () => {
  const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
  await assert.rejects(execute(process.execPath, [resolve(root, 'bin/jth.ts'), 'upgrade']), /upgrade 已移除/)
  const help = (await execute(process.execPath, [resolve(root, 'bin/jth.ts'), 'init', '--help'])).stdout
  assert(!help.includes('jth upgrade'))
})

test('project preferences preserve TOML comments and unrelated values; inherit removes only memory overrides', async () => {
  const workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-memory-config-')))
  const path = resolve(workspace, '.codex/config.toml')
  try {
    await mkdir(resolve(workspace, '.codex'))
    for (const original of [
      '# Keep project guidance\nmodel = "gpt-5.6-sol"\n',
      '# Keep project guidance\n[memories]\nuse_memories = true # Keep explanation\ngenerate_memories = true\nmin_rate_limit_remaining_percent = 40\n',
      'memories.use_memories = true\nmemories.generate_memories = true\n',
      'memories = { use_memories = true, generate_memories = true }\n',
      'tools.update_plan.enabled = false\ntools.view_image = true\n',
      'tools = { update_plan = { enabled = false }, view_image = true }\n',
      '[tools.update_plan]\nenabled = false # Keep explanation\n',
    ]) {
      await writeFile(path, original)
      await configureProjectCodex(workspace, 'off', true)
      const disabled = await readFile(path, 'utf8'), before = parse(original)
      const tools = { ...before.tools, update_plan: { ...before.tools?.update_plan, enabled: true } }
      assert.deepEqual(structuredClone(parse(disabled)), { ...before, tools, memories: { ...before.memories, use_memories: false, generate_memories: false } })
      if (original.includes('# Keep project guidance')) assert(disabled.includes('# Keep project guidance'))
      if (original.includes('# Keep explanation')) assert(disabled.includes('# Keep explanation'))
      await configureProjectCodex(workspace, 'off', true)
      assert.equal(await readFile(path, 'utf8'), disabled)
      await configureProjectCodex(workspace, 'inherit')
      const inherited = parse(await readFile(path, 'utf8'))
      const expected = { ...before, tools }, memories = { ...before.memories }
      delete memories.use_memories; delete memories.generate_memories
      if (Object.keys(memories).length) expected.memories = memories
      else delete expected.memories
      assert.deepEqual(structuredClone(inherited), structuredClone(expected))
    }
    const malformed = '[memories\n'
    await writeFile(path, malformed)
    await assert.rejects(configureProjectCodex(workspace, 'off', true), /不是有效 TOML/)
    assert.equal(await readFile(path, 'utf8'), malformed)
    for (const invalid of ['memories = true\n', 'memories = []\n', 'memories = 2026-09-21\n', 'tools = true\n', 'tools = []\n', 'tools.update_plan = false\n', 'tools.update_plan = 2026-09-21\n']) {
      await writeFile(path, invalid)
      await assert.rejects(configureProjectCodex(workspace, 'off', true), /必须是 TOML table/)
      assert.equal(await readFile(path, 'utf8'), invalid)
    }
    const shared = resolve(workspace, 'global.toml')
    await writeFile(shared, '# shared config\n')
    await rm(path)
    await symlink(shared, path)
    await assert.rejects(configureProjectCodex(workspace, 'off'), /不是普通文件/)
    assert.equal(await readFile(shared, 'utf8'), '# shared config\n')
    await rm(resolve(workspace, '.codex'), { recursive: true })
    await mkdir(resolve(workspace, 'shared'))
    await symlink(resolve(workspace, 'shared'), resolve(workspace, '.codex'))
    await assert.rejects(configureProjectCodex(workspace, 'off'), /符号链接/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('Codex resolves project memory and planning overrides without changing user or sibling configuration', { skip: !process.env.JTH_NATIVE_CONFIG_TEST }, async () => {
  const root = resolve(import.meta.dirname, '../../..'), fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-native-memory-')))
  const workspace = resolve(fixture, 'project'), sibling = resolve(fixture, 'sibling'), home = resolve(fixture, 'codex-home')
  const execute = promisify(execFile)
  const previousHome = process.env.CODEX_HOME
  const requests: string[][] = []
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body.tools.flatMap((tool: { name: string, tools?: { name: string }[] }) => tool.tools ? tool.tools.map(item => item.name) : [tool.name]))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const message = { id: 'msg_plan_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }
    for (const event of [
      { type: 'response.created', response: { id: 'resp_plan_fixture', status: 'in_progress', model: 'jth-plan-fixture' } },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_plan_fixture', status: 'completed', model: 'jth-plan-fixture', output: [message] } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string')
  try {
    for (const path of [workspace, sibling, home]) await mkdir(path)
    const global = `model="jth-plan-fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local verification"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\nmemories = false\nenable_request_compression = false\n[memories]\nuse_memories = true\ngenerate_memories = true\n[tools.update_plan]\nenabled = false\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`
    await writeFile(resolve(home, 'config.toml'), global)
    const inspect = async (cwd: string) => JSON.parse((await execute(process.execPath, ['--input-type=module', '-e',
      `import { withCodex } from ${JSON.stringify(resolve(root, 'packages/cli/src/codex-client.ts'))};
       await withCodex(async call => { const {config, origins, layers} = await call('config/read', {cwd: process.cwd(), includeLayers:true});
         const origin = origins['tools.update_plan.enabled'];
         const layer = layers.find(item => JSON.stringify(item.name) === JSON.stringify(origin.name));
         console.log(JSON.stringify({use:config.memories.use_memories, generate:config.memories.generate_memories, plan:layer.config.tools.update_plan.enabled})); });`,
    ], { cwd, env: { ...process.env, CODEX_HOME: home } })).stdout)
    await configureProjectCodex(workspace, 'off', true)
    assert.deepEqual(await inspect(workspace), { use: false, generate: false, plan: true })
    assert.deepEqual(await inspect(sibling), { use: true, generate: true, plan: false })
    // config/read omits this tool from its typed config object; verify actual model requests too.
    process.env.CODEX_HOME = home
    for (const [cwd, enabled] of [[workspace, true], [sibling, false]] as const) {
      const before = requests.length
      await withCodex(async call => {
        const { thread } = await call('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never' })
        await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply done.' }] })
        for (let attempt = 0; attempt < 80; attempt++) {
          const result = await call('thread/read', { threadId: thread.id, includeTurns: true })
          if (result.thread.turns.some((turn: { status: string }) => turn.status === 'completed')) return
          await delay(100)
        }
        assert.fail('The local Responses fixture turn did not complete')
      })
      assert(requests.length > before, 'The local Responses fixture must receive the real Codex request')
      assert(requests.slice(before).every(tools => tools.includes('update_plan') === enabled), 'Native tool registration must follow the project setting')
    }
    await configureProjectCodex(workspace, 'inherit')
    assert.deepEqual(await inspect(workspace), { use: true, generate: true, plan: true })
    assert.equal(await readFile(resolve(home, 'config.toml'), 'utf8'), global)
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome
    await new Promise<void>(done => server.close(() => done()))
    await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
