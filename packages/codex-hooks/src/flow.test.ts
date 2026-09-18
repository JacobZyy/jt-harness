import { Pool } from 'pg'
import { prepareFlowDatabase } from '@jt-harness/flow'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir, readlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { FlowStore } from '@jt-harness/flow'
import { configureHooks } from './install.ts'
import { configureFlowHooks, flowHook, flowEvents } from './flow.ts'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))

test('native flow hooks coexist with DSH capture, preserve other handlers, restore goals and never finish on Stop', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-flow-hooks-')))
  const config = { dataDir: resolve(workspace, '.jth/memo-test'), envFile: resolve(workspace, '.env') }
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
  await prepareFlowDatabase(pool)
  const store = new FlowStore(workspace, pool)
  try {
    await mkdir(resolve(workspace, '.codex'), { recursive: true })
    await writeFile(resolve(workspace, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'another-tool' }] }] } }))
    await store.install({ version: 1, workspace, envFile: config.envFile, projectIds: ['fixture'], businessIds: [], installedAt: new Date().toISOString() })
    await configureHooks(root, config, workspace, { project_ids: ['fixture'], business_ids: [] }, resolve(workspace, '.codex'))
    const memoHooks = JSON.parse(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8'))
    await configureFlowHooks(root, workspace)
    const first = await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')
    await configureFlowHooks(root, workspace)
    assert.equal(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8'), first)
    assert.equal(await readlink(resolve(workspace, '.agents/skills/jth-flow')), resolve(root, 'packages/flow/skills/jth-flow'))
    for (const event of flowEvents) assert.equal(JSON.parse(first).hooks[event].flatMap((group: { hooks: { statusMessage?: string }[] }) => group.hooks).filter((handler: { statusMessage?: string }) => handler.statusMessage === 'jth flow context').length, 1)
    const task = await store.start({ goal: '解决原来的长任务目标偏移', acceptance: ['保留讨论边界'] }, {}, 'parent')
    for (const hook_event_name of ['SessionStart', 'UserPromptSubmit'] as const) {
      const result = await flowHook({ hook_event_name, session_id: 'parent', cwd: workspace, source: 'compact' }, store)
      assert.equal(result.output.hookSpecificOutput!.hookEventName, hook_event_name)
      assert(result.output.hookSpecificOutput!.additionalContext.includes(task.goal))
    }
    const child = await flowHook({ hook_event_name: 'SubagentStart', session_id: 'parent', agent_id: 'child', cwd: workspace }, store)
    assert.equal((await store.binding('child'))!.taskId, task.id)
    assert(child.output.hookSpecificOutput!.additionalContext.includes('观察者'))
    for (const hook_event_name of ['Stop', 'Interrupt', 'SessionEnd'] as const) {
      assert.deepEqual((await flowHook({ hook_event_name, session_id: 'parent', cwd: workspace }, store)).output, {})
    }
    assert.equal((await store.task(task.id)).phase, 'discussion')
    assert.deepEqual((await flowHook({ hook_event_name: 'SessionStart', session_id: 'foreign', cwd: tmpdir() }, store)).output, {})
    await configureFlowHooks(root, workspace, false)
    assert.deepEqual(JSON.parse(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')), memoHooks)
    assert.equal((await store.task(task.id)).goal, task.goal)
  } finally { await store.close(); await rm(workspace, { recursive: true, force: true }) }
})

test('built CLI delivers a persistent task, real checks and completion while memory is offline', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-flow-cli-')))
  await execute('git', ['init', '-q', workspace])
  const envFile = resolve(workspace, '.env')
  await writeFile(envFile, `JTH_DATA_DIR=${workspace}/.jth/memo-test\nJTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\n`)
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
  await prepareFlowDatabase(pool)
  const store = new FlowStore(workspace, pool)
  const command = async (...args: string[]) => {
    const result = await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), 'flow', ...args, '--workspace', workspace, '--session', 'cli-test'], { cwd: workspace })
    return JSON.parse(result.stdout)
  }
  try {
    await command('install', '--env-file', envFile, '--project', 'fixture')
    const created = await command('start', '验证真实 CLI 闭环', '--phase', 'execution', '--accept', '验收命令通过', '--check', `${process.execPath} -e "console.log('checked')"`)
    assert.equal(created.phase, 'execution')
    const recall = await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), 'flow', 'recall', '--workspace', workspace, '--task', created.id, '--request', (await store.task(created.id)).memory!.requestedAt]).catch(error => error)
    assert.equal(JSON.parse(recall.stdout).status, 'failed')
    assert.equal((await command('status')).id, created.id)
    await command('checkpoint', '--done', '真实命令已接通', '--next', '运行验收')
    const checked = await command('verify')
    assert.equal(checked.passed, true)
    assert.equal((await readFile(checked.results[0].log, 'utf8')).trim(), 'checked')
    assert.equal((await command('finish', '--summary', 'CLI 流程已完成')).phase, 'completed')
    await command('uninstall')
    assert.equal((await command('status')).phase, 'completed')
  } finally { await store.close(); await rm(workspace, { recursive: true, force: true }) }
})
