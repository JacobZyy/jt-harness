import type { Capture } from './capture.ts'

export function startInstructions(capture: Capture) {
  const sessionId = capture.event.agent_id ?? capture.event.session_id
  return `本项目已开启会话内记忆提交。仅在产生可复用且有证据的事实、用户确认的决定或明确更正时提交；普通聊天、临时队列状态和整段工具日志不记忆。
当前来源会话：${sessionId}。先运行 jth memo prepare --session ${sessionId} 获取真实消息 ID；需要测试/命令证据时加 --include-tools，预览不足用 jth memo evidence <evidence-id> --message <message-id> 查看原文。
用 jth memo record <json-file|-> 提交 {"evidence_id":"prepare返回的ID","extraction":{"schema_version":1,"memories":[{"content":"独立事实","scope":"project","source_message_ids":["真实ID"],"basis":"user_statement"}],"proposals":[],"revisions":[]},"changes":[]}。scope 可为 user/project/business/current_task/unspecified；memories 的 basis 仅 user_statement/user_confirmed/tool_observation，proposals 仅 assistant_proposal/agent_inference。来源 ID、角色、引文和用户确认顺序由程序校验，不能伪造原话或自行授予 verified。子 Agent 的委派和报告属于助手材料。
明确更正先 search/read 旧记忆，read 返回 version；changes 使用 previous_entry_id、expected_version、current_memory_index（memories 从0计）、revision_index:null、kind:correction、explanation、source_message_ids、evidence_quote、resolved_revision_conflict_ids:[]。不确定就保留候选，不猜测替代关系。
提交返回 accepted 只表示正文已保存；索引由后台完成。失败材料保留本地，用 memo work 恢复，不为记忆阻塞业务任务。没有新增结论就不调用 record。Hook 不会调用另一个模型替你总结；也不要把本说明或巡检状态重复写入记忆。`
}
