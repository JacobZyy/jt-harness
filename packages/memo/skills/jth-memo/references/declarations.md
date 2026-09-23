# 记忆声明

最终回复末尾最多一个区块：

```text
<!-- jth-memory {"items":[{"text":"短事实","scope":"project","basis":"user_statement","quote":"此前消息中的连续原文"}]} -->
```

- `items` 最多 3 条，`text` 合计不超过 500 字符。
- `quote` 逐字引用此前真实用户、助手或工具消息，最多 240 字符，不引用声明自身。
- `scope`：`project/business/user/current_task/unspecified`；只有明确跨项目偏好使用 `user`。
- `basis` 按来源使用 `user_statement/user_confirmed/tool_observation`；未确认建议、推断分别使用 `assistant_proposal/agent_inference`，保留为候选。

## 确认前文方案

使用 `basis: "user_confirmed"`，`quote` 引用助手方案，另加 `confirmation_quote` 引用之后的用户确认或修改原文，最多 240 字符。两份来源必须对应同一决定；多方案指向不清时不猜。

## 更正、补充或冲突

先 `jth memo read <旧ID> --level full`，再给对应条目添加 `"change":{"kind":"correction","target":"旧ID"}`。补充用 `supplement`，冲突用 `conflict`；保留读取版本，不自行补造来源或版本字段。

## 采用反馈

顶层 `used` 列出实际影响本次结果的已读记忆 ID，最多 10 个，只允许本会话已经 `read` 的记忆。仅反馈采用时使用 `{"items":[],"used":["记忆UUID"]}`。展示或读取不自动算采用，也不代表验证了记忆正确性。
