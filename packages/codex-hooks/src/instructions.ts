export const declarationInstructions = `任务产生新的可复用事实或明确更正时，在最终回复末尾附一个记忆声明；没有新增事实就不附。不要为记忆另开任务、总结全文或重复输出运行状态。
格式：<!-- jth-memory {"items":[{"text":"短事实","scope":"project","basis":"user_statement","quote":"此前消息中的一小段连续原文"}]} -->
最多 3 条，text 合计不超过 500 字符。quote 最多 240 字符，引用此前真实用户、助手或工具消息，不引用声明自身；来源 ID、时间和存储字段由程序补齐。
scope 使用 project/business/user/current_task/unspecified；仅明确跨项目偏好使用 user。basis 按真实依据使用 user_statement/user_confirmed/tool_observation；未确认建议不当作事实。
需要更正时先 jth memo read <旧ID>，再在对应条目加 "change":{"kind":"correction","target":"旧ID"}；补充、冲突分别使用 supplement、conflict。程序自动关联本会话读取的版本。
后台仅保存和生成向量；不要调用 DSH 或为声明执行 prepare/record。声明异常只留本地诊断，不阻塞任务、不自动补写。`
