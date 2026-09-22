import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, rename, rm } from 'node:fs/promises'
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
  const event = { hook_event_name: 'UserPromptSubmit', session_id: 'current-session', turn_id: 'turn-one', cwd: workspace }
  const hook = (command = 'hook', input = JSON.stringify(event)) => new Promise<{ stdout: string, stderr: string }>((done, reject) => {
    const child = execFile(process.execPath, [resolve(root, 'bin/jth.mjs'), 'flow', command, '--workspace', workspace], { cwd: workspace },
      (error, stdout, stderr) => error ? reject(error) : done({ stdout, stderr }))
    child.stdin!.end(input)
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
    assert.deepEqual(installed.events, ['UserPromptSubmit'])
    const configured = await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')
    const document = JSON.parse(configured) as { hooks: Record<string, { hooks: { command: string, statusMessage?: string }[] }[]> }
    const handlers = Object.values(document.hooks).flatMap(groups => groups.flatMap(group => group.hooks))
    assert.equal(handlers.length, 5)
    assert(handlers.some(handler => handler.command === 'other-tool'))
    assert(handlers.some(handler => handler.statusMessage === 'jth memo declaration'))
    assert(handlers.some(handler => handler.statusMessage === 'jth flow entry' && handler.command.includes("'prompt'")))
    assert.equal(await readlink(resolve(workspace, '.agents/skills/jth-flow')), resolve(root, 'packages/flow/skills/jth-flow'))
    await cli('install', '--env-file', envFile, '--project', 'fixture')
    assert.equal(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8'), configured)
    const status = JSON.parse((await cli('status')).stdout)
    assert.equal(status.mode, 'native')
    assert.equal(status.legacy_flow_hooks, 0)
    assert.equal(status.memo_enabled, true)
    assert.equal(status.entry_hook.installed, true)
    assert.equal(status.entry_hook.last_emission, null)
    assert.deepEqual(status.memo_scope.project_ids, ['fixture'])
    assert(!Object.hasOwn(status, 'tasks'))
    assert.deepEqual(JSON.parse((await cli('context')).stdout), status)
    assert.deepEqual(await hook(), { stdout: '{}\n', stderr: '' })
    // The actual handler must work even when the configured environment file is unavailable.
    await rename(envFile, `${envFile}.offline`)
    const injected = await hook('prompt', JSON.stringify({ ...event, prompt: 'PRIVATE_USER_TEXT', transcript_path: '/must-not-read' }))
    await rename(`${envFile}.offline`, envFile)
    assert.equal(injected.stderr, '')
    const context = JSON.parse(injected.stdout).hookSpecificOutput
    assert.equal(context.hookEventName, 'UserPromptSubmit')
    assert(context.additionalContext.includes(resolve(workspace, '.agents/skills/jth-flow/SKILL.md')))
    assert(Buffer.byteLength(context.additionalContext) < 2000)
    const receipt = await readFile(resolve(workspace, '.jth/flow-entry.json'), 'utf8')
    assert.equal(JSON.parse(receipt).turn_id, 'turn-one')
    assert(!`${injected.stdout}${receipt}`.includes('PRIVATE_USER_TEXT'))
    assert(!receipt.includes('transcript_path'))
    assert.equal(JSON.parse((await cli('status')).stdout).entry_hook.last_emission.session_id, event.session_id)
    for (const ignored of [{ ...event, hook_event_name: 'Stop' }, { ...event, cwd: await realpath(tmpdir()) }]) {
      assert.deepEqual(JSON.parse((await hook('prompt', JSON.stringify(ignored))).stdout), {})
    }
    assert.equal(await readFile(resolve(workspace, '.jth/flow-entry.json'), 'utf8'), receipt)
    const malformed = await hook('prompt', 'PRIVATE_BAD_JSON')
    assert.deepEqual(JSON.parse(malformed.stdout), {})
    assert(malformed.stderr.includes('Hook 输入不是有效 JSON'))
    assert(!malformed.stderr.includes('PRIVATE_BAD_JSON'))
    assert.deepEqual(JSON.parse((await hook('prompt', 'x'.repeat(512001))).stdout), {})
    // Read-only diagnostics must not prevent the host from receiving the entry context.
    await rename(resolve(workspace, '.jth/flow-entry.json'), resolve(workspace, '.jth/saved-entry.json'))
    await mkdir(resolve(workspace, '.jth/flow-entry.json'))
    const withoutReceipt = await hook('prompt')
    assert(JSON.parse(withoutReceipt.stdout).hookSpecificOutput)
    assert(withoutReceipt.stderr.includes('触发记录写入失败'))
    await rm(resolve(workspace, '.jth/flow-entry.json'), { recursive: true })
    await rename(resolve(workspace, '.jth/saved-entry.json'), resolve(workspace, '.jth/flow-entry.json'))
    assert.equal(JSON.parse((await cli('sync')).stdout).skipped, 'legacy-background-work')
    assert.equal(JSON.parse((await cli('recall', '--task', 'old', '--request', 'old')).stdout).skipped, 'legacy-background-work')
    await assert.rejects(cli('start', 'do not create another task'), /Codex 原生/)
    await cli('uninstall')
    const remaining = JSON.parse(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8'))
    const expected = structuredClone(document)
    expected.hooks.UserPromptSubmit = expected.hooks.UserPromptSubmit.filter(group => group.hooks.some(handler => handler.statusMessage !== 'jth flow entry'))
    assert.deepEqual(remaining, expected)
    assert.equal(JSON.parse((await cli('status')).stdout).entry_hook.installed, false)
    assert.deepEqual(JSON.parse((await hook('prompt')).stdout), {}, 'Cached host commands must stop injecting after uninstall')
    assert.equal(await readFile(resolve(workspace, '.jth/flow-entry.json'), 'utf8'), receipt)
    assert.equal(await readFile(resolve(workspace, '.jth/flow-events/pending.json'), 'utf8'), pending)
    assert.equal(await readFile(resolve(workspace, '.jth/flow.sqlite'), 'utf8'), sqlite)
    assert((await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')).startsWith(originalAgent))
    assert.equal(connections, 0, 'Native setup, status and retired hooks must not connect to PG or a model endpoint')
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(workspace, { recursive: true, force: true }) }
})
