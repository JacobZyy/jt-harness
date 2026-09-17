> 历史检查点：会话内自动提取已切回 DSH。当前状态见 [DSH 恢复验收](dsh-restore-verification.md)。

# 会话内记忆重构验收

验证日期：2026-09-17。范围：默认写入不经过 DSH；当前会话提交结构化候选，正文和索引任务原子保存，后台只调用 Embedding。

## 交付边界

生产代码已分到三个 workspace package：

| Package | 责任 |
| --- | --- |
| `@jt-harness/memo` | 候选契约、数据库、版本检查、修订、索引 worker、查询 |
| `@jt-harness/codex-hooks` | 六种 Hook、原始来源登记、证据选择、本地投递材料 |
| `@jt-harness/cli` | 命令、配置和进程编排 |

旧根目录 `src`、`memory-agent`、`dist` 已移到忽略的 `artifacts/jth/inline-migration` 备份区，不再是生产入口。根 `bin/jth.mjs` 保持路径不变。默认 `work` 仅处理 `kind=index`；历史 DSH 导入和重试需要显式 `--legacy`。

## 自动检查

- `pnpm build`：通过。
- `pnpm typecheck`：通过，包含 package、测试和验证脚本。
- `pnpm test`：15 通过；4 跳过（2 项真实 DSH 评测、2 项 PostgreSQL 测试入口）。
- `pnpm test:postgres`：独立临时 PostgreSQL/pgvector 中 21 通过，包含上述两个 PostgreSQL 测试入口及其子用例。

关键覆盖：

1. 正文和索引任务在同一事务保存；队列插入失败时正文也回滚。
2. 同一候选重复提交不新增正文；丢失投递回执可以恢复。
3. 数据库离线时保留本地候选；Embedding 失败重试不重新提取、不改变条目 ID。
4. 索引 worker 忽略 legacy 任务；Embedding 以外的 fetch 被测试拒绝，DSH executable 配置为不存在。
5. 提交时版本过期则拒绝；发布前版本变化则保留待审候选、不覆盖旧事实。
6. 明确更正与向量原子发布；旧版来源、作用域、时间及历史查询规则继续通过。
7. 默认来源预览不包含工具日志；长材料分页，截断 JSONL 不被当成完整消息。
8. 消息 ID、角色和父子会话身份校验；源文件被篡改则拒绝；子 Agent 委派不冒充用户确认。
9. Hook 安装幂等、保留其他工具；源文件原路径被删除后，保留的文件仍可验证。

## 真实 Embedding 验收

执行 `node scripts/verify-inline.ts --live`。使用隔离合成 Codex JSONL，测试项目为 `jth-inline-check-1789612034308`。整个执行环境的 `JTH_DSH_BIN` 指向不存在的文件。

- 正文接收回执：135 ms。
- 从提交到观察到索引完成：1,576 ms，含轮询开销。
- 实际模型：`qwen3.7-text-embedding-flash`，1,024 维。
- 提交：`record-d1ca4a206b00cc11308165ab93d361eba3b25a81e6d29fe3012a7284286f106f`。
- 索引回执：`d997131e-714e-4a4f-9c3a-54691156d516`。
- 向量查询命中同一条目；重复提交仍为同一批次；`agent`、`reconciliation_run` 均为空。
- 合成测试条目已经归档，保留可审计证据。

这是一条实测样本，不代表吞吐或 P95 延迟保证。合成采集事件也不等于所有原生 Hook 的端到端验证。

## 本次真实会话验证

原生 `SessionStart` 于 `2026-09-17T02:22:17.356Z` 登记了当前来源会话 `01a0724a-b095-7000-929c-b5ddaee2d4a1`。已使用真实消息 ID 读取方案及用户后续同意，提交用户确认的架构决定。

- 提交：`record-cae8c0fd981256d9dcd0c6fbea5b430d2a3fdae529f7cd81ed996487766e6098`。
- 正文保存：`2026-09-17T02:29:58.707Z`。
- 索引发布：`2026-09-17T02:29:59.251Z`，相隔 544 ms。
- 索引回执：`f87a83b4-ecef-4077-bff7-5faa7d9def74`。
- 提取来源标记为 `codex / gpt-6-astra`，一次索引尝试完成，没有后台提取 Agent 或关系比较模型。

这里只证明真实 SessionStart、证据获取、当前 Agent 提交和真实向量发布。其他五种 Hook 的原生触发仍需后续实际使用观察；它们的输入处理已由自动测试覆盖。

## 数据与 Hook 迁移

数据库由 schema v3 升至 v4。迁移前有 14 批来源、24 条记忆、24 条向量、14 个索引回执、6 条关系、5 个管理动作。逐表按完整行排序计算指纹，迁移后完全相同。

备份与证据：

- `artifacts/jth/inline-migration/database-before.dump`
- `artifacts/jth/inline-migration/data-before.json`
- `artifacts/jth/inline-migration/data-after.json`
- `artifacts/jth/inline-migration/source-before.tgz`
- `artifacts/jth/inline-migration/hooks.json`

重新执行安装后 `.codex/hooks.json` SHA-256 不变；原信任命令和启用时间 `2026-09-16T16:11:40.251Z` 保留。

旧队列的 14 个完成任务和 15 个失败任务均保留为 `legacy`，默认不再运行这些失败任务。没有把旧失败状态伪装成成功。

最终 `memo doctor`：schema v4、16 批来源、16 个索引回执、0 错误。保留两个历史警告：8 条旧记忆缺少完整来源时间、15 个 legacy 任务失败。它们不阻塞新索引路径。

## 已知边界

- 当前 Agent 必须主动提交；Stop 不会额外启动模型补写遗漏的总结。
- 程序验证结构和来源，不能替代语义判断或自动发现全部矛盾。新的不确定信息应保留为候选。
- 单个后台索引 worker 复用既有数据库任务表。当前 API 每条文本单独请求，避免已观察到的重复 batch index；没有新增队列服务。
- 本次为本地 workspace 交付，未新增 HTTP 服务，也未改 `jt-cli`。DSH 仅保留为显式历史导入能力。
