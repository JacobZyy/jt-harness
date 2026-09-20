import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('native flow installs without PG or model calls, retires old hooks and preserves recovery data', { timeout: 20000 }, async () => {
  const workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-native-flow-')))
  const root = fileURLToPath(new URL('../../../', import.meta.url)), run = promisify(execFile)
  let connections = 0
  const server = createServer(socket => { connections++; socket.destroy() })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string')
  const envFile = resolve(workspace, '.env')
  const cli = (...args: string[]) => run(process.execPath, [resolve(root, 'bin/jth.mjs'), 'flow', ...args, '--workspace', workspace], { cwd: workspace })
  const hook = () => new Promise<{ stdout: string, stderr: string }>((done, reject) => {
    const child = execFile(process.execPath, [resolve(root, 'bin/jth.mjs'), 'flow', 'hook', '--workspace', workspace], { cwd: workspace },
      (error, stdout, stderr) => error ? reject(error) : done({ stdout, stderr }))
    child.stdin!.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'old-session', cwd: workspace }))
  })
  try {
    await mkdir(resolve(workspace, '.codex'), { recursive: true })
    await mkdir(resolve(workspace, '.jth/flow-events'), { recursive: true })
    const originalAgent = '# Project\nExisting instructions.\n'
    await writeFile(resolve(workspace, 'AGENTS.md'), originalAgent)
    await writeFile(envFile, `JTH_DATABASE_URL=postgresql://127.0.0.1:${address.port}/must_not_connect\nJTH_DATA_DIR=${workspace}/data\nEMBEDDING_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBEDDING_API_KEY=test\nEMBEDDING_MODEL=test\nEMBEDDING_DIMENSIONS=2\nJTH_DSH_BIN=/must-not-run-dsh\n`)
    const pending = '{"historical":"keep exactly"}\n', sqlite = 'legacy database bytes'
    await writeFile(resolve(workspace, '.jth/flow-events/pending.json'), pending)
    await writeFile(resolve(workspace, '.jth/flow.sqlite'), sqlite)
    await writeFile(resolve(workspace, '.codex/hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'old-flow', statusMessage: 'jth flow context' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }, { type: 'command', command: 'old-flow', statusMessage: 'jth flow context' }] }],
    } }))
    const installed = JSON.parse((await cli('install', '--env-file', envFile, '--project', 'fixture')).stdout)
    assert.equal(installed.mode, 'native')
    assert.deepEqual(installed.events, [])
    const configured = await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')
    const document = JSON.parse(configured) as { hooks: Record<string, { hooks: { command: string, statusMessage?: string }[] }[]> }
    const handlers = Object.values(document.hooks).flatMap(groups => groups.flatMap(group => group.hooks))
    assert.equal(handlers.length, 2)
    assert(handlers.some(handler => handler.command === 'other-tool'))
    assert(handlers.some(handler => handler.statusMessage === 'jth memo declaration'))
    assert.equal(await readlink(resolve(workspace, '.agents/skills/jth-flow')), resolve(root, 'packages/flow/skills/jth-flow'))
    await cli('install', '--env-file', envFile, '--project', 'fixture')
    assert.equal(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8'), configured)
    const status = JSON.parse((await cli('status')).stdout)
    assert.equal(status.mode, 'native')
    assert.equal(status.legacy_flow_hooks, 0)
    assert.equal(status.memo_enabled, true)
    assert.deepEqual(status.memo_scope.project_ids, ['fixture'])
    assert(!Object.hasOwn(status, 'tasks'))
    assert.deepEqual(JSON.parse((await cli('context')).stdout), status)
    assert.deepEqual(await hook(), { stdout: '{}\n', stderr: '' })
    assert.equal(JSON.parse((await cli('sync')).stdout).skipped, 'legacy-background-work')
    assert.equal(JSON.parse((await cli('recall', '--task', 'old', '--request', 'old')).stdout).skipped, 'legacy-background-work')
    await assert.rejects(cli('start', 'do not create another task'), /Codex 原生/)
    await cli('uninstall')
    assert.equal(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8'), configured)
    assert.equal(await readFile(resolve(workspace, '.jth/flow-events/pending.json'), 'utf8'), pending)
    assert.equal(await readFile(resolve(workspace, '.jth/flow.sqlite'), 'utf8'), sqlite)
    assert((await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')).startsWith(originalAgent))
    assert.equal(connections, 0, 'Native setup, status and retired hooks must not connect to PG or a model endpoint')
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(workspace, { recursive: true, force: true }) }
})
