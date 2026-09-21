# PostgreSQL 托管、Flow 迁移与 DSH 运行验证

> 历史验证：本文记录旧 Flow 迁入 PostgreSQL 与 DSH 恢复；当前默认 Flow 使用 Codex 原生状态，旧任务只通过 flow legacy 访问。现行操作见[文档导航](README.md)。

日期：2026-09-18。改动采用现有 PostgreSQL 18 原生工具、pg 驱动和 DSH SDK，没有增加 Web 服务依赖或数据库引擎。

## DSH 优先排查

排查时本机 3080 没有监听；队列为 39 complete、27 failed，没有 queued/running，Codex 本地待投递事件为 0。失败集中在实体/来源引用、结构校验和“超过 20 条待比较旧记忆”，不是等待 Web 服务启动。

调用链是 Hook 启动 `memo work`，worker 调用 DSH SDK，SDK 用 `spawn` 启动 `sdk-minimal` 子进程。提炼与比较各自执行并关闭子进程；不需要提前打开 DSH Web 或桌面。

处理方式：保留原始材料和所有来源校验，格式/证据校验失败时附带错误反馈修复一次；两次总执行时间受既有任务超时约束。启动或网络失败不进入模型输出修复循环。取消重复的 20 条旧候选限制，仍由实际比较输入的 384000 字节上限保护，候选不截断。失败任务不会无限重试，使用 `memo status --summary` 查看分组原因。

真实任务 `codex-c99171072e2c3dcad631de8724d393b5a459d30b2d479a6304bf80cd6389858f` 在 Web 关闭时恢复完成，获得索引回执 `e7881093-eefc-4384-8bd9-f03429151d3a`。Provider/model 保持 `zz-tokenhub/deepseek-flash`，没有 reasoning effort 或输出 token 覆盖。

原先因 20 条比较限制失败的 `codex-fe6c397b51598a5123b49ed81a3515f3b0df3ee7ad21b55587a074e802f5251b` 也从已保存提炼继续完成，索引回执为 `80c079cc-927c-42b7-acc9-ffb3aaa160b3`。

## 可重复验证

- `pnpm build`、`pnpm typecheck` 通过。
- `pnpm test`：24 通过，13 个需要数据库或实时模型的场景默认跳过。
- `node scripts/test-postgres.mjs`：30 通过。脚本创建并清理隔离临时 PG，覆盖原有 21 项存储检查、7 项 Flow 场景，以及迁移/冷启动检查。
- 输出修复单测验证来源材料保持不变、最多修复一次、DSH 启动失败不会触发修复调用。
- 迁移测试验证任务内容、主从绑定、历史序号、备份权限、重复执行、拒绝覆盖不同数据、PG 并发检查点与跨工作区隔离。
- 冷启动测试先关闭隔离 PG，再并发启动；只有原生 postmaster 接管实例。Hook 在原生 3 秒限制前返回，后台启动 PG 并消费保留事件，原目标与阶段不变。

## 使用与数据边界

`.env` 配置本机 `JTH_PG_DATA_DIR`、`JTH_PG_BIN_DIR` 后按需启动。`jth db status` 只观察，`start` 幂等，`stop` 关闭明确配置的实例；外部数据库不受启停管理。关闭会回滚活动事务，已有提交与待恢复任务保留。这里不额外注册开机常驻服务。

Flow 状态的唯一运行存储是 `jt_flow`。项目 `.jth/flow.json` 只定位配置；`.jth/flow-events/` 是数据库接收前的短暂交接，不是第二个状态数据库。旧 SQLite 通过 `jth flow migrate` 一次迁入，备份及原文件保留，不再用于运行。恢复旧代码不自动把 PG 之后的新状态反向同步回 SQLite。

历史失败任务保留原错误和源材料；本次验证不会把它们清空或一律改成成功。实时模型仍可能拒绝生成符合来源契约的结果，这些失败会继续显式保留。
