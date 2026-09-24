import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { evaluatePolicy, planDraftSchema, policyRequestSchema } from '@jt-harness/flow'
import { prepareCodexPlan } from './plan-adapters/codex.ts'
import { codexGoalSchema, prepareCodexGoal } from './codex-goal.ts'

const task = { id: 'T1', outcome: '完成配置迁移', doneWhen: '新配置可独立读取', verifyWith: '配置回归通过' }
const draft = planDraftSchema.parse({ goal: '配置独立与项目接入', tasks: [task, { ...task, id: 'T2', outcome: '当前仓库使用新配置', dependsOn: ['T1'] }] })
const decision = evaluatePolicy(policyRequestSchema.parse({ intent: 'ops', planningReasons: ['dependent-work'] }), 'adaptive')

test('Codex adapter prepares real tool arguments without executing, and handles delegation and missing tools separately', () => {
  const recording = prepareCodexPlan(decision, { role: 'primary', planTool: 'available' }, draft)
  assert.equal(recording.applied, false)
  assert.deepEqual(recording.toolCall, { name: 'update_plan', arguments: { explanation: draft.goal, plan: [
    { step: 'T1 完成配置迁移', status: 'pending' }, { step: 'T2 当前仓库使用新配置', status: 'pending' },
  ] } })
  for (const planTool of ['unknown', 'unavailable'] as const) {
    const fallback = prepareCodexPlan(decision, { role: 'primary', planTool }, draft)
    assert.equal(fallback.kind, 'conversation')
    assert(!fallback.toolCall)
  }
  const delegate = prepareCodexPlan(decision, { role: 'delegate', planTool: 'available' }, draft)
  assert.equal(delegate.kind, 'handoff')
  assert(!delegate.toolCall)
  const direct = prepareCodexPlan(evaluatePolicy(policyRequestSchema.parse({ intent: 'question' }), 'strict'), { role: 'primary', planTool: 'available' })
  assert.equal(direct.kind, 'none')
  assert(!direct.toolCall)
})

test('Codex completion preserves existing progress and rejects missing evidence or unfinished dependencies', () => {
  const resumed = evaluatePolicy(policyRequestSchema.parse({ intent: 'ops', relationship: 'amend', contextAvailable: true, activePlan: true }), 'adaptive')
  const context = { role: 'primary', planTool: 'available' } as const
  assert.throws(() => prepareCodexPlan(resumed, context, draft), /所有任务的当前状态/)
  assert.throws(() => prepareCodexPlan(decision, context, draft, [{ id: 'T1', status: 'completed', evidence: [] }]), /验证依据/)
  assert.throws(() => prepareCodexPlan(decision, context, draft, [{ id: 'T2', status: 'in_progress', evidence: [] }]), /前置任务/)
  const result = prepareCodexPlan(resumed, context, draft, [
    { id: 'T1', status: 'completed', evidence: ['配置回归通过'] }, { id: 'T2', status: 'in_progress', evidence: [] },
  ])
  assert.equal(result.toolCall?.arguments.plan[0].status, 'completed')
  assert.equal(result.toolCall?.arguments.plan[1].status, 'in_progress')
})

test('native Goal reads before creating, requires explicit authorization, and preserves unfinished goals', () => {
  const context = { role: 'primary', goalTools: 'available' } as const
  const prepare = (goal: unknown, policy = decision) => prepareCodexGoal(policy, context, codexGoalSchema.parse(goal), draft)
  const requested = { authorization: 'instruction' }
  assert.deepEqual(prepare(requested).toolCall, { name: 'get_goal', arguments: {} })
  const created = prepare({ ...requested, current: 'none' })
  assert.equal(created.applied, false)
  assert.deepEqual(created.toolCall, { name: 'create_goal', arguments: { objective: draft.goal } })
  assert.deepEqual(prepare({ ...requested, current: 'complete' }).toolCall, created.toolCall)
  assert.equal(prepare({ current: 'same' }).kind, 'reuse')
  assert.equal(prepare({ ...requested, current: 'other' }).kind, 'context-required')
  assert.equal(prepare({ current: 'none' }).kind, 'authorization-required')
  assert.deepEqual(prepare({ authorization: 'user', current: 'none', objective: '用户总目标', tokenBudget: 10000 }).toolCall,
    { name: 'create_goal', arguments: { objective: '用户总目标', token_budget: 10000 } })
  for (const tokenBudget of [0, -1, 1.5]) assert.throws(() => codexGoalSchema.parse({ tokenBudget }))
  assert.throws(() => codexGoalSchema.parse({ current: 'paused' }), 'Stopped goals must be classified as unfinished, never as absent')
  const known = codexGoalSchema.parse({ ...requested, current: 'none' })
  for (const goalTools of ['unknown', 'unavailable'] as const) {
    assert.equal(prepareCodexGoal(decision, { ...context, goalTools }, known, draft).kind, 'unavailable')
  }
  assert.equal(prepareCodexGoal(decision, { ...context, role: 'delegate' }, known, draft).kind, 'handoff')
  assert.equal(prepareCodexGoal(decision, context, known).kind, 'objective-required')
  for (const intent of ['question', 'noop'] as const) {
    assert.equal(prepare(known, evaluatePolicy(policyRequestSchema.parse({ intent }), 'strict')).kind, 'none')
  }
  const guarded = evaluatePolicy(policyRequestSchema.parse({ intent: 'implement' }), 'adaptive')
  assert.equal(prepare(known, guarded).kind, 'none', 'The planned entry instruction must not enable Goals for guarded work')
  assert.equal(prepare({ ...known, authorization: 'user' }, guarded).toolCall?.name, 'create_goal')
  const missing = evaluatePolicy(policyRequestSchema.parse({ intent: 'ops', relationship: 'continue' }), 'adaptive')
  assert.equal(prepare(known, missing).kind, 'context-required')
})

test('policy CLI stays offline, config overrides are explicit, and no task database is created', async () => {
  const fixture = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-workflow-policy-')))
  const root = resolve(import.meta.dirname, '../../..'), workspace = resolve(fixture, 'project'), user = resolve(fixture, 'user')
  const execute = promisify(execFile)
  const environment = { ...process.env, JTH_CONFIG_DIR: user, JTH_WORKFLOW_POLICY_MODE: undefined,
    JTH_DATABASE_URL: 'must-not-parse', EMBEDDING_BASE_URL: 'must-not-parse', JTH_DSH_BIN: '/must-not-run' }
  const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, ['--', resolve(root, 'bin/jth.mjs'), 'flow', ...args, '--workspace', workspace], { env: environment, timeout: 15000 })).stdout)
  try {
    await mkdir(workspace)
    const input = resolve(fixture, 'request.json')
    const request = { intent: 'ops', planningReasons: ['dependent-work'] }
    await writeFile(input, JSON.stringify({ request, plan: draft, goal: { authorization: 'instruction' } }))
    const initial = await cli('policy', input, '--plan-tool', 'available', '--goal-tools', 'available')
    assert.equal(initial.policy.source, 'default')
    assert.equal(initial.policy.mode, 'adaptive')
    assert.equal(initial.recording.toolCall.name, 'update_plan')
    assert.equal(initial.recording.applied, false)
    assert.deepEqual(initial.goal.toolCall, { name: 'get_goal', arguments: {} })
    await writeFile(input, JSON.stringify({ request, plan: draft, goal: { authorization: 'instruction', current: 'none' } }))
    const goalOnly = await cli('policy', input, '--plan-tool', 'unavailable', '--goal-tools', 'available')
    assert.equal(goalOnly.recording.kind, 'conversation')
    assert.deepEqual(goalOnly.goal.toolCall, { name: 'create_goal', arguments: { objective: draft.goal } })
    assert.equal(goalOnly.goal.applied, false)
    const planOnly = await cli('policy', input, '--plan-tool', 'available', '--goal-tools', 'unavailable')
    assert.equal(planOnly.recording.toolCall.name, 'update_plan')
    assert.equal(planOnly.goal.kind, 'unavailable')
    assert.equal((await cli('policy', input)).goal.kind, 'unavailable')
    await assert.rejects(cli('policy', input, '--goal-tools', 'yes'))
    await assert.rejects(cli('config', '--goal-tools', 'available'), /config 参数不支持/)
    assert.deepEqual(await readdir(workspace), [], 'Evaluation must not write task state or configuration')
    assert.equal((await cli('config', '--scope', 'user', '--mode', 'strict')).effective.source, 'user')
    assert.equal((await cli('policy', input)).policy.mode, 'strict')
    assert.equal((await cli('config', '--scope', 'project', '--mode', 'adaptive')).effective.source, 'project')
    assert.equal((await cli('policy', input, '--mode', 'strict')).policy.source, 'argument')
    assert.equal((await cli('policy', input, '--role', 'delegate')).recording.kind, 'handoff')
    assert.equal((await cli('config', '--mode', 'inherit')).effective.source, 'user')
    await assert.rejects(cli('policy', input, '--host', 'claude'), /尚无任务记录适配器/)
    await assert.rejects(cli('policy', input, '--mode', 'strcit'))
    const override = await execute(process.execPath, ['--', resolve(root, 'bin/jth.mjs'), 'flow', 'config', '--workspace', workspace],
      { env: { ...environment, JTH_WORKFLOW_POLICY_MODE: 'adaptive' } })
    assert.equal(JSON.parse(override.stdout).effective.source, 'environment')
    assert.deepEqual(await readdir(resolve(workspace, '.jth')), ['workflow.json'])
    assert.equal((JSON.parse(await readFile(input, 'utf8'))).plan.tasks[0].id, 'T1')
    await writeFile(resolve(user, 'workflow.json'), '{"mode":"strcit"}')
    await assert.rejects(cli('config'), /Workflow Policy 配置无效/)
    await writeFile(resolve(user, 'workflow.json'), 'null')
    await assert.rejects(cli('config'), /Workflow Policy 配置无效/)
    await writeFile(resolve(user, 'workflow.json'), '{invalid-json')
    await assert.rejects(cli('config'), /Workflow Policy 配置不是有效 JSON/)
    await writeFile(input, JSON.stringify({ request: { intent: 'question' }, plan: draft }))
    await assert.rejects(cli('policy', input, '--mode', 'adaptive'), /当前策略不需要计划/)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
