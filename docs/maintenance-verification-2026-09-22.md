# Hook 接入与历史知识治理验证

日期：2026-09-22。范围为用户确认的 Hook 生效修复、文档一致性和过期记忆治理。真实业务需求闭环验证等待用户提供需求；记忆增强与 Jev 接入留待单独讨论。

## Hook 与运行修复

- 当前项目的五个 JTH Hook 已同步并重新信任；实际触发仍受 Codex 会话加载时机影响，已有会话需重新加载。
- 修复共享会话解析器遗漏原生 `WebSearch` 的问题。搜索的 query/action 作为工具证据保留，不冒充网页正文，也不阻断后续用户消息和记忆声明。
- 只读解析此前失败的真实来源快照：1,515 行、227 条消息、15 条搜索记录全部通过；没有补写该历史声明、调用模型或重跑旧队列。
- 修复包管理器删除旧安装目录后，项目 `upgrade` 因无法读取旧 manifest 而失败的问题。仅在本项目存在匹配旧路径的 JTH Hook 时恢复安装；无法确认归属时保留原链接并报错。
- `doctor` 增加 Skill 可用性检查，避免旧 Hook 仍受信任、实际安装却已不存在时显示正常。

修补版本通过本地独立包安装到本机，未发布 npm，也未推送远端。默认原生 Flow、Memo 来源与版本规则、项目范围和其他工具 Hook 保持原有职责。

## 文档与记忆

新增[文档导航](README.md)，统一用户配置、独立分发、原生 Flow 和声明模式说明；历史设计与验收报告保留原证据并标明适用时间，已实现的接入、拆步、反馈和读取节点不再列为待办。

从 `jt-harness` 项目范围逐条核对并可恢复归档 106 条旧默认行为描述，覆盖旧 Flow 状态库与命令、DSH 默认提炼及已迁移配置。全部通过现有 `memo read/archive` 完成，随后逐条回读；106 条正文哈希、来源消息 ID 和向量均保持不变，已处理条目的默认可见数量为 0。没有按日期或相似度自动清理，也没有删除数据库、来源或队列。

归档及恢复使用追加动作日志，`memo read <ID>` 可查看原因，`memo search ... --archived` 可查历史，`memo restore <ID> --reason ...` 可撤销归档。逐条回执和前后比对保存在本机忽略目录 `artifacts/maintenance/`，不提交运行数据。

## 验证证据与边界

| 检查 | 结果 |
| --- | --- |
| `node scripts/typecheck.mjs` | 通过 |
| `JTH_NATIVE_CONFIG_TEST=1 node --test packages/cli/src/delivery.test.ts packages/cli/src/native-flow.test.ts packages/codex-hooks/src/declarations.test.ts packages/codex-hooks/src/runtime.test.ts packages/codex-hooks/src/dsh-ingest.test.ts` | 29 项通过，无跳过；包含真实 Codex 配置解析及旧安装消失后的升级回归 |
| `node scripts/verify-monitor.ts` | 原生 Codex Hook、后台导出及 Phoenix 持久化通过；本地 Responses 模拟响应，付费模型调用为 0 |
| 真实失败来源快照解析 | 通过；只读，没有自动重投历史声明 |
| `jth memo doctor` | 0 个错误；保留 8 条来源时间缺失和 22 个历史 partial 任务两类警告 |
| 归档回读与向量比较 | 106 条通过，历史数据保留 |

Memo 的历史引文不匹配诊断仍保留，程序不会为其编造来源或自动补写。上述结果证明接入与相关实现行为，不代替尚未安排的真实业务长任务验收。本文的数量和本机状态是当日快照；后续以实际诊断和检查结果为准。
