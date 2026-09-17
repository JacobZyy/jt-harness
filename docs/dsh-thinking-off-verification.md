> 历史记录：用户已改为只选择 Provider/model，撤销强制关闭思考；当前方案见 README 的交互切换说明。

# DSH 提炼配置同步

日期：2026-09-17。

Git 建仓和默认 DSH 恢复已分别提交为 `bcdbfa1`、`d054fe5`。本次只同步提炼配置，没有扩展分批或自动重试。

## 最终配置

- Provider / model：`deepseek-official / deepseek-v4-flash`。
- runtime 与本地 `.env` 明确设置 `reasoningEffort=off`，提取与关系比较共用此配置。
- 删除 runtime 的 `maxTokens=8192`、契约中的 `.default(8192)` 和本地 `.env` 的同名覆盖；保留正整数校验和显式覆盖能力。
- `timeoutMs=600000` 保持不变。

优先级：进程环境变量高于 `.env`，`.env` 高于 runtime。SDK 的 maxTokens 为可选字段；不传时 DSH 采用模型的 defaultMaxTokens。当前 DeepSeek adapter 使用模型级配置或 Provider 配置，默认 256000。实际此次 request/header 也记录为 256000，因此没有隐式退回 8192。

这不是无限输出。Provider、上下文容量和模型能力仍然有限；当前官方文档标示最高输出 384K，见 [DeepSeek 模型文档](https://api-docs.deepseek.com/quick_start/pricing)。本次采用现有 DSH Provider 默认值，没有在项目硬编码另一档数字。

## 一次受控验证

复用原先触顶任务 `codex-38eafbf666b8e6d260a01bf58cee841cb582996f6d2fc69257c46ffb78fcb7fc` 的原始 payload，仅运行提取，不经过生产入库或 Embedding。

新 DSH session：`session-d3bcbc4de205496f935f9a8075b3aac0`。

- 最终 request/header：官方模型、reasoningEffort=off、maxTokens=256000。
- 使用该最终配置调用当前 DeepSeek serializer：`thinking.type=disabled`，`max_tokens=256000`；即使默认 reasoningEffort=high，也由显式 off 覆盖。此为实际请求配置加同一序列化器的验证，不是 HTTP 抓包。
- 输入 88354 tokens，输出 3513 tokens；8582 字符正文，0 个 reasoning 内容块。
- 完整结束 `completed`，从 request/header 到 turn/end 为 14778 ms。
- JSON 和 agentExtractionSchema 校验通过：14 条 memories、2 条 proposals、1 条 revision。
- 来源校验未通过：第 9 条 memories 的 `memo codex capture`、`memo codex status` 未逐字出现在它引用的来源消息里。

本次没有再次输出触顶，但不能将“正常结束、JSON 完整”表述为“业务验证全部通过”。上述实体证据问题保持原校验拒绝，不扩大本次修改范围，也未自动再次请求。

完整结构化输出保存在忽略且权限受限的 `artifacts/jth/thinking-off/structured-result.json`；脱敏配置、usage、校验结果保存在 `artifacts/jth/thinking-off/verification.json`。没有把原始材料、reasoning 或密钥提交到 Git。

## 旧任务与检查

原失败任务的状态、attempts、content_hash、execution.agent 与验证前逐项相同。它的配置快照仍含 maxTokens=8192、未显式设置 reasoningEffort；更改 `.env` 不会覆盖已经入队的快照，直接 retry 仍使用原配置。本次没有改写或全量重跑任何旧任务，也没有生产数据库写入。

构建、类型检查、21 项常规测试通过。新增配置断言验证默认 off、输出上限省略、`.env` 与环境变量覆盖优先级。
