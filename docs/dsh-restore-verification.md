# DSH 默认流程恢复

日期：2026-09-17。

## Git 检查点

私有仓库：`JacobZyy/jt-harness`。

`bcdbfa1` 保存恢复前的会话内记忆方案，以及三个 package 的布局。后续提交恢复默认 DSH 流程，可单独 revert 恢复提交。`.env`、运行记录、数据库、测试材料和备份均不提交。

项目 `AGENTS.md` 已要求完成实现并通过相应检查后自动提交本次改动；只读会话不生成空提交，不自动推送。

## 恢复范围

- 保留 `memo`、`codex-hooks`、`cli` 三个 package。
- `memo work` 默认消费 Hook 增量来源、运行 DSH 提取及关系比较、生成 Embedding 并发布。
- `memo send` 默认接受 DSH 任务，不再要求 `--legacy`。
- 六种 Hook 保持原安装命令，SessionStart 不再注入自动会话内提取说明。
- `memo record` 保留为显式手动命令，使用独立 index worker；`memo work --index` 恢复此类任务，不抢占 DSH 的 Hook 事件。
- 重试按任务类型路由。旧失败任务不自动重跑，历史记忆和向量没有清空，也未降级 schema v4。
- DSH 队列继续使用数据库内已有的 `kind=legacy` 标记；该名称不代表当前禁用。

## 验证

构建、全量类型检查通过。常规测试 21 通过；独立 PostgreSQL/pgvector 测试 21 通过。恢复了原采集器的六个回归用例，覆盖父子来源、重复投递、不确定回执、文件删除、UTF-8 分片和游标校验。CLI 回归直接使用不带 `--legacy` 的 `send`。

真实默认 `memo work` 验收使用隔离的合成 Hook 来源：

- 项目：`jth-dsh-restore-1789613012525`。
- 提交：`codex-c7d4f361805e7fd5fa6d935702dd5824bc78cbcbdd8e3428d8417d4e692dbf00`。
- DSH：`deepseek-official / deepseek-v4-flash`。
- DSH session：`session-10c10ac097ed4e6994ca0d2ce051075b`。
- 索引回执：`363ce84d-98cd-4922-bcbe-5109aded90ee`。
- 结果：1 条记忆，真实 DSH 与 Embedding 完成，总计 4,154 ms；测试条目已归档。

该测试证明默认路径已恢复，不代表六类原生事件都已重新触发，也不是长会话输出上限的负载测试。当前 Agent 有效配置仍为 `maxTokens=8192`、`timeoutMs=600000`，本次没有修改模型参数或 DSH 全局配置。需要调整提取上限时使用项目的 `JTH_DSH_MAX_TOKENS`；它会覆盖 runtime 默认值。
