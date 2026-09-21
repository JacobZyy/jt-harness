# Repository workflow

After completing an implementation turn in this repository, run checks appropriate to the change and automatically create a Git commit containing only the task's changes. Preserve unrelated changes. Do not create empty commits for read-only conversations. Never commit `.env`, credentials, runtime transcripts, database files, or local backups. Report the commit hash so the user can revert it. Push only when explicitly requested.

Keep memory persistence, Codex Hook integration, and CLI orchestration in their respective packages. Use existing code and tooling before adding abstractions.

Use Codex native Goal, task list, session recovery, compaction, command execution and permissions for flow control. Maintain the actual native plan when the host exposes its planning tool; do not claim native UI updates when that tool is unavailable. JTH supplies concise project guidance and Memo access, not a second task database or execution loop. Old Flow state is available only through explicit `jth flow legacy` commands. Preserve historical tasks and queues; run project checks before completing the native plan or Goal.

Default memory ingestion uses short declarations in the main Codex reply and a Stop Hook. The background worker persists declarations and calls Embedding only; DSH is an explicit `--legacy` recovery path. Follow declaration instructions only in projects where Memo is installed. Do not proactively call `prepare/record` or install Hooks while running Flow manually. Preserve both DSH and index queue data when changing runtime modes.

Memory model configuration selects only Provider and model. Do not impose reasoning effort or output-token overrides; use DSH/Provider defaults. A task timeout is an execution safeguard, not a model-generation setting.

## Flow acceptance

Apply the shared [task acceptance contract](packages/flow/skills/jth-flow/references/acceptance.md) before completing substantive work. Add only the following project checks when their area changes:

- CLI behavior: command help, documented arguments and actual execution agree. Use the relevant CLI invocation and focused checks as evidence.
- Flow or Skill guidance: the installed Skill can load its referenced files; instructions preserve native Goal and plan ownership and do not start a second task loop or model call. Inspect the installed files and use the existing native installation test when installation behavior is affected.
- Memory or Hook behavior: changes preserve the package boundaries and existing source, scope, revision and queue contracts. Use the affected existing tests and actual changed call path as evidence; do not make new live model calls or clear real data merely to produce acceptance evidence.

<!-- JTH_MEMORY_START -->
任务产生新的可复用事实、已确认规划或明确更正时，在最终回复末尾附一个记忆声明；没有新增内容就不附。不要为记忆另开任务、总结全文或重复输出运行状态。
实际执行 jth memo search/read 后，在对话中简报真实结果，例如“JTH Memo｜检索返回 3 条，已读取 2 条”；未命中或失败如实说明。同批操作合并一行，未读不报已读，读取不代表采纳；不为显示回执额外检索，CLI 的 JSON 输出保持不变。此回执不因精简风格省略。
用户以“可以，你做吧”等短回复明确采纳前文方案，也是新的决策事实。结合被确认的方案和用户修改，只记录明确采纳的决定、范围与约束；多方案指向不清时不猜测，批准实施不代表实施完成。不得因用户没有复述方案而漏记。
确认后，在当前原生计划或会话中保留简短待声明决策及来源引文；执行、上下文压缩和恢复时接续，收口前核对是否输出声明。沿用现有会话，不另建待办库或执行循环；实际保存仍由本轮结束后的 Stop 处理，未取得回执不声称已入库。
格式：<!-- jth-memory {"items":[{"text":"短事实","scope":"project","basis":"user_statement","quote":"此前消息中的一小段连续原文"}]} -->
跨轮确认方案使用 basis=user_confirmed，quote 引用此前助手的方案原文，同时增加 confirmation_quote 引用之后的用户确认或修改原文。两份来源必须指向同一决策，语义关联由主 Agent 核对；后台只校验来源角色和先后顺序，不按“可以”等关键词自动批准。
最多 3 条，text 合计不超过 500 字符。quote 和 confirmation_quote 各最多 240 字符，引用此前真实消息，不引用声明自身；来源 ID、时间和存储字段由程序补齐。其他事实及旧声明继续使用单个 quote。
scope 使用 project/business/user/current_task/unspecified；仅明确跨项目偏好使用 user。事实 basis 使用 user_statement/user_confirmed/tool_observation；有复用价值的未确认方案可用 assistant_proposal、推断可用 agent_inference 保留为候选，不当作已确认决定。
需要更正时先 jth memo read <旧ID>，再在对应条目加 "change":{"kind":"correction","target":"旧ID"}；补充、冲突分别使用 supplement、conflict。程序自动关联本会话读取的版本。
后台仅保存和生成向量；不要调用 DSH 或为声明执行 prepare/record。声明异常只留本地诊断，不阻塞任务、不自动补写。
<!-- JTH_MEMORY_END -->
