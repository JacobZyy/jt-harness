import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { captureSettingsSchema, flowEntryReceiptPath, readJson } from '@jacob-z/jt-harness/codex-hooks'
import { loadConfig } from '@jacob-z/jt-harness/memo/config'

// The CLI child owns only fixture HOME, configuration and Hook directories.
test('native user installation and file stdin preserve project files and inject without PG or model calls', { timeout: 30000 }, async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-user-flow-')))
  const root = resolve(import.meta.dirname, '../../..'), workspace = resolve(fixture, 'project'), codexHome = resolve(fixture, 'codex'), user = resolve(fixture, 'user')
  const execute = promisify(execFile)
  let connections = 0
  const server = createServer(socket => { connections++; socket.destroy() })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string')
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(JTH_|EMBEDDING_|CODEX_)/.test(name))), HOME: fixture, CODEX_HOME: codexHome, JTH_CONFIG_DIR: user, JTH_ENV_FILE: undefined,
    CODEX_THREAD_ID: undefined, JTH_DATA_DIR: undefined, JTH_DATABASE_URL: undefined, EMBEDDING_BASE_URL: undefined }
  const cli = async (...args: string[]) => execute(process.execPath, [...(process.versions.bun ? ['--no-env-file'] : []), resolve(root, 'bin/jth.ts'), 'flow', ...args, '--workspace', workspace], { cwd: workspace, env: environment })
  try {
    await mkdir(workspace); await mkdir(user)
    await writeFile(resolve(user, '.env'), `JTH_DATA_DIR=${fixture}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:${address.port}/must_not_connect\nEMBEDDING_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBEDDING_API_KEY=test\nEMBEDDING_MODEL=test\nEMBEDDING_DIMENSIONS=2\nJTH_DSH_BIN=/must-not-run-dsh\n`)
    const source = '# Project\nExisting team instructions.\n'
    await writeFile(resolve(workspace, 'AGENTS.md'), source)
    const installed = JSON.parse((await cli('install')).stdout)
    assert.equal(installed.mode, 'native')
    assert.equal(installed.hooks_path, resolve(codexHome, 'hooks.json'))
    assert.deepEqual(await readdir(workspace), ['AGENTS.md'])
    assert.equal(await readFile(resolve(workspace, 'AGENTS.md'), 'utf8'), source)
    const config = await loadConfig(root, undefined, environment)
    const hooks = await readJson(resolve(codexHome, 'hooks.json')) as { hooks: Record<string, { hooks: { statusMessage: string, command: string }[] }[]> }
    assert.equal(Object.values(hooks.hooks).flatMap(groups => groups.flatMap(group => group.hooks)).length, 4)
    for (const kind of ['flow', 'memo']) {
      const skill = await readFile(resolve(fixture, '.agents/skills', `jth-${kind}`, 'SKILL.md'), 'utf8')
      assert(skill.includes('references/'))
      if (kind === 'flow') for (const name of ['workflow-policy.md', 'acceptance.md']) assert((await readFile(resolve(fixture, '.agents/skills/jth-flow/references', name), 'utf8')).length > 0)
    }
    const status = JSON.parse((await cli('status')).stdout)
    assert.equal(status.entry_hook.source, 'user'); assert.equal(status.memo_enabled, true)
    assert(status.workspaces[0].project_ids[0].startsWith('project-'))
    assert.deepEqual(JSON.parse((await cli('context')).stdout), status)
    const event = { hook_event_name: 'UserPromptSubmit', session_id: 'file-stdin-session', turn_id: 'turn-one', cwd: workspace, prompt: 'PRIVATE_PROMPT' }
    const eventFile = resolve(fixture, 'event.json'); await writeFile(eventFile, JSON.stringify(event))
    const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await mkdir(resolve(fixture, 'bin')); await symlink(resolve(root, 'bin/jth.ts'), resolve(fixture, 'bin/jth'))
    const projectEnv = 'EMBEDDING_BASE_URL=business-invalid-url\nJTH_DATA_DIR=/must-not-write\n'
    await writeFile(resolve(workspace, '.env'), projectEnv)
    const entryCommand = Object.values(hooks.hooks).flatMap(groups => groups.flatMap(group => group.hooks)).find(handler => handler.statusMessage === 'jth flow entry')!.command
    const hookEnvironment = { ...environment, PATH: `${fixture}/bin:${process.env.PATH}` }
    const injected = await execute('/bin/sh', ['-c', `${entryCommand} < ${quoted(eventFile)}`], { cwd: workspace, env: hookEnvironment })
    assert.equal(injected.stderr, '')
    assert(JSON.parse(injected.stdout).hookSpecificOutput.additionalContext.includes('jth-flow'))
    let receipt = await readFile(flowEntryReceiptPath(workspace, config), 'utf8')
    assert.equal(JSON.parse(receipt).session_id, event.session_id)
    assert(!receipt.includes('PRIVATE_PROMPT'))
    assert.deepEqual(await readdir(workspace), ['.env', 'AGENTS.md'])
    assert.equal(await readFile(resolve(workspace, '.env'), 'utf8'), projectEnv)
    const auxiliary = resolve(fixture, 'auxiliary')
    await mkdir(auxiliary); await mkdir(resolve(codexHome, 'sessions'))
    const bound = { ...event, cwd: auxiliary, session_id: 'bound-session' }
    await writeFile(resolve(codexHome, 'sessions/rollout-bound-session.jsonl'), JSON.stringify({ type: 'session_meta', payload: {
      id: bound.session_id, cwd: workspace, runtime_workspace_roots: [workspace, auxiliary] } }) + '\n')
    await writeFile(eventFile, JSON.stringify(bound))
    await execute('/bin/sh', ['-c', `${entryCommand} < ${quoted(eventFile)}`], { cwd: auxiliary, env: hookEnvironment })
    receipt = await readFile(flowEntryReceiptPath(workspace, config), 'utf8')
    assert.equal(JSON.parse(receipt).session_id, bound.session_id)
    assert.equal(await readJson(flowEntryReceiptPath(auxiliary, config)), undefined)
    const fromAuxiliary = JSON.parse((await execute(process.execPath, [...(process.versions.bun ? ['--no-env-file'] : []),
      resolve(root, 'bin/jth.ts'), 'flow', 'status'], { cwd: auxiliary, env: { ...environment, CODEX_THREAD_ID: bound.session_id } })).stdout)
    assert.equal(fromAuxiliary.workspace, workspace)
    assert.equal(fromAuxiliary.cwd, auxiliary)
    assert.equal(fromAuxiliary.entry_hook.receipt_path, flowEntryReceiptPath(workspace, config))
    await cli('uninstall')
    const ignored = await execute('/bin/sh', ['-c', `${entryCommand} < ${quoted(eventFile)}`], { cwd: workspace, env: hookEnvironment })
    assert.deepEqual(JSON.parse(ignored.stdout), {})
    assert.equal(await readFile(flowEntryReceiptPath(workspace, config), 'utf8'), receipt)
    assert.equal(connections, 0)
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(fixture, { recursive: true, force: true }) }
})
