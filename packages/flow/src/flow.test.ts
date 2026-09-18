import { Pool } from 'pg'
import { prepareFlowDatabase } from '@jt-harness/flow'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { FlowStore, memoryKey } from './store.ts'
import { renderFlowContext } from './context.ts'
import { workspaceSnapshot, verifyTask } from './verification.ts'

async function fixture() {
  const workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-flow-')))
  execFileSync('git', ['init', '-q', workspace])
  await writeFile(resolve(workspace, '.gitignore'), '/.jth/\n')
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
  await prepareFlowDatabase(pool)
  const store = new FlowStore(workspace, pool)
  await store.install({ version: 1, workspace, envFile: resolve(workspace, '.env'), projectIds: ['test'], businessIds: [], installedAt: new Date().toISOString() })
  return { store, workspace, cleanup: async () => { await store.close(); await rm(workspace, { recursive: true, force: true }) } }
}

test('the conversation drift case: a lightweight constraint preserves the goal and discussion phase across restart', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture()
  try {
    const goal = '解决长任务目标偏移和失忆，讨论一套流程控制方案'
    const task = await f.store.start({ goal, acceptance: ['针对核心痛点比较方案，候选保持未决'], constraints: ['和已有记忆系统结合'] }, await workspaceSnapshot(f.workspace), 'main')
    await f.store.checkpoint(task.id, { constraint: ['轻量、主流程控制、验证交给测试用例'], next: '评估 Trellis 哪些机制解决原目标' }, 'main')
    const reopened = new FlowStore(f.workspace, new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL }))
    try {
      const restored = (await reopened.current('main'))!
      assert.equal(restored.goal, goal)
      assert.equal(restored.phase, 'discussion')
      assert.equal(restored.constraints.length, 2)
      const context = renderFlowContext(f.workspace, 'main', restored, await reopened.binding('main'))
      assert(context.includes(goal) && context.includes('当前处于讨论'))
      assert(context.includes('不自行安装') && context.includes('新增约束不替换目标'))
      await assert.rejects(async () => await reopened.checkpoint(task.id, { phase: 'execution' }, 'main'), /授权/)
      await reopened.checkpoint(task.id, { phase: 'execution', reason: '用户明确要求做完原型' }, 'main')
      await reopened.revise(task.id, '解决同一痛点，交付可运行原型', '用户已从讨论改为交付', 'main')
      assert.equal((await reopened.task(task.id)).initialGoal, goal)
      assert((await reopened.history(task.id)).some(event => event.kind === 'goal-revised'))
    } finally { await reopened.close() }
  } finally { await f.cleanup() }
})

test('session isolation, child ownership and explicit takeover survive lifecycle events', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture()
  try {
    const task = await f.store.start({ goal: '主任务', acceptance: ['确认主目标'] }, {}, 'parent')
    await f.store.observe('other', 'SessionStart')
    assert.equal(await f.store.current('other'), null)
    await f.store.observe('child', 'SessionStart')
    await f.store.observe('child', 'SubagentStart', 'parent')
    assert.equal((await f.store.current('child'))!.id, task.id)
    await assert.rejects(async () => await f.store.checkpoint(task.id, { next: '越权' }, 'child'), /不是任务主控/)
    await assert.rejects(async () => await f.store.resume(task.id, 'child', true), /子 Agent/)
    for (const event of ['Stop', 'Interrupt', 'SessionEnd']) await f.store.observe('parent', event)
    assert.equal((await f.store.task(task.id)).phase, 'discussion')
    await assert.rejects(async () => await f.store.resume(task.id, 'new'), /已有主控/)
    await f.store.resume(task.id, 'new', true)
    assert.equal((await f.store.binding('parent'))!.role, 'observer')
    await assert.rejects(async () => await f.store.revise(task.id, '另一个目标', '旧会话消息', 'parent'), /不是任务主控/)
    await f.store.pause(task.id, '用户明确要求先处理新任务', 'new')
    assert.equal(await f.store.current('new'), null)
    assert.equal((await f.store.task(task.id)).phase, 'discussion')
    await f.store.start({ goal: '另一个明确目标', acceptance: ['有独立交付'] }, {}, 'new')
    await f.store.observe('child', 'SubagentStop', 'parent')
    assert.equal((await f.store.current('child'))!.id, task.id)
    await f.store.resume(task.id, 'returning')
    assert.equal((await f.store.current('returning'))!.id, task.id)
  } finally { await f.cleanup() }
})

test('finish needs current tests, resolved questions and in-scope changes; commits do not invalidate evidence', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture()
  try {
    await mkdir(resolve(f.workspace, 'src'))
    await writeFile(resolve(f.workspace, 'src/value'), 'expected')
    const command = `${process.execPath} -e "if(require('fs').readFileSync('src/value','utf8')!=='expected')process.exit(3)"`
    const task = await f.store.start({ goal: '实现范围内功能', phase: 'execution', scope: ['./src/'], acceptance: ['运行行为通过'], checks: [command] }, await workspaceSnapshot(f.workspace), 'main')
    await assert.rejects(async () => await f.store.finish(task.id, '完成', {}, 'main'), /尚未通过/)
    const first = await verifyTask(f.store, task.id, 'main')
    assert.equal(first.passed, true)
    assert.equal(await readFile(first.results[0].log, 'utf8'), '')
    await f.store.checkpoint(task.id, { done: ['取得真实测试证据'] }, 'main')
    await writeFile(resolve(f.workspace, 'src/value'), 'changed')
    const changed = await workspaceSnapshot(f.workspace)
    await assert.rejects(async () => await f.store.finish(task.id, '完成', changed, 'main'), /文件状态已变化/)
    assert.equal((await verifyTask(f.store, task.id, 'main')).passed, false)
    await writeFile(resolve(f.workspace, 'src/value'), 'expected')
    await f.store.checkpoint(task.id, { constraint: ['新增业务约束'] }, 'main')
    await assert.rejects(async () => await f.store.finish(task.id, '完成', {}, 'main'), /尚未通过/)
    await verifyTask(f.store, task.id, 'main')
    const version = (await f.store.task(task.id)).contractVersion
    await f.store.checkpoint(task.id, { constraint: ['新增业务约束'] }, 'main')
    assert.equal((await f.store.task(task.id)).contractVersion, version)
    await f.store.checkpoint(task.id, { question: ['是否已确认边界'] }, 'main')
    await assert.rejects(async () => await f.store.finish(task.id, '完成', {}, 'main'), /未决问题/)
    await f.store.checkpoint(task.id, { resolve: [(await f.store.task(task.id)).questions[0].id], decision: ['已确认'] }, 'main')
    await writeFile(resolve(f.workspace, 'outside'), 'unrelated')
    await verifyTask(f.store, task.id, 'main')
    const outside = await workspaceSnapshot(f.workspace)
    await assert.rejects(async () => await f.store.finish(task.id, '完成', outside, 'main'), /范围以外/)
    await rm(resolve(f.workspace, 'outside'))
    await verifyTask(f.store, task.id, 'main')
    execFileSync('git', ['add', '.'], { cwd: f.workspace })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: f.workspace })
    const finished = await f.store.finish(task.id, '行为通过，边界确认', await workspaceSnapshot(f.workspace), 'main')
    assert.equal(finished.phase, 'completed')
    assert.equal((await f.store.finish(task.id, '重复回执', await workspaceSnapshot(f.workspace), 'main')).summary, finished.summary)
  } finally { await f.cleanup() }
})

test('test timeout cannot pass and source-mutating checks do not grant completion', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture()
  try {
    const task = await f.store.start({ goal: '超时验证', phase: 'execution', acceptance: ['必须完成检查'], checks: [`${process.execPath} -e "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"`] }, {}, 'main')
    const result = await verifyTask(f.store, task.id, 'main', 100)
    assert.equal(result.passed, false)
    assert.equal(result.results[0].timedOut, true)
    const second = await f.store.start({ goal: '会改源文件的检查', phase: 'execution', acceptance: ['源文件稳定'], checks: [`${process.execPath} -e "require('fs').writeFileSync('changed','new')"`] }, {}, 'other')
    assert.equal((await verifyTask(f.store, second.id, 'other')).sourceUnchanged, false)
    const third = await f.store.start({ goal: '中断重跑时撤销旧结果', phase: 'execution', acceptance: ['最新一次检查通过'], checks: [`${process.execPath} -e "process.exit(0)"`] }, {}, 'rerun')
    assert.equal((await verifyTask(f.store, third.id, 'rerun')).passed, true)
    const controller = new AbortController()
    controller.abort()
    assert.equal((await verifyTask(f.store, third.id, 'rerun', 1000, controller.signal)).passed, false)
    assert.equal((await f.store.task(third.id)).verification!.passed, false)
  } finally { await f.cleanup() }
})

test('recall leases fence stale results, conflict labels remain data and offline state is observable', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture()
  try {
    const task = await f.store.start({ goal: '召回项目背景', acceptance: ['保留任务边界'] }, {}, 'main')
    const request = (await f.store.claimRecall(task.id))!
    assert.equal(await f.store.claimRecall(task.id), null)
    const entries = [{ id: randomUUID(), content: '旧配置可能冲突', state: 'conflicted', claimStatus: 'asserted', sourceSession: 'historical' }]
    assert.equal(await f.store.saveRecall(task.id, memoryKey(task), request, entries), true)
    assert(renderFlowContext(f.workspace, 'main', await f.store.task(task.id), await f.store.binding('main')).includes('conflicted'))
    assert.equal(await f.store.claimRecall(task.id), null)
    await f.store.checkpoint(task.id, { constraint: ['用户增加边界'] }, 'main')
    assert.equal(await f.store.saveRecall(task.id, memoryKey(task), request, entries), false)
    const next = (await f.store.claimRecall(task.id))!
    await f.store.saveRecall(task.id, memoryKey(await f.store.task(task.id)), next, [], 'database offline')
    assert.equal((await f.store.task(task.id)).memory!.status, 'failed')
    assert.equal((await f.store.current('main'))!.goal, task.goal)
  } finally { await f.cleanup() }
})
