import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, rm, symlink, stat } from 'node:fs/promises'
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
import { quote } from '@jacob-z/jt-harness/codex-hooks'
import { readPrimaryInstallation } from '../../../scripts/setup-worktree.ts'

test('trust selection excludes foreign markers, events, commands and ancestor projects', () => {
  const root = '/tool', workspace = '/project'
  const hook = { key: 'fixture', source: 'project', sourcePath: '/project/.codex/hooks.json', eventName: 'userPromptSubmit', currentHash: 'hash',
    statusMessage: 'jth flow entry', command: [process.execPath, '--', '/tool/bin/jth.mjs', 'flow', 'prompt'].map(quote).join(' '), enabled: true, trustStatus: 'untrusted' }
  assert(isManagedHook(hook, root, workspace, false))
  for (const changed of [{ statusMessage: 'jth unknown' }, { eventName: 'preToolUse' }, { sourcePath: '/parent/.codex/hooks.json' },
    { command: `echo ${hook.command}` }, { statusMessage: 'jth monitor' }]) assert.equal(isManagedHook({ ...hook, ...changed }, root, workspace, false), false)
})

test('versioned CLI install/upgrade preserves credentials and refuses an unrelated binary', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-delivery-')))
  const prefix = resolve(root, 'prefix'), envFile = resolve(root, 'original.env')
  const environment = { JTH_CONFIG_DIR: resolve(root, 'user-config') }
  try {
    await writeFile(envFile, 'EMBEDDING_API_KEY=keep-private\nJTH_DATA_DIR=state\n')
    for (const build of ['first-build', 'second-build']) {
      const source = resolve(root, build)
      await mkdir(resolve(source, 'bin'), { recursive: true })
      await writeFile(resolve(source, 'bin/jth.mjs'), '#!/usr/bin/env bun\nconsole.log("fixture CLI")\n')
      if (build === 'first-build') {
        await mkdir(resolve(source, 'fixture-runtime'))
        await writeFile(resolve(source, 'fixture-runtime/package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0' }))
      }
      await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'jt-harness', version: '0.1.0', jthDistribution: { build },
        dependencies: build === 'first-build' ? { 'fixture-runtime': 'file:./fixture-runtime' } : {} }))
      const installed = await installCli(source, prefix, envFile, environment)
      assert.equal(await realpath(installed.binary), resolve(installed.root, 'bin/jth.mjs'))
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

test('project install and upgrade are idempotent; uninstall preserves data and other hooks', async () => {
  const root = resolve(import.meta.dirname, '../../..'), workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-project-')))
  const execute = promisify(execFile), envFile = resolve(workspace, '.env')
  const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), ...args, '--workspace', workspace], { cwd: workspace })).stdout)
  try {
    await mkdir(resolve(workspace, '.codex'), { recursive: true })
    await writeFile(resolve(workspace, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-other-tool' }] }] } }))
    await writeFile(envFile, `JTH_DATA_DIR=${workspace}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/test\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nEMBEDDING_API_KEY=fixture\n`)
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
    await assert.rejects(readlink(resolve(workspace, '.agents/skills/jth-memo')), { code: 'ENOENT' })
    assert((await readFile(envFile, 'utf8')).includes('JTH_DATABASE_URL'))
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('upgrade recovers a removed package installation only with matching managed hooks', { skip: !process.env.JTH_NATIVE_CONFIG_TEST }, async () => {
  const root = resolve(import.meta.dirname, '../../..'), workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-removed-package-')))
  const execute = promisify(execFile), envFile = resolve(workspace, '.env'), home = resolve(workspace, 'codex-home')
  const skill = resolve(workspace, '.agents/skills/jth-flow'), hooksPath = resolve(workspace, '.codex/hooks.json'), oldRoot = resolve(workspace, 'removed-package')
  const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), ...args, '--workspace', workspace], { cwd: workspace, env: { ...process.env, CODEX_HOME: home } })).stdout)
  try {
    await mkdir(home)
    await writeFile(resolve(home, 'config.toml'), `[features]\nhooks=true\n[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n`)
    await writeFile(envFile, `JTH_DATA_DIR=${workspace}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/test\n`)
    await cli('install', '--project', 'fixture', '--env-file', envFile)
    const installedHooks = await readFile(hooksPath, 'utf8')
    await rm(skill)
    await symlink(resolve(oldRoot, 'packages/flow/skills/jth-flow'), skill)
    await assert.rejects(cli('upgrade'), /无法确认归属/)
    assert.equal(await readlink(skill), resolve(oldRoot, 'packages/flow/skills/jth-flow'))
    assert.equal(await readFile(hooksPath, 'utf8'), installedHooks)
    await writeFile(hooksPath, installedHooks.replaceAll(root, oldRoot))
    const diagnostic = await cli('doctor').catch(error => JSON.parse(error.stdout))
    assert.equal(diagnostic.checks.find((check: { name: string }) => check.name === 'hooks').detail.skill_available, false)
    await cli('upgrade')
    assert.equal(await readlink(skill), resolve(root, 'packages/flow/skills/jth-flow'))
    assert.equal(await readFile(hooksPath, 'utf8'), installedHooks)
    assert.deepEqual((await cli('flow', 'status')).memo_scope.project_ids, ['fixture'])
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('upgrade --summary prints human-readable text while JSON remains the default', async () => {
  const root = resolve(import.meta.dirname, '../../..'), workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-summary-')))
  const execute = promisify(execFile), envFile = resolve(workspace, '.env')
  const run = async (...args: string[]) => (await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), ...args, '--workspace', workspace], { cwd: workspace })).stdout
  try {
    await mkdir(resolve(workspace, '.codex'), { recursive: true })
    await writeFile(envFile, `JTH_DATA_DIR=${workspace}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/test\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nEMBEDDING_API_KEY=fixture\n`)
    await run('install', '--project', 'fixture', '--env-file', envFile)
    const summary = await run('upgrade', '--summary')
    assert(summary.includes('项目已同步'))
    assert(summary.includes('策略 '))
    assert.throws(() => JSON.parse(summary))
    JSON.parse(await run('upgrade'))
  } finally { await rm(workspace, { recursive: true, force: true }) }
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

test('init enables planning and disables project native memory; install and upgrade preserve user choices', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const root = resolve(import.meta.dirname, '../../..'), workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-init-')))
  const execute = promisify(execFile), envFile = resolve(workspace, '.env'), path = resolve(workspace, '.codex/config.toml')
  const cli = (...args: string[]) => execute(process.execPath, [resolve(root, 'bin/jth.mjs'), ...args, '--workspace', workspace], { cwd: workspace })
  try {
    await writeFile(envFile, `JTH_DATA_DIR=${workspace}/data\nJTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nEMBEDDING_API_KEY=fixture\n`)
    await assert.rejects(cli('init', '--codex-memory', 'invalid'), /仅支持 off 或 inherit/)
    await assert.rejects(readFile(path), { code: 'ENOENT' })
    const result = JSON.parse((await cli('init', '--project', 'fixture', '--env-file', envFile)).stdout)
    assert.deepEqual(result.memo.events, ['Stop', 'SessionStart', 'UserPromptSubmit'])
    assert.equal(result.codex_memory.policy, 'off')
    assert.equal(result.codex_memory.path, path)
    assert.equal(result.codex_plan.enabled, true)
    assert.equal(result.codex_plan.path, path)
    assert.equal(result.database.schema_version, 8)
    assert.equal(result.verification.checks.find((check: { name: string }) => check.name === 'database').status, 'ok')
    assert.deepEqual({ ...parse(await readFile(path, 'utf8')).memories }, { use_memories: false, generate_memories: false })
    assert.equal(parse(await readFile(path, 'utf8')).tools.update_plan.enabled, true)
    // An explicit project preference remains owned by the user through upgrades and uninstall.
    const changed = '# User preference\n[memories]\nuse_memories = true\ngenerate_memories = false\n[tools.update_plan]\nenabled = false\n'
    await writeFile(path, changed)
    await cli('install')
    await cli('upgrade')
    assert.equal(await readFile(path, 'utf8'), changed)
    await cli('install', '--codex-memory', 'off')
    assert.equal(parse(await readFile(path, 'utf8')).tools.update_plan.enabled, false)
    await cli('init', '--codex-memory', 'inherit')
    assert.equal(parse(await readFile(path, 'utf8')).memories, undefined)
    assert.equal(parse(await readFile(path, 'utf8')).tools.update_plan.enabled, true)
    await cli('install', '--codex-memory', 'off')
    const configured = await readFile(path, 'utf8')
    await cli('uninstall')
    assert.equal(await readFile(path, 'utf8'), configured)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('bare init completes a real terminal questionnaire and reuses global configuration across projects', {
  skip: !process.env.JTH_TEST_DATABASE_URL || !existsSync('/usr/bin/expect'), timeout: 60000,
}, async () => {
  const root = resolve(import.meta.dirname, '../../..'), fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-init-wizard-')))
  const workspace = resolve(fixture, 'first-project'), sibling = resolve(fixture, 'second-project'), declined = resolve(fixture, 'declined-project'), home = resolve(fixture, 'codex-home')
  const userConfig = resolve(fixture, 'user-config'), envFile = resolve(userConfig, '.env'), binary = resolve(root, 'bin/jth.mjs')
  const environment: NodeJS.ProcessEnv = { ...process.env, JTH_CONFIG_DIR: userConfig, CODEX_HOME: home, TERM: 'dumb' }
  for (const key of ['JTH_ENV_FILE', 'JTH_DATABASE_URL', 'JTH_DATA_DIR', 'JTH_PG_DATA_DIR', 'JTH_PG_BIN_DIR', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_API_KEY']) delete environment[key]
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.writeHead(500).end() })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string')
  const cli = async (cwd: string, ...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['--', binary, ...args], { cwd, env: environment })).stdout)
  const questionnaire = (cwd: string, answers: [string, string][]) => new Promise<string>((done, reject) => {
    const child = execFile('/usr/bin/expect', ['-f', '-', process.execPath, '--', binary, 'init', ...answers.flat()],
      { cwd, env: environment, timeout: 25000 }, (error, stdout, stderr) => {
        if (error) { reject(new Error(`初始化问卷失败 (${error.code}/${error.signal})：${(stdout + stderr).slice(-1800)}`)); return }
        const output = stdout + stderr
        for (const [question] of answers) if (!output.includes(question)) { reject(new Error(`问卷缺少问题：${question}`)); return }
        done(output)
      })
    // macOS's bundled Expect crashes matching mixed-width prompt patterns; the ASCII suffix is stable.
    child.stdin!.end('set timeout 20\nlog_user 1\nspawn -noecho {*}[lrange $argv 0 3]\nexpect_before timeout {exit 124}\nforeach {question answer} [lrange $argv 4 end] {\n  expect -exact {: }\n  send -- "$answer\\r"\n}\nexpect eof\ncatch wait result\nexit [lindex $result 3]\n')
  })
  try {
    for (const path of [workspace, sibling, declined, home, userConfig]) await mkdir(path)
    await writeFile(resolve(home, 'config.toml'), '[features]\nhooks=true\n[memories]\nuse_memories=true\ngenerate_memories=true\n')
    await writeFile(envFile, `JTH_DATA_DIR=${fixture}/data\n`)
    // Only the temporary database owned by scripts/test-postgres.mjs is used here.
    await pool.query('DROP SCHEMA IF EXISTS jt_memo CASCADE')
    const first = await questionnaire(workspace, [
      ['项目名称', ''], ['信任当前 Codex 项目', ''], ['Embedding 服务地址', `http://127.0.0.1:${address.port}/v1`],
      ['Embedding 模型', 'wizard-fixture'], ['向量维度', '2'], ['PostgreSQL 连接地址', 'postgresql://127.0.0.1:1/test'],
      ['Embedding API Key', 'private-wizard-key'], ['重新输入数据库连接并重试', ''], ['PostgreSQL 连接地址', process.env.JTH_TEST_DATABASE_URL!],
    ])
    assert(first.includes('初始化完成'), first.slice(-1500))
    assert(first.includes('项目：first-project'))
    assert(!first.includes('private-wizard-key'))
    assert.equal((await pool.query('SELECT version FROM jt_memo.schema_version')).rows[0].version, 8)
    const saved = await readFile(envFile, 'utf8')
    assert.equal(parseEnv(saved).EMBEDDING_API_KEY, 'private-wizard-key')
    assert.equal((await stat(envFile)).mode & 0o777, 0o600)
    assert.deepEqual((await cli(workspace, 'flow', 'status')).memo_scope.project_ids, ['first-project'])
    const second = await questionnaire(sibling, [['项目名称', ''], ['信任当前 Codex 项目', '']])
    assert(second.includes('初始化完成')); assert(second.includes('直接复用，不重复询问凭据'))
    assert(!second.includes('Embedding API Key'))
    assert.equal(await readFile(envFile, 'utf8'), saved)
    assert.equal((await cli(sibling, 'flow', 'status')).configuration.envFile, envFile)
    // Existing scope wins over the directory name, including noninteractive reruns.
    const installed = await cli(sibling, 'init', '--trust')
    assert.deepEqual(installed.memo.settings.scope.project_ids, ['second-project'])
    assert.equal(installed.verification.checks.find((check: { name: string }) => check.name === 'hooks').status, 'ok')
    assert.equal(await readFile(envFile, 'utf8'), saved)
    assert.equal(parse(await readFile(resolve(home, 'config.toml'), 'utf8')).memories.use_memories, true)
    assert.equal(parse(await readFile(resolve(workspace, '.codex/config.toml'), 'utf8')).memories.use_memories, false)
    const nativeBefore = await readFile(resolve(home, 'config.toml'), 'utf8')
    const declinedResult = await questionnaire(declined, [['项目名称', ''], ['信任当前 Codex 项目', 'n']])
    assert(declinedResult.includes('仍有待处理项'))
    assert.equal(await readFile(resolve(home, 'config.toml'), 'utf8'), nativeBefore, 'Declining must not grant project or Hook trust')
    assert.equal(requests, 0, 'Initialization must not call Embedding or a generation model')
  } finally {
    await pool.end()
    await new Promise<void>(done => server.close(() => done()))
    await rm(fixture, { recursive: true, force: true })
  }
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
