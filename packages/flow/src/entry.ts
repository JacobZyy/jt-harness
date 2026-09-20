/** A stable entry reminder; task state remains in the host conversation and native plan. */
export function flowEntryContext(skillPath: string) {
  return `JTH Flow：普通问答直接回答。实质任务先读取 ${JSON.stringify(skillPath)}（当前上下文已读则复用），按其中的任务与项目验收约定执行。
沿用当前目标与原生计划；开始或恢复时接续未完成项，补充反馈只调整相关步骤。Goal 和任务列表遵守宿主启用条件，不伪造不可用的工具。
主 Agent 核对实际产出、范围和测试证据后收口；子 Agent 只完成分派项并回传主 Agent，不另开主流程。`
}
