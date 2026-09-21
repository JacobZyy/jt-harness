# jth 本地记忆系统技术设计

> 历史设计：本文记录 2026-09-16 起的 DSH 提炼路径及存储演进，后续补记 v5 接收行为。2026-09-20 起默认入口已改为[主会话声明](memory-declarations.md)，Flow 使用[Codex 原生能力](flow-control.md)。下文模块路径、默认命令和未完成项只描述历史版本；现行配置与分发见[文档导航](README.md)。

当时交付：独立 CLI、数据库 v3、三类修订及五项存储增强。本文当时取代 HTTP / DSH 原生存储插件 / Rust `jt-cli` 合并草案；更早草案保存在 `history/memory-plugin-v0.3.md`。

## 交付边界

`jt-harness` 单独提供 `jth` CLI，使用 TypeScript。命令入口直接调用内部模块；与 `jt-cli` 没有源码依赖或运行时耦合，不提供 HTTP 服务。

DSH SDK 运行专用提炼 Agent 和独立的关系比较 Agent。确定性代码负责接收、候选检索、状态、嵌入、事务和最终关系约束。Agent 不直接获得数据库或 Embedding 密钥，也不控制提交是否成功。v5 在业务解析前保存原始模型返回，按条目保留未接收部分；旧检查点仍可读取，不重写已有正文和哈希。

流程控制、上下文偏移限制、Codex Hook 采集安装、全库同义去重、记忆冲突管理 UI、生产部署和分发打包不属于本版实现。

## 所有权与模块

| 模块 | 唯一职责 |
| --- | --- |
| `bin/jth.mjs`、`src/cli.ts` | 命令解析、文件/stdin 输入、JSON 输出、后台进程启动 |
| `src/config.ts` | 从本工具 `.env` 加载配置，生成不含密钥的执行配置 |
| `src/memo/jobs.ts` | PostgreSQL 收件幂等、队列状态、显式重试 |
| `src/memo/worker.ts` | 独占消费、断点恢复、串联 Agent 与嵌入和提交 |
| `memory-agent/` | 提炼、关系比较与共用的无工具 DSH 运行器 |
| `src/memo/embedding.ts` | 外部 API 调用和返回向量验证 |
| `src/memo/storage.ts` | 不可变材料、候选条目、整批向量事务、范围检索 |
| `src/memo/relations.ts`、`revision-storage.ts` | 三类关系校验、同范围候选检索、冲突延续和证据读取 |
| `src/memo/database.ts`、`schema-v3.ts` | v1/v2 到 v3 的保留数据迁移、原生约束和历史状态投影 |
| `src/memo/metadata.ts` | 从真实来源派生事件时间，封装同一份历史快照查询 |
| `src/memo/management.ts` | 本机审核、可恢复归档、容量统计和动作日志 |
| `src/memo/doctor.ts` | 在只读一致性快照中核对来源、索引和关系 |

没有独立路由层、消息队列产品、通用服务容器或自研模型 SDK。SDK 继续通过本地 stdio 运行 DSH，不依赖 Web 3080 服务在线。

## 执行顺序与收件语义

1. `jth memo send` 校验来源材料，将材料和不含密钥的执行配置插入 `jt_memo.jobs`。
2. PostgreSQL 提交后返回任务 ID；默认启动 detached `jth memo work` 并立即返回。
3. Worker 等待数据库 session advisory lock，然后恢复遗留 `running` 任务，按接收时间处理队列。
4. 如果没有提炼检查点，使用已固定的模型调用 DSH SDK。只有 `turn/end: completed`、未暴露工具、输出与来源契约全部通过时才接收结果。
5. 提炼、原材料、来源绑定和候选条目在事务内保存。该阶段称为 stored，尚不可搜索。
6. 逐条生成新记忆及修订旧说法的 Embedding，校验模型、序号、数量、维度、有限值和非零向量。
7. 按相同范围与向量空间召回旧记忆；每个探针最多 5 条，集合最多 20 条。没有旧候选时跳过比较；超过集合或 384000 UTF-8 字节的比较材料上限时明确失败。
8. 比较 Agent 仅返回旧 ID、新 ID 或本批冲突 revision 序号、关系、解释及本批原文引证。不能生成新正文，不能用时间或相似度独立授权替代。
9. 在一个事务内写入向量空间、全批向量、已校验关系和索引回执。向量完整对应条目 ID 及正文 SHA-256；更新前锁定并重读旧条目的当前状态。
10. 将任务标记为 complete。没有条目且没有关系时为 noop；仅发布 revision 冲突证据仍是有效提交，不误报为无操作。

`queued` 不是提炼完成，`stored_at` 不是检索就绪；`index_receipt_id` 对应的事务成功表示处理和索引已完成。是否可默认召回还要检查生命周期、审核资格和归档状态。`candidate_count` 与 `publication_notes` 明示待确认内容。

## 数据与并发约束

`jobs` 持有已接受的材料和执行配置，状态为 queued/running/failed/complete。`submissions` 持有经 Agent 验证的提炼检查点；`entries` 持有不可变候选正文和引用。队列与检查点有不同职责：前者证明接收，后者证明提炼结果已被接受。

`embedding_spaces` 由 API 地址、模型、维度、输入版本 `content-v1` 定义。空间 ID 由该定义计算，定义不能被同 ID 替换。`index_commits` 与 `embeddings` 一起提交，外键、维度约束和应用侧正文哈希校验阻止批次混写。

同一 `submission_id` 的相同材料重复提交不生成第二个任务；不同材料报冲突。提炼结果一旦保存不能被不同结果覆盖。相似度仅提名比较候选，不直接合并或决定新旧事实谁正确。

`entry_relations` 记录 correction/supplement/conflict、两端条目或原始 revision、来源消息、引文和说明。`index_commits` 保存比较决定及比较阶段 DSH session；`entry_states` 是从发布回执与关系推导出的视图，不复制一个容易失配的状态字段。

- correction 必须有本批用户陈述或确认的真实引文，新旧条目属于完全相同范围；旧条目标为 superseded，正文、向量和来源不删除。
- supplement 关联两条仍有效的记忆，不覆盖正文。
- conflict 保留双方内容或原始 revision 证据，将相关有效条目标为 conflicted。只更正其中一方时，争议跟随新的替代者；不能因此默认为另一方获胜。两端均被同一明确结论替代时解除争议；revision-only 冲突要求明确引用待裁决的冲突 ID。

一条旧记忆只能有一个直接替代者。未审核的助手建议、未知 ID、未发布条目、已经失效的旧条目、范围不一致或编造引文均不能改变当前事实。审核过的建议保留原 `basis`，但可作为已认可的旧知识参与后续比较。同义重复的归并尚未实现。

## v3 存储增强

### 原子事实与时间元数据

新提炼按可独立更正的事实分条，保留使事实成立的限定条件和多条必要引用。`entities` 允许别名归一化，无需逐字匹配原文；`valid_from/valid_until` 仍需有效时间与依据。来源角色和上下文标记只保留事实，不用来否定模型分类或强制新增消息引用。程序校验真实 ID、数据形状和关联一致性，语义由模型判断。

输入消息可带 `occurred_at`，已声明的时间须与原会话顺序一致。只有一条事实引用的全部消息都有时间，才取最后时刻作为 `source_occurred_at`。不知道的时间保持 null。接收时间来自 jobs，提炼记录时间来自 submissions，向量发布时间来自 index_commits。

历史快照通过 `entry_facts_at(as_of)` 统一计算。只有当时已经保存的条目可以被读取，只有当时已发布、已生效并符合审核/归档条件的条目进入默认搜索。当前视图 `entry_states` 使用同一函数，避免维护另一套重复状态。

### 迟到材料与审核

自动更正若早于当前事实的已知来源时间、缺少比较所需时间、来自更早接收但更晚完成的任务、已经过期或尚未生效，会转入候选并给出原因。旧事实不被作废。更正意图保存在回执；有新条目的争议以需审核的 conflict 关系保留，候选尚未通过审核时不会影响已接受条目的冲突状态。

只有明确审核后，候选才可参与默认召回；确认候选不会隐式执行曾被拦截的替代计划。相反说法仍然保留为冲突，继续通过明确更正裁决。未来更正没有隐式定时执行器，需要生效时确认或提交新的明确决定。

`claim_status` 区分 asserted（用户陈述）、observed（工具观察）、verified（用户确认或本机审核）、candidate、rejected。它与 `state`、`archived` 分离。没有将模型自报“已核实”当成权限；模型契约没有审核字段，运行时只能追加 hold。本机 CLI 的 approve/reject 记录数据库账号、理由和依据引用。

### 审核、归档与体检

`entry_actions` 是唯一的追加动作日志。审核与归档均不改正文和原始依据类型。批量按会话归档只选 current_task，恢复归档不会撤销拒绝、失效或替代关系。

归档仅改变活跃集合，不物理清理原材料、向量或关系。stats 展示条目分布及表容量；doctor 使用只读、可重复读事务检查源契约、哈希、索引数量、空间维度、完成回执、关系证据与循环。发现问题仅报告，不默认修复。

一个数据库一次只处理一个任务。锁和所有 worker 写入共用同一 PostgreSQL session：连接失效时自动释放锁，同时旧 worker 丧失写入能力。其他 worker 等待锁而非直接退出，避免任务恰好在前一 worker 退出期间到达却无人消费。连接错误或进程终止会触发 AbortSignal，关闭 DSH 调用并取消 Embedding；即使模型仍短暂运行，失效连接也无法发布数据。

事务不跨越模型或 API 网络调用。没有永不释放的应用内租约，也没有凭时间猜测进程存活的回收策略。

## 恢复策略

- 接收前失败：返回错误，调用方保留材料后再投递。
- 接收后后台启动失败：返回已接受 ID 与启动错误；运行 `memo work` 即可恢复。
- 模型失败或输出校验失败：标记 failed，原材料保留。
- Embedding 失败：标记 failed，提炼检查点保留；`retry` 不重新提炼。
- 比较失败：提炼检查点保留，旧事实继续有效；重试不再次提炼。
- 发布事务失败：回滚向量、关系及回执，重试时重新嵌入、比较本批。未提交的比较不作为永久决定保存，避免恢复时套用过期旧状态。
- 向量提交后、更新 complete 前崩溃：下次处理读取现有回执，直接完成任务。
- 整机重启：数据库和 worker 由用户显式恢复，不暗中安装开机服务。

失败默认不循环重试。`retry` 只作用于 failed；对 queued/running 的恢复使用 `work`。

## 检索边界

用户明确选择 user/project/business/current_task/unspecified 中一种范围。查询文本使用当前相同向量空间嵌入，PostgreSQL 按精确余弦距离排序。默认只返回 active/conflicted、未归档且来源资格为 asserted/observed/verified 的条目。`--history`、`--candidates`、`--archived` 显式打开各自维度，`--as-of` 选择历史时刻。search 输出短预览及状态；read 返回原文、关系、双方引用和操作日志。遇到 conflicted 的消费者应先查看争议依据，不将其当作确定事实。

一个输入批次存在多个 project/business ID 时，Agent 当前输出没有每条记录自己的范围 ID，所以按包含全部范围的条件保守检索，不使用数组交集把其他项目内容带入当前项目。

更换模型或维度不会搜索旧空间。本版不提供多空间融合、重建索引或全库冲突扫描。候选召回和比较 Agent 都有能力边界，未检出的关系不会凭空生效；没有旧目标的批内冲突保留在批次证据中。

## 本机配置与验证

`.env` 保存本机凭据，权限 0600，Git 忽略；`.env.example` 只保存键名和非敏感默认值。运行命令使用工具目录的配置，避免业务工作目录的 `.env` 被意外读取。部署时可通过进程环境或 `--env-file` 指向独立凭据文件。

本次真实接入中，Qwen Flash 多条输入响应的所有 index 都为 0；代码拒绝该不明确映射，改为逐条调用后再提交完整向量事务。没有放宽校验或假定响应行顺序。

验证包括参数与返回校验、原生 PostgreSQL + pgvector 事务故障、重复收件、队列恢复、锁等待及取消、范围隔离、真实 DSH 和 Embedding 的读写闭环。详细结果见 `jth-delivery-verification.md`。

v2 三条规则、历史过滤、未决冲突延续、原文证据、迁移保真以及五批真实会话验证见 `memory-revisions-verification.md`。Rex AIOS 的源码研究和后续优先级见 `rex-memory-reference.md`。

v3 五项增强、时间与审核边界、存储体检、可恢复归档及真实 CLI 操作证据见 `memory-storage-v3-verification.md`。
