import { z } from 'zod'
import type { PlanDraft, PolicyDecision } from '@jacob-z/jt-harness/flow'
import type { CodexContext } from './plan-adapters/codex.ts'

export const codexGoalSchema = z.strictObject({
  authorization: z.enum(['user', 'instruction', 'none']).default('none'),
  current: z.enum(['unknown', 'none', 'same', 'other', 'complete']).default('unknown'),
  objective: z.string().trim().min(1).max(2000).optional(),
  tokenBudget: z.number().int().positive().optional(),
})

interface GoalRecording {
  host: 'codex'
  applied: false
  kind: 'none' | 'handoff' | 'context-required' | 'unavailable' | 'authorization-required' | 'objective-required' | 'reuse' | 'tool-request'
  instruction: string
  toolCall?: { name: 'get_goal', arguments: Record<string, never> }
    | { name: 'create_goal', arguments: { objective: string, token_budget?: number } }
}

/** Only prepare requests. Goal state, continuation and completion remain owned by Codex. */
export function prepareCodexGoal(
  decision: PolicyDecision,
  context: { role: CodexContext['role'], goalTools: CodexContext['planTool'] },
  goal: z.infer<typeof codexGoalSchema>,
  draft?: PlanDraft,
): GoalRecording {
  const base = { host: 'codex', applied: false } as const
  if (context.role === 'delegate') return {
    ...base, kind: 'handoff', instruction: '向主 Agent 交回结果；不创建、替换或结束主 Goal。',
  }
  if (decision.planAction === 'recover-context') return {
    ...base, kind: 'context-required', instruction: '先恢复被确认或续接的目标，不创建替代 Goal。',
  }
  if (decision.disposition === 'direct' || decision.disposition === 'noop' || (decision.disposition === 'guarded' && goal.authorization !== 'user')) return {
    ...base, kind: 'none', instruction: '本轮不创建或结束 Goal；普通问答和有界小改不自动启用 Goal。',
  }
  if (goal.current === 'other') return {
    ...base, kind: 'context-required', instruction: '先恢复目标关系；不得覆盖其他未完成 Goal，也不能为切换目标虚报完成。',
  }
  if (goal.current === 'same') return {
    ...base, kind: 'reuse', instruction: '沿用已读取的同一 Goal，不重复创建；暂停、阻塞或额度限制的恢复遵守宿主规则，不擅自续跑。',
  }
  if (context.goalTools !== 'available') return {
    ...base, kind: 'unavailable', instruction: '原生 Goal 工具未确认可用；继续可执行工作并明确未启用 Goal。update_plan 成功不代表 Goal 已启动。',
  }
  if (goal.current === 'unknown') return {
    ...base, kind: 'tool-request', instruction: '先实际调用 get_goal，再按返回值声明 current；不能把未知状态当作没有 Goal。',
    toolCall: { name: 'get_goal', arguments: {} },
  }
  if (goal.authorization === 'none') return {
    ...base, kind: 'authorization-required', instruction: '创建 Goal 需要用户或系统/开发者明确指令；planned 分类、Skill 文件或计划标题本身不代表授权。',
  }
  const objective = goal.objective ?? draft?.goal
  if (!objective) return {
    ...base, kind: 'objective-required', instruction: '提供用户要求的总目标 goal.objective 或 plan.goal；不得用当前步骤替代总目标。',
  }
  return {
    ...base, kind: 'tool-request', instruction: '主 Agent 实际调用 create_goal 后核对 get_goal 回执；参数准备不代表已启用。仅用户明确指定预算时传 token_budget。',
    toolCall: { name: 'create_goal', arguments: { objective, ...(goal.tokenBudget === undefined ? {} : { token_budget: goal.tokenBudget }) } },
  }
}
