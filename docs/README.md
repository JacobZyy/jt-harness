# JTH 文档导航

当前默认架构是独立 TypeScript CLI、Codex 原生流程能力、主会话记忆声明和 PostgreSQL + pgvector。配置、安装和执行行为以源码、CLI 帮助及下列操作说明为准。

## 当前操作说明

| 内容 | 入口 |
| --- | --- |
| 模块、命令、存储能力与边界 | [项目 README](../README.md) |
| 安装、版本更新、Hook 信任与 Phoenix | [本地交付与观测](local-delivery-monitoring.md) |
| 用户配置、项目覆盖、旧配置迁移 | [配置说明](configuration.md) |
| Goal、计划、恢复及项目验收 | [原生 Flow](flow-control.md)、[Workflow Policy](workflow-policy.md) |
| 声明、读取、更正与过期知识治理 | [主会话记忆声明](memory-declarations.md) |
| 主动线索、混合检索、证据分层和采用反馈 | [记忆读取](memory-retrieval.md) |
| 已实现能力和保留的后续事项 | [Rex 参考的状态对照](rex-memory-reference.md#已落地与保留的后续事项) |

Flow 不保存第二份任务进度；Memo 默认不调用 DSH。历史 Flow 只能通过 `jth flow legacy ...` 使用，历史 DSH 队列只在显式 `--legacy` 路径处理。

## 历史设计与验证

这些文档保留当时的设计、测试结果及限制。“当前”“默认”“下一步”和数量只对报告当时的版本有效，不是现行指令或任务清单。

- [2026-09-22 Hook 修复与历史知识治理](maintenance-verification-2026-09-22.md)。
- [旧记忆设计](memory-plugin-technical-design.md)、[更早的插件/Rust 草案](history/memory-plugin-v0.3.md)。
- [初版 CLI](jth-delivery-verification.md)、[v2 修订](memory-revisions-verification.md)、[v3 存储](memory-storage-v3-verification.md)。存储能力仍在，历史 DSH 调用链已退出默认入口。
- [六阶段 Hook](codex-hooks-verification.md)、[会话内手动写入](inline-memory-verification.md)、[DSH 恢复](dsh-restore-verification.md)、[关闭思考实验](dsh-thinking-off-verification.md)。
- [旧 Flow](flow-legacy.md)、[SQLite 原型](flow-verification.md)、[PG 迁移](postgres-runtime-verification.md)、[恢复与 Goal 实测](recovery-goal-verification.md)。
- [Agent 评测](memory-agent-evaluation-2026-09-16.md)、[输入优化](memory-input-optimization-verification.md)、[按条接收](memory-intake-verification.md)、[Union Alpha 故障](union-alpha-diagnostics.md)、[历史队列清理](queue-cleanup-2026-09-17.md)。

历史文件与来源保留，不因运行模式调整而删除。只有新变化影响原证据时才补跑相关检查；不能用历史测试通过替代当前配置生效或真实需求验收。
