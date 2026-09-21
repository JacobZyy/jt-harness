import { z } from 'zod'
import { workItemIdSchema, type PlanDraft, type PolicyDecision } from '@jt-harness/flow'

export const codexProgressSchema = z.array(z.strictObject({
  id: workItemIdSchema,
  status: z.enum(['pending', 'in_progress', 'completed']),
  evidence: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
})).max(50)
export type CodexProgress = z.infer<typeof codexProgressSchema>
export interface CodexContext {
  role: 'primary' | 'delegate'
  planTool: 'available' | 'unavailable' | 'unknown'
}
export interface CodexRecording {
  host: 'codex'
  applied: false
  kind: 'handoff' | 'context-required' | 'none' | 'draft-required' | 'conversation' | 'tool-request'
  instruction: string
  toolCall?: { name: 'update_plan', arguments: { explanation: string, plan: { step: string, status: 'pending' | 'in_progress' | 'completed' }[] } }
}

/** Prepare a host tool request only. The current Codex agent must invoke the actual native tool. */
export function prepareCodexPlan(decision: PolicyDecision, context: CodexContext, draft?: PlanDraft, progress: CodexProgress = []): CodexRecording {
  const base = { host: 'codex', applied: false } as const
  if (context.role === 'delegate') return {
    ...base, kind: 'handoff', instruction: '向主 Agent 返回分派任务 ID、结果、证据、阻塞与下一步；不更新主计划，不宣告主任务完成。',
  }
  if (decision.planAction === 'recover-context') return {
    ...base, kind: 'context-required', instruction: '先从当前会话或明确引用恢复被确认/续接的目标；不猜测，不新建替代任务。',
  }
  if (decision.planAction === 'none') return {
    ...base, kind: 'none', instruction: decision.disposition === 'guarded'
      ? '直接完成有界任务，运行相关现有检查；不创建计划，也不清空已有计划。'
      : '直接回应；不创建、清空或完成已有计划。',
  }
  if (context.planTool !== 'available') return {
    ...base, kind: 'conversation', instruction: '原生计划工具未确认可用；在当前会话保留步骤与证据，不宣称已更新原生列表。',
  }
  if (!draft) return {
    ...base, kind: 'draft-required', instruction: '主 Agent 按模板形成完整工作项；接续时保留现有 ID 和进度，再准备 update_plan 参数。',
  }
  const states = new Map(progress.map(item => [item.id, item]))
  const taskIds = new Set(draft.tasks.map(task => task.id))
  if (states.size !== progress.length || progress.some(item => !taskIds.has(item.id))) throw new Error('进度含重复或未知任务 ID')
  if (decision.planAction === 'reuse' && draft.tasks.some(task => !states.has(task.id))) throw new Error('接续计划必须显式提供所有任务的当前状态，不能重置已有进度')
  if (progress.filter(item => item.status === 'in_progress').length > 1) throw new Error('Codex 原生计划最多一个进行中任务')
  for (const task of draft.tasks) {
    const state = states.get(task.id)
    if (state?.status === 'completed' && !state.evidence.length) throw new Error(`${task.id} 完成状态缺少实际验证依据`)
    if (state && state.status !== 'pending' && task.dependsOn.some(id => states.get(id)?.status !== 'completed')) throw new Error(`${task.id} 的前置任务尚未完成`)
  }
  return {
    ...base, kind: 'tool-request',
    instruction: '这是待调用参数，不是执行回执。主 Agent 核对证据后调用实际 update_plan；只有工具成功才报告原生列表已更新。',
    toolCall: {
      name: 'update_plan',
      arguments: {
        explanation: draft.goal,
        plan: draft.tasks.map(task => ({ step: `${task.id} ${task.outcome}`, status: states.get(task.id)?.status ?? 'pending' })),
      },
    },
  }
}
