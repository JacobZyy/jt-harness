# 记忆更正、补充、冲突验证

本文记录 v2 修订功能验证，随后补充了 [v3 存储能力](memory-storage-v3-verification.md)。修订存储能力继续保留；当前默认由主会话声明关系，独立 DSH 比较只用于显式 legacy 路径。下文候选限制、队列数量和后续事项均属历史快照，现行操作见[文档导航](README.md)。

日期：2026-09-16。范围：已确认的三条规则、历史读取、迁移与真实调用。原提炼 Agent 的提示词没有修改，既有 42 次语义评测保持收口；新增比较 Agent 单独验证。

## 实现结果

- 更正：明确的用户更正建立替代关系；旧正文、向量与来源保留，默认搜索不再返回 superseded 条目。历史通过 search --history 和 read 读取。
- 补充：关联新旧条目，两端保持有效，不改写原文。
- 冲突：保留双方或原始 revision 证据，状态为 conflicted。更正一方不会默认为另一方获胜；争议随新版本延续，明确裁决后才解除。

比较 Agent 只能引用程序提供的候选。程序对真实 ID、完全相同的范围、用户证据引文和当前状态再次校验。向量、关系、比较会话记录及发布回执在同一 PostgreSQL 事务提交；失败时旧版本仍有效。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| pnpm typecheck | 通过，含新增 TypeScript 验证脚本 |
| pnpm build | 通过 |
| pnpm test | 8 项通过，3 项显式跳过外部依赖测试 |
| 原生 PostgreSQL + pgvector 集成测试 | 12 项通过（含顶层测试） |
| 比较 Agent 真实边界测试 | 1 项通过，内含两个场景：新陈述不等于明确更正；不相关事实不建立关系 |
| 五批真实会话 | 全部 complete，经过真实 DSH、真实 Qwen Embedding 和 PostgreSQL |

数据库测试覆盖：发布失败回滚、更正幂等、默认隐藏旧版、历史可查、补充双方有效、冲突双方标记、只更正一方后的冲突延续、明确裁决双方、没有新事实条目的 revision-only 冲突、跨范围和伪造引文拒绝、v1 数据迁移保真，以及既有队列恢复测试。

## 五批真实会话

测试项目：jth-revision-check-1789557961507。测试内容为 example.invalid 域名，不是用户实际服务地址。

| 批次 | 状态 | 向量条数 | 直接关系数 | 尝试次数 |
| --- | --- | --- | --- | --- |
| initial | complete | 1 | 0 | 1 |
| correction | complete | 1 | 1 | 1 |
| supplement | complete | 1 | 1 | 1 |
| conflict | complete | 0 | 2 | 2 |
| resolution | complete | 2 | 2 | 1 |

验证顺序是：记录 alpha 地址；明确更正为 beta；补充 30 秒超时；引入 beta/gamma 未决争议；明确裁决为 delta，保留 30 秒超时。默认检索不再返回 alpha、beta 旧条目，history 查询仍可定位 alpha。

冲突批次第一次在比较阶段收到模型服务 HTTP 418，提炼已经保存，向量和关系没有发布。显式 retry 后成功，仍沿用原提炼会话 session-610e70778cdb432a984c479e6c04bf74；没有为了恢复而重新提炼原材料。这验证了外部服务失败时的检查点与恢复行为，不代表已经定位或修复模型服务的 418 根因。当前没有未完成或失败任务。

结果保存为 artifacts/jth/revisions-live-result.json；逐批材料、提炼和关系回执保存在 artifacts/jth/jth-revision-check-1789557961507/。read 返回的是读取时的当前状态，因此恢复验证时保存的旧批次结果可能已经显示 superseded；原始正文和提交回执未被改写。

## 本机升级与图形客户端

实际数据库从 v1 升级到 v2。升级前创建 artifacts/jth/pre-revisions-v1.dump，权限 0600。升级后复核原有 3 条向量的完整文本哈希，全部一致。

只读账号 jth_viewer 能查询新 entry_relations 表和 entry_states 视图，仍无写入权限。当前测试数据共有 8 条记忆条目、6 条关系。迁移证据为 artifacts/jth/revision-migration-check.json。

## 能力边界与后续

本版没有把相似度当成裁决。每个查询探针取最多 5 个候选、合并后最多 20 条旧记忆；不是对全库所有关系的穷尽扫描。模型仍可能误判语义，当前验证也不等于任意自然语言都正确。编造引用、跨范围修改和未发布更正会被程序拒绝。

没有命中旧目标的批内冲突仍保存在原始 revisions 中，通过 read --submission 查看。不同批次的同义重复尚未自动归并。Codex 自动采集/读取、关键词混合召回、索引重建和日常维护继续后置。

Rex AIOS 源码分析和下一步优先级见 [Rex 记忆机制参考](rex-memory-reference.md)。
