import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluatePolicy, policyModeSchema, policyRequestSchema } from './policy.ts'
import { planDraftSchema, planningTemplate } from './planning.ts'

const decide = (request: unknown, mode: 'adaptive' | 'strict' = 'adaptive') => evaluatePolicy(policyRequestSchema.parse(request), mode)

test('policy distinguishes ordinary questions, bounded work, dependencies, and strict planning without a model', () => {
  for (const mode of ['adaptive', 'strict'] as const) {
    for (const intent of ['noop', 'question']) {
      const decision = decide({ intent, activePlan: true }, mode)
      assert.equal(decision.planAction, 'none')
      assert.equal(decision.verification, 'none')
      assert.equal(planningTemplate(decision), null)
    }
  }
  assert.equal(decide({ intent: 'implement' }).disposition, 'guarded')
  assert.equal(decide({ intent: 'implement' }, 'strict').disposition, 'planned')
  for (const reason of ['dependent-work', 'significant-impact', 'uncertain-approach', 'requested']) {
    const decision = decide({ intent: 'ops', planningReasons: [reason] })
    assert.equal(decision.disposition, 'planned')
    assert.equal(decision.planAction, 'create')
    const template = planningTemplate(decision)!
    assert(template.taskFields.includes('doneWhen'))
    assert(!Object.hasOwn(template, 'tasks'), 'Templates must not create a fixed hidden task list')
  }
  assert.throws(() => policyRequestSchema.parse({ intent: 'unknown' }))
  assert.throws(() => policyModeSchema.parse('strcit'), 'Do not silently turn a typo into adaptive')
})

test('approval, amendment and continuation preserve the referenced goal, even without an active plan', () => {
  for (const relationship of ['approve', 'amend', 'continue']) {
    const request = { intent: 'implement', relationship, planningReasons: ['dependent-work'] }
    assert.equal(decide(request).planAction, 'recover-context')
    assert.equal(decide({ ...request, contextAvailable: true, activePlan: true }).planAction, 'reuse')
    assert.equal(decide({ ...request, contextAvailable: true, activePlan: false }).planAction, 'create')
  }
  assert.equal(decide({ intent: 'implement', relationship: 'approve', contextAvailable: true }).disposition, 'guarded')
  assert.equal(decide({ intent: 'ops', relationship: 'new', activePlan: true, planningReasons: ['requested'] }).planAction, 'create')
})

test('plan drafts contain outcomes and acceptance, reject broken dependency graphs, and hold no progress', () => {
  const task = { id: 'T1', outcome: '用户配置独立可用', doneWhen: '源码配置移除后仍能读取', verifyWith: '运行配置回归' }
  const plan = planDraftSchema.parse({ goal: '配置迁移', tasks: [task, { ...task, id: 'T2', dependsOn: ['T1'] }] })
  assert.deepEqual(plan.tasks[0].dependsOn, [])
  assert(!Object.hasOwn(plan.tasks[0], 'status'))
  assert.throws(() => planDraftSchema.parse({ goal: '迁移', tasks: [task, task] }), /任务 ID 重复/)
  assert.throws(() => planDraftSchema.parse({ goal: '迁移', tasks: [{ ...task, dependsOn: ['unknown'] }] }), /依赖不存在/)
  assert.throws(() => planDraftSchema.parse({ goal: '迁移', tasks: [{ ...task, dependsOn: ['T1'] }] }), /存在环/)
  assert.throws(() => planDraftSchema.parse({ goal: '迁移', tasks: [task, { ...task, id: 'T2', verifyWith: '' }] }))
})
