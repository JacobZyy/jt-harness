/** A stable entry reminder; classification and task state belong to the current agent and host. */
export function flowEntryContext(skillPath: string) {
  return `JTH Flow：普通问答直接回答。实质任务读取 ${JSON.stringify(skillPath)}（已读则复用），按 Workflow Policy 声明意图和任务关系；默认 adaptive，小改 guarded，多步 planned。
规划由主 Agent 按模板细化可验收工作项；进度由宿主记录。Codex 使用实际 update_plan；jth flow policy 只准备参数，未调用不报已更新。子 Agent 只交回分派结果。
guarded 简报当前交付；planned 建立/接续真实计划后简报“JTH Flow｜已进入/已恢复｜当前步骤”。实际 Memo 检索/读取后简报真实结果；必要回执和阶段反馈不省略。
确认或补充沿用对应目标和进度；上下文不明先恢复，不猜新任务。按项目现有检查和主 Agent 复核收口，不增加模型评审；Goal 遵守宿主启用条件。`
}
