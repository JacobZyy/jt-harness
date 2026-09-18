# 流程原型验证记录

日期：2026-09-18。环境：macOS、Node 24.21.0、Codex 0.153.0、PostgreSQL 18.6 + pgvector 0.8.6。

## 已取得的证据

| 项目 | 结果 |
| --- | --- |
| 构建、TypeScript 类型检查 | `pnpm build`、`pnpm typecheck` 通过 |
| 离线回归 | `pnpm test`：30 通过，4 个需显式开启的集成/模型测试跳过 |
| PostgreSQL 回归 | `node scripts/test-postgres.mjs`：21 通过；使用隔离临时库，未修改真实记忆 |
| 新增流程场景 | 7 个行为测试，覆盖状态恢复、子会话、范围、检查、Hook 安装与真实 CLI |
| Skill 文件 | 官方 `quick_validate.py` 校验通过 |
| 真实 Embedding + Memo 搜索 | 复用本机 `.env`，684 ms 返回 5 条记忆，包含 observed/asserted/verified 状态；未调用新的提炼模型 |
| Hook CLI 开销 | 同一缓存任务连续 5 次：65、60、58、60、59 ms；注入内容 3764 字节。含 Node 启动，不含模型处理时间 |

首次真实召回失败原因是本机 PostgreSQL 未启动，报 `connect ENOENT .../.s.PGSQL.5432`。任务状态照常可用，召回错误可见；启动既有数据库后重试成功。没有更换连接、密钥、Provider 或模型，也没有删除队列或记忆。

## 防偏移用例

1. 创建“解决长任务目标偏移和失忆，讨论一套流程控制方案”。随后只补充“轻量、主流程控制、验证交给测试用例”。重新打开 SQLite 后，原目标和 discussion 阶段仍在，约束追加，候选没有变成实施决定。
2. 未记录依据不能把阶段改成 execution；明确改目标保留 initialGoal 和变更事件。
3. 新会话不继承无关任务；子会话只能观察；新主控必须显式接管，旧主控不能再修改任务。暂停解除绑定，原任务可恢复，不会伪报完成。
4. Stop、Interrupt、SessionEnd 不改变任务完成状态。
5. 验收失败、超时、重新验收被中断、新增约束、验证后改文件、未决问题或范围外改动，均不能使用旧结果完成任务。Git 提交不改变文件内容，不导致误失效。
6. 召回重复请求只保留一个有效租约；目标改变后旧结果不能覆盖新上下文。冲突标签保留，数据库离线不改变原目标。
7. 安装和卸载幂等，保留原有 Memo 与第三方 Hook；真实 CLI 能在召回离线时完成“创建、检查点、实际执行检查、完成、卸载保留状态”的闭环。

这些检查验证程序行为与真实 API 链路，不等于已经证明所有模型在长对话里都不会偏题。没有重新开启已收口的 DSH 模型评估，也没有引入第二套审查 Agent。原有 Memo 写入采用已有捕获与 DSH 链路，本次验证了共存及存储回归，未人工向真实记忆库灌入测试事实。

## 使用时观察

恢复 Codex 会话后，`jth flow status` 的 `sessions[].lastEvent` 和时间可用于判断本会话是否收到 Hook。`flow context` 查看将被注入的任务状态；`status --history` 查看状态变化；`recall` 主动刷新相关记忆。命令行重放证明 handler 和协议契约可用，自动事件是否发生应以该会话后续记录为准。

源测试位于 `packages/flow/src/flow.test.ts` 和 `packages/codex-hooks/src/flow.test.ts`。未脱敏的运行状态、原始 API 结果与测试产物均留在忽略目录，不进入 Git。
