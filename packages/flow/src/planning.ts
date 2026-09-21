import { z } from 'zod'
import type { PolicyDecision, PolicyRequest } from './policy.ts'

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

const templateFocus: Record<PolicyRequest['intent'], readonly string[]> = {
  noop: [], question: [],
  implement: ['确认可观察的行为', '按独立交付结果划分任务', '复用受影响的现有检查'],
  debug: ['收集失败证据和可验证假设', '定位并修复根因', '验证原失败场景'],
  design: ['明确决定与未决问题', '核对边界和真实依赖', '给出可实施、可验证的方案'],
  verify: ['明确待验证主张', '运行相关检查', '报告结果与未覆盖项'],
  ops: ['确认数据和配置影响范围', '在需要时保留恢复依据', '核验目标状态与数据完整性'],
}

/** A planning rubric, not a fixed task list. The agent produces the actual work items. */
export function planningTemplate(decision: PolicyDecision) {
  if (decision.disposition !== 'planned') return null
  return {
    focus: templateFocus[decision.intent],
    taskFields: ['id', 'outcome', 'dependsOn', 'doneWhen', 'verifyWith'],
    guidance: '按可独立验收的结果拆分；准备、配置、文档和测试动作并入相关任务。可增删合并，不固定任务数量。',
    verification: '沿用项目现有检查和主 Agent 收口复核；复用有效证据，仅在改动、失败或未决问题影响结果时补验。不增加模型评审。',
  }
}
