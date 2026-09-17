# Rex AIOS 记忆机制参考与后续工作

调研日期：2026-09-16。对应用户之前给出的 `rexleimo/aios` 和 `rexleimo/rex-harness`。本次读取 AIOS 提交 `d8813a74d80955d11175ee3e034cd16841de11ff` 的实际读写、查询和版本代码；没有安装或执行该仓库的脚本。

后续用户已确认把原子事实、时间语义、存储体检、候选审核和归档能力全部纳入本项目。现已按 PostgreSQL 原生约束与事务落地为 v3，操作和验收见 [存储增强验证](memory-storage-v3-verification.md)。下方调研保留原始源码依据；不是所有“后续建议”都仍未实现。

## 结论

值得参考的是它对来源、可见范围、历史与当前事实的分离，以及按需召回方式。我们继续使用现有 PostgreSQL + pgvector，借鉴这些行为规则，不迁移到它的文件后端，也不引入完整 AIOS。

记忆主实现位于 AIOS 的 Memo / ContextDB。`rex-harness` 独立模式负责工作流与证据，ContextDB 是接入 AIOS 后获得的宿主能力。[rex-harness 说明](https://github.com/rexleimo/rex-harness#与-aios-的关系)

## 实际实现

### 存储与来源

Memo 的规范存储默认是 `.aios/memo/file/events.jsonl`，也支持每条事件一个文件的 split 模式。新增事实只追加事件；写入由存储锁保护。事件带稳定 ID、来源、范围和声明状态。派生查询文件可以重建，重建不会重写规范事件。

ContextDB 还包含会话事件、检查点和上下文包等来源；不能把 Memo 的 JSONL 后端等同于整个项目只使用一种存储。

来源：[ContextDB 文档](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/docs-site/zh/contextdb.md)、[事件写入](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/storage/events-write.mjs)、[派生索引](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/storage/derived.mjs)。

### 读取

项目注册表提供来源指针，Agent 按当前任务自行召回，不在每个会话开头注入全部历史。Memo 读取先过滤范围、候选状态和失效记录，再进行分词匹配、BM25 及其他相关性打分；时间主要用于相近分数的排序。

`search --level summary|full` 支持摘要与完整输出，还返回条目数和字符数，便于观察本次读入规模。当前该 CLI 默认 level 是 full，因此不能误称它所有命令都默认只读摘要；我们的 `search` 已经默认短预览，`read` 才返回完整来源。

来源：[查询实现](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/storage/query.mjs)、[搜索输出层](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/cli/commands/events.mjs)。

### 更正与历史

新事件用 `supersedes` 显式关联旧事件。读取时计算旧事件的失效状态，默认隐藏已被替代记录，显式请求时仍能读历史。它检查范围、身份和未知目标，避免跨空间失效。

它也有基于相似度的替代建议，但建议与实际应用分开，CLI 需要显式 `--apply` 才写入关系。相似度说明可能相关，不能独立证明两条事实谁正确。

来源：[temporal.mjs](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/storage/temporal.mjs)、[supersede CLI](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/cli/commands/supersede.mjs)。

### 补充与冲突

普通新增事件能保留补充事实；明确更正可以链接旧事实。模型判断语义，工具执行有依据的操作，候选不能自行升级为已验证事实。

本次核对的核心链路没有展示一个可以直接复用、与我们的 `correction/supplement/conflict` 完全对应的统一接口。因此不能把它的 append-only 或 supersedes 机制误认为已经替我们解决补充关联、未决冲突和双方证据的全部需求。

来源：[Memo Skill](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/skill-sources/memo/SKILL.md)、[候选治理](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/storage/candidates.mjs)。这里的 Skill 仅作为被研究材料，没有作为本项目指令加载。

### 是否完全不用向量

它的 Memo 主查询不依赖外部向量数据库，但当前已有可选 `hash-lexical` 向量预筛选：将词元哈希映射成数值向量，在本机执行，默认不开启。这是词法投影，不等同于 Qwen 的语义 Embedding。它只增加召回候选，后续仍使用词法/BM25 排序。

来源：[embedding.mjs](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/storage/embedding.mjs)、[查询实现](https://github.com/rexleimo/aios/blob/d8813a74d80955d11175ee3e034cd16841de11ff/scripts/lib/memo/storage/query.mjs)。

## 本次采用的原则

- 正文和来源保留为不可变历史，用明确关系表达更正，读取时决定当前有效状态。
- 相似度只找候选。DSH 关系比较 Agent 判断语义，程序校验 ID、范围、来源和提交原子性。
- 新旧项目或业务 ID 集合必须完全相同。未确认建议不能作废事实。
- 默认检索隐藏 superseded，`--history` 可查历史。冲突公开标记，`read` 同时提供对方内容和证据。
- 新事实、向量和修订关系一起发布；任何一步失败，旧事实继续有效。

这些原则落在 PostgreSQL 的事务、外键、关系表和状态视图中，没有复制 Rex 的文件锁或文件存储代码。

## 除三条规则之外，接下来做什么

1. **接通 Codex 的实际读写流程。** 写侧提交会话增量、稳定消息 ID 和项目范围，并明确原始事件顺序与重试、补录规则；不能把入库晚等同于事实更新。当前还没有原会话事件时间字段。读侧先 search，再按需 read。遇到 conflicted 必须读取双方证据，不能直接当确定事实引用。Hook 触发与调用适配需按本机 Codex 能力单独验证。
2. **补读取质量与可观测性。** 用真实查询评估当前向量召回，优先覆盖函数名、路径、错误码等精确关键词；需要时增加词法候选并与向量召回组合。借鉴摘要层级、总输出预算和读取回执，明确本次读了哪些 ID、多少字符。记忆读取预算不等同于全局任务读取权限，后者仍归流程控制。
3. **完善本地维护。** 提供备份/恢复说明、模型变化后的重建索引、范围和状态统计。先观察真实重复率，再决定跨批同义去重；当前重复投递幂等不等于所有重复事实已经合并。

三条规则及五项存储增强已实施。Codex 接入、关键词混合召回、跨模型索引重建和流程控制仍是后续工作。
