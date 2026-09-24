import { Pool } from 'pg'
import { prepareFlowDatabase } from '@jacob-z/jt-harness/flow'
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
import { workProgress } from './work.ts'

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

test('one work unit binds acceptance and survives interruption; stale and child receipts cannot settle it', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture()
  try {
    const task = await f.store.start({ goal: '只检查指定写法，不扩大成审查', phase: 'execution', acceptance: ['找到指定调用路径'], steps: ['定位', '验证'] }, {}, 'owner')
    const focus = { action: '追踪目标函数', acceptance: [1], readScope: ['src/target.ts'], expected: '目标调用路径与证据' }
    await assert.rejects(f.store.focus(task.id, { ...focus, acceptance: [2] }, 'owner'), /验收编号不存在/)
    await assert.rejects(f.store.focus(task.id, { ...focus, readScope: ['../other'] }, 'owner'), /路径必须/)
    const active = await f.store.focus(task.id, focus, 'owner')
    await assert.rejects(f.store.focus(task.id, focus, 'owner'), /未回执/)
    await assert.rejects(f.store.finish(task.id, '提前完成', {}, 'owner'), /工作单元/)
    await assert.rejects(f.store.checkpoint(task.id, { done: ['跳过回执'] }, 'owner'), /不能跳过/)
    await f.store.observe('child', 'SubagentStart', 'owner')
    await assert.rejects(f.store.focus(task.id, focus, 'child'), /不是任务主控/)
    await f.store.observe('owner', 'Interrupt')
    await f.store.pause(task.id, '换会话恢复', 'owner')
    const reopened = new FlowStore(f.workspace, new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL }))
    try {
      const restored = await reopened.resume(task.id, 'resumed')
      assert.deepEqual(restored.work, active.work)
      assert.equal(restored.goal, task.goal)
      const receipt = { workId: active.work!.id, outcome: 'progress' as const, done: ['定位到目标调用'], evidence: ['src/target.ts:12'], next: '运行对应测试', completeStep: 1 }
      await assert.rejects(reopened.checkpoint(task.id, receipt, 'child'), /不是任务主控/)
      await assert.rejects(reopened.checkpoint(task.id, { ...receipt, evidence: [] }, 'resumed'), /可查证据/)
      await assert.rejects(reopened.checkpoint(task.id, { ...receipt, outcome: 'failed' }, 'resumed'), /只有 progress/)
      await assert.rejects(reopened.checkpoint(task.id, { ...receipt, workId: randomUUID() }, 'resumed'), /ID 已失效/)
      const settled = await reopened.checkpoint(task.id, receipt, 'resumed')
      assert.equal(settled.work, null)
      assert.equal(settled.attempts[0].work.action, focus.action)
      assert.equal(settled.attempts[0].next, receipt.next)
      assert(settled.steps[0].completedAt)
      assert.deepEqual(await reopened.checkpoint(task.id, receipt, 'resumed'), settled)
      const next = await reopened.focus(task.id, { ...focus, action: '运行对应测试' }, 'resumed')
      await reopened.checkpoint(task.id, { constraint: ['只读定位'] }, 'resumed')
      assert.equal((await reopened.task(task.id)).work, null)
      await assert.rejects(reopened.checkpoint(task.id, { ...receipt, workId: next.work!.id }, 'resumed'), /ID 已失效/)
      assert.equal((await reopened.task(task.id)).attempts.length, 1)
    } finally { await reopened.close() }
  } finally { await f.cleanup() }
})

test('repeated failures without new evidence require a changed hypothesis, while hooks and duplicate receipts do not count', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture()
  try {
    const task = await f.store.start({ goal: '修复目标调用', acceptance: ['调用成功'] }, {}, 'owner')
    const focus = { action: '检查调用失败', acceptance: [1], readScope: ['src'], expected: '调用成功的证据' }
    const first = await f.store.focus(task.id, focus, 'owner')
    const receipt = { workId: first.work!.id, outcome: 'failed' as const, done: ['调用仍失败'], evidence: ['call-error:ECONNREFUSED'], next: '检查失败原因' }
    await f.store.checkpoint(task.id, receipt, 'owner')
    await f.store.checkpoint(task.id, receipt, 'owner')
    assert.equal(workProgress(await f.store.task(task.id)).consecutiveWithoutProgress, 1)
    await assert.rejects(f.store.checkpoint(task.id, { ...receipt, done: ['改写结果'] }, 'owner'), /不能用同一 ID/)
    const second = await f.store.focus(task.id, focus, 'owner')
    await f.store.checkpoint(task.id, { ...receipt, workId: second.work!.id, outcome: 'no-progress' }, 'owner')
    for (const event of ['Stop', 'SessionEnd', 'SessionStart']) await f.store.observe('owner', event)
    const stalled = await f.store.task(task.id)
    assert.equal(stalled.phase, 'discussion')
    assert.equal(workProgress(stalled).action, 'change-approach')
    assert.equal(workProgress(stalled).consecutiveWithoutProgress, 2)
    await assert.rejects(f.store.focus(task.id, focus, 'owner'), /不同诊断假设/)
    const changed = await f.store.focus(task.id, { ...focus, hypothesis: '检查服务监听端口是否变化' }, 'owner')
    assert.equal(workProgress(changed).action, 'continue')
    const advanced = await f.store.checkpoint(task.id, { ...receipt, workId: changed.work!.id, outcome: 'progress', done: ['确认端口变化'], evidence: ['listener:3081'] }, 'owner')
    assert.equal(workProgress(advanced).consecutiveWithoutProgress, 0)
    const blocked = await f.store.focus(task.id, focus, 'owner')
    await assert.rejects(f.store.checkpoint(task.id, { ...receipt, workId: blocked.work!.id, outcome: 'blocked', evidence: [] }, 'owner'), /实际原因/)
    await f.store.checkpoint(task.id, { ...receipt, workId: blocked.work!.id, outcome: 'blocked', evidence: [], blocked: '等待服务启动' }, 'owner')
    await assert.rejects(f.store.focus(task.id, focus, 'owner'), /仍有阻塞/)
    await f.store.checkpoint(task.id, { blocked: '', decision: ['服务已恢复'] }, 'owner')
    for (const evidence of ['port:3081-refused', 'port:3082-refused']) {
      const active = await f.store.focus(task.id, focus, 'owner')
      await f.store.checkpoint(task.id, { ...receipt, workId: active.work!.id, evidence: [evidence] }, 'owner')
    }
    assert.equal(workProgress(await f.store.task(task.id)).action, 'continue')
  } finally { await f.cleanup() }
})

test('legacy tasks gain empty work state, and archived receipts remain idempotent beyond the recent window', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture(), pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
  try {
    const task = await f.store.start({ goal: '保留旧任务', acceptance: ['历史可恢复'] }, {}, 'owner')
    await pool.query("UPDATE jt_flow.tasks SET value=value-'work'-'attempts' WHERE workspace=$1 AND id=$2", [f.workspace, task.id])
    assert.equal((await f.store.task(task.id)).work, null)
    assert.deepEqual((await f.store.task(task.id)).attempts, [])
    let firstReceipt
    for (let i = 0; i < 9; i++) {
      const active = await f.store.focus(task.id, { action: `验证 ${i}`, acceptance: [1], readScope: ['src'], expected: '恢复证据' }, 'owner')
      const receipt = { workId: active.work!.id, outcome: 'progress' as const, done: [`证据 ${i}`], evidence: [`result:${i}`], next: '继续' }
      firstReceipt ??= receipt
      await f.store.checkpoint(task.id, receipt, 'owner')
    }
    const settled = await f.store.task(task.id)
    assert.equal(settled.attempts.length, 8)
    assert.deepEqual(await f.store.checkpoint(task.id, firstReceipt!, 'owner'), settled)
  } finally { await pool.end(); await f.cleanup() }
})

test('ordered stages keep the overall goal through interruption, restart and final acceptance', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const f = await fixture()
  try {
    const task = await f.store.start({ goal: '恢复异常，不丢失已保存数据', phase: 'execution', acceptance: ['真实回补并验证数据完整'],
      steps: ['保留基线', '实现与验证'], checks: [`${process.execPath} -e "process.exit(0)"`] }, await workspaceSnapshot(f.workspace), 'owner')
    await assert.rejects(f.store.checkpoint(task.id, { completeStep: 2, done: ['跳步'] }, 'owner'), /只能完成当前/)
    await assert.rejects(f.store.checkpoint(task.id, { completeStep: 1 }, 'owner'), /证据/)
    await f.store.checkpoint(task.id, { completeStep: 1, done: ['原始材料与向量哈希已保存'], constraint: ['不做独立交付'] }, 'owner')
    await f.store.pause(task.id, '验证中断恢复', 'owner')
    const reopened = new FlowStore(f.workspace, new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL }))
    try {
      const restored = await reopened.resume(task.id, 'resumed')
      assert.equal(restored.goal, task.goal)
      assert.equal(restored.initialGoal, task.goal)
      assert(restored.steps[0].completedAt)
      assert.equal(restored.steps[1].completedAt, null)
      assert.equal(restored.constraints[0], '不做独立交付')
      const context = renderFlowContext(f.workspace, 'resumed', restored, await reopened.binding('resumed'))
      assert(context.includes('"currentStep":2') && context.includes(task.goal))
      await assert.rejects(reopened.finish(task.id, '提前结束', {}, 'resumed'), /未完成步骤/)
      await reopened.observe('child', 'SubagentStart', 'resumed')
      await assert.rejects(reopened.checkpoint(task.id, { completeStep: 2, done: ['子任务不能结束主阶段'] }, 'child'), /不是任务主控/)
      await reopened.checkpoint(task.id, { completeStep: 2, done: ['验证完成'] }, 'resumed')
      await verifyTask(reopened, task.id, 'resumed')
      await reopened.checkpoint(task.id, { step: ['真实回补'] }, 'resumed')
      await reopened.checkpoint(task.id, { completeStep: 3, done: ['真实回补回执已核对'] }, 'resumed')
      await assert.rejects(reopened.finish(task.id, '旧验收', await workspaceSnapshot(f.workspace), 'resumed'), /尚未通过/)
      await verifyTask(reopened, task.id, 'resumed')
      const completed = await reopened.finish(task.id, '原目标全部完成', await workspaceSnapshot(f.workspace), 'resumed')
      assert.equal(completed.phase, 'completed')
      const completedContext = renderFlowContext(f.workspace, 'resumed', completed, await reopened.binding('resumed'))
      assert(completedContext.includes('任务已完成') && completedContext.includes('jth flow legacy'))
      assert(!completedContext.includes(task.goal) && !completedContext.includes('不做独立交付'))
      assert(!completedContext.includes('checkpoint') && !completedContext.includes('长期记忆'))
    } finally { await reopened.close() }
  } finally { await f.cleanup() }
})

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
    const active = await f.store.focus(task.id, { action: '核对验收结果', acceptance: [1], readScope: ['src'], expected: '实际测试日志' }, 'main')
    assert.equal(active.verification, null)
    await f.store.checkpoint(task.id, { workId: active.work!.id, outcome: 'progress', done: ['核对已生成日志'], evidence: [first.results[0].log], next: '重新验收' }, 'main')
    await assert.rejects(f.store.finish(task.id, '复用旧验收', await workspaceSnapshot(f.workspace), 'main'), /尚未通过/)
    await verifyTask(f.store, task.id, 'main')
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
