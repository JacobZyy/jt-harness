# Union Alpha 记忆队列故障分析

> 历史验证：本文记录 2026-09-17 的旧 DSH 队列故障，不代表当前默认模式或实时队列状态。现行操作见[文档导航](README.md)。

日期：2026-09-17，Asia/Shanghai。

## 结论

没有证据表明 DSH 进程或 PostgreSQL 队列卡死。已确认的两个问题是：OpenRouter 调用链出现高延迟、断流和通用错误；jt-harness 原先的 180 秒总超时又中止了仍在生成的请求。

具体网络错误发生在本地代理、OpenRouter 网关还是最终模型服务，仅凭现有的 `ERROR` 和 `terminated` 无法完全区分，不将通用 `PI_AI_ERROR` 直接认定为 DSH 自身缺陷。

## 证据

本会话第一轮自动投递的 7 批均被 worker 实际执行：4 批被总超时终止，3 批返回 `PI_AI_ERROR`。失败覆盖约 5–164 KB 的材料，并非只有大批次失败。

- 三个超时会话分别在约 143.2、142.4、158.1 秒才开始输出，到约 180 秒时仍在生成。DSH 已保存部分输出，最终结束原因为调用方关闭产生的 `aborted/disposed`。这些请求是被 jt-harness 的总时间预算中止。
- 另一个超时会话中，DSH 已对 `terminated` 和 `Connection error.` 做过内部传输重试，随后才被外层总超时终止。队列的 `attempts=1` 不代表上游只收到过一次 HTTP 请求。
- 另三批在约 48.6、45.6、32.1 秒返回 `ERROR / PI_AI_ERROR`，未产生有效提炼结果。
- 绕过 DSH，直接调用 OpenRouter，只要求回复 `OK`、输出上限 32 tokens，也用了 52.6 秒才出现首个 SSE 数据事件，最后正常完成。这说明明显延迟并非只能由 DSH 引入；这项对照不能单独定位网络链路的具体故障节点。
- 实际 DSH request header 中的模型为 `stealth/union-alpha`，`maxTokens=8192`，与任务执行配置一致。

证据文件位于 `artifacts/jth/union-diagnostics/`：`summary.json`、`session-events.json`、`direct-result.json`。诊断摘要不包含原始对话或模型分析正文。

## 已处理

1. 保留用户选择的 Union Alpha，将当前新任务的总超时调整为 600000 毫秒，写入 `.env` 和 Agent 运行配置。
2. 新增 `jth memo retry <id> --timeout-ms 600000`。已有任务的执行配置是接收时的快照，必须显式修改重试预算；仅改 `.env` 不会改变旧任务。
3. 重试只覆盖时间预算，保留原始材料哈希、模型与 provider、Embedding 空间以及已完成的提炼检查点。
4. Agent 运行错误携带实际 DSH session ID，方便从队列错误定位完整请求轨迹。
5. 保留失败后显式重试策略，没有添加无限重试或自动替换模型。

## 验证与恢复

TypeScript 检查、构建和相关离线测试通过。临时 PostgreSQL 的 15 个场景通过（Node 测试器连同父测试报告 16 通过），其中验证了非法预算不能修改任务，合法预算只改变 `execution.agent.timeoutMs`。

使用原先约 5.4 KB、180 秒超时的真实批次验证恢复。同一模型、同一材料改为 600 秒预算后，约 205 秒完成提炼和向量发布，生成 3 条记录。任务已为 `complete`，发布回执为 `273c977f-b071-4e1f-82a4-d88414cd20ea`，DSH session 为 `session-147b9640fb47463095714080d47d3454`。

剩余 6 个首轮失败批次已各显式重新入队一次，并使用 600 秒预算；恢复操作记录在 `recovery.json`。它们的后台执行不等于已经全部完成。增加预算解决了过早终止，不能保证上游断流或 `ERROR` 不再发生。

OpenRouter 官方说明，流式请求可以在 HTTP 200 之后通过 SSE 返回错误；错误原因应检查响应内的 code 和 metadata。当前适配链路只有简化文本的失败仍需保留不确定性：[Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging)。
