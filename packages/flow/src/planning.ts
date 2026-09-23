import { z } from 'zod'
import type { PolicyDecision } from './policy.ts'

const text = z.string().trim().min(1).max(2000)
export const workItemIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, '任务 ID 使用稳定标签，例如 T1')
export const workItemSchema = z.strictObject({
  id: workItemIdSchema,
  outcome: text,
  dependsOn: z.array(workItemIdSchema).max(50).default([]),
  doneWhen: text,
  verifyWith: text,
})
export const planDraftSchema = z.strictObject({
  goal: text,
  tasks: z.array(workItemSchema).min(1).max(50),
}).superRefine((plan, context) => {
  const tasks = new Map(plan.tasks.map(task => [task.id, task]))
  if (tasks.size !== plan.tasks.length) {
    context.addIssue({ code: 'custom', message: '任务 ID 重复' }); return
  }
  for (const task of plan.tasks) for (const dependency of task.dependsOn) {
    if (!tasks.has(dependency)) context.addIssue({ code: 'custom', message: `${task.id} 依赖不存在的任务 ${dependency}` })
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    if (tasks.get(id)?.dependsOn.some(hasCycle)) return true
    visiting.delete(id); visited.add(id)
    return false
  }
  if (plan.tasks.some(task => hasCycle(task.id))) context.addIssue({ code: 'custom', message: '任务依赖存在环' })
})
export type PlanDraft = z.infer<typeof planDraftSchema>

/** A planning rubric, not a fixed task list. The agent produces the actual work items. */
export function planningTemplate(decision: PolicyDecision) {
  if (decision.disposition !== 'planned') return null
  return {
    taskFields: ['id', 'outcome', 'dependsOn', 'doneWhen', 'verifyWith'],
    guidance: '先列用户要求的可交付结果；每个 outcome 写明哪部分目标成为事实，且可独立验收。不要把理解、调研、设计、编码、测试、回归、收口验收列为顶层项，除非该项本身就是用户要求的交付物；这些动作放入相关项的 doneWhen/verifyWith。未知根因先产出可验证诊断，获得证据后细化对应项。只写真实依赖。可增删合并，不固定任务数量。',
    verification: '每项 verifyWith 给出自身证据；全部交付后主 Agent 复核整体需求。复核属于收口动作，不单列任务，除非用户明确要求验收报告。',
  }
}
