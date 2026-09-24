/** A stable entry reminder; classification and task state belong to the current agent and host. */
export function flowEntryContext() {
  return '实质任务按 jth-flow Skill 执行。主 Agent 的 planned 任务使用 Codex 原生 Goal：先 get_goal，无未完成目标时 create_goal；沿用已有目标，用户明确停用时不创建。'
}
