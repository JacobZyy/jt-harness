# 记忆工具怎样决定写什么、漏什么、怎样更新

查阅日期：2026-10-19。范围：Mem0、Letta Code、LangMem，以及作为来源和时间建模参照的 Graphiti。只核对官方文档与官方源码，没有调用这些产品的记忆服务、模型或 Embedding，没有进行产品准确率排名。

## 结论与适用边界

这些工具都没有把“该不该记、有没有漏”变成一个可完全确定的程序问题。它们主要通过更明确的筛选规则、已有记忆上下文、结构化抽取、复查和来源保留，约束模型的选择。后台处理改变的是运行时间、输入范围和复查机会，并不自动提高事实正确性。

当前版本尤其需要区分：Mem0 默认 `add` 已是只新增的管线，不再默认让模型执行旧文章常见的 ADD/UPDATE/DELETE/NONE 四选一；Letta 当前主文档以 MemFS 和 Dreaming 为主，旧 memory blocks / archival memory 文档已归 V1 SDK。把旧设计直接当成现状，会得出错误的取舍。[Mem0 Add](https://docs.mem0.ai/core-concepts/memory-operations/add)、[Letta Memory & dreaming](https://docs.letta.com/configuration/memory)、[Letta V1 memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)。

| 工具和核对版本 | 谁选候选、什么时候选 | 默认怎样处理旧记忆 | 最值得借鉴的部分 |
| --- | --- | --- | --- |
| Mem0：OSS `0724291b`；当前平台文档 | 应用调用 `add` 后由提炼模型选；MCP 也可由 Agent 触发 | 当前提炼只新增、跳过等义重复、关联相关旧条目；显式更新/删除另有入口 | 对漏抽取的具体检查、空结果与处理失败的区分 |
| Letta Code：`d037abef` | 主 Agent；或按步数/压缩事件触发的后台 Dreaming Agent | 读已有文件，修改原位置、合并同主题内容，提交 git | 持久性过滤、先调查再写、复查、版本和分层成本 |
| LangMem：`48e3c11f` | 主 Agent 调管理工具；或应用提交后台 manager | 按 ID 创建/修改/可选删除，模型可多轮整理 | 领域 schema、操作权限、后台任务合并调度 |
| Graphiti：`7b0182f9`；v4 文档 | 应用提交 episode 后，模型抽实体与关系 | 精确重复快速复用；语义重复/矛盾交模型；按时间失效旧关系 | 原始 episode、来源关联、事实有效时间与记录时间分开 |

上表描述机制，不代表这些工具已经在 JTH 的真实任务上证明更好。下文把源码事实和对 JTH 的建议分开。

## 1. Mem0：当前是有上下文的增量抽取，历史上才是四种动作

### 当前默认写入链

`add(messages, user_id/agent_id/run_id, ...)` 是启动点。应用决定哪些消息送进去；不是 SDK 自动观察整个工作区。当前官方文档明确平台和 OSS 均为新增管线，新的记忆不通过该管线覆盖或删除旧条目。平台返回 `PENDING` 与事件 ID，需要查询完成状态；这与“请求已发出”不同。[官方 Add 文档](https://docs.mem0.ai/core-concepts/memory-operations/add)。

OSS 的 `Memory._add_to_vector_store` 先读取同一标识范围最近 10 条消息，并召回 top 10 旧记忆。它将旧 ID 映射成短编号，使用 `ADDITIVE_EXTRACTION_PROMPT` 做一次提炼，再批量生成向量、做正文哈希去重、存储和关联。相关旧条目可通过 `linked_memory_ids` 连接；哈希检查覆盖当前召回集合和本批次，不是对全库语义等价的证明。`infer=False` 跳过提炼，直接存消息，内容选择由调用方负责。[当前默认调用链](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py)。

### 它怎样减少漏抽取和误抽取

当前提炼 prompt 有针对性地要求：逐主题和逐消息检查，回看中段、末段，保留可查询的名称和数量；提取文档本身的事实，而非“用户分享了一份文档”；跳过助手的重复复述；不把旧记忆中的细节擅自填进新事实。相对时间应以对话发生时间为锚点。它还区分用户与助手提供的内容，并支持记录相关旧记忆。[提炼规则与示例](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/configs/prompts.py)。

这些都是模型指令，不是完整性检查器。它可以遗漏、错归属，也可能把助手建议记得过于像已确认事实。对 coding Agent，保留建议与“用户已采纳”“工具已验证”之间的依据区别，仍然必要。这个风险判断是根据输入和 prompt 边界作出的推断，不是本次运行测试结果。

领域收窄是明确可配置的：`custom_instructions` 用允许的事实类型和正反例控制提炼，包括应该返回空列表的材料。官方要求用真实对话回归测试、版本化 prompt。旧 `custom_fact_extraction_prompt` 已改名；旧 custom update 页面当前也重定向到此页。[Custom instructions](https://docs.mem0.ai/open-source/features/custom-instructions)。

### 四种动作、矛盾、时间和失败

源码仍保留 `DEFAULT_UPDATE_MEMORY_PROMPT` 和 `get_update_memory_messages`，描述 ADD/UPDATE/DELETE/NONE，但当前默认写入入口导入并使用的是 additive 提炼。保留旧 prompt 不等于默认仍执行它。显式的 update/delete API 也不能当成自动矛盾解决。[prompt 文件](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/configs/prompts.py)、[当前入口](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py)。

当前 Add-only 保留变化前后的内容，但“有关联”本身没有裁决哪条此刻有效。过期日期可以控制默认可见性，也不等于语义冲突判定。原始消息、调用方 metadata 与提炼后事实是不同对象；不能只因为带 metadata 就假定有 JTH 那样的逐条连续引文校验。[Add 的有效期与原文模式](https://docs.mem0.ai/core-concepts/memory-operations/add)。

成本至少包含一次提炼模型请求、写前查询 Embedding 和新事实 Embedding，另有实体关联成本。当前源码把提炼请求异常抛出，避免把服务失败伪装为无事实；但提炼 JSON 解析失败仍可能记录日志后得到空集合。因此“返回空”还不能单独证明正确跳过。以上是代码路径核对，没有测量真实 token、延迟或错误率。[错误处理与批量管线](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py)。

## 2. Letta Code：把记忆维护当作有版本的编辑任务

### 触发和候选选择

当前 Letta Agent 可以在工作中更新持久知识，用户也可用 `/remember` 显式教授规则。Dreaming 则用后台子 Agent 回看对话：可按完成的步数或上下文压缩触发。可选第二个后台会话审查和修订提案，官方明确会增加模型 token，不是向人请求批准。[Memory & dreaming](https://docs.letta.com/configuration/memory)。

`maybeLaunchPostTurnReflection` 在回合末检查触发条件；没有 Agent ID、没有启用 MemFS，或设置为 off 时不会启动。步数依据上次成功反思后的执行记录。因此“支持后台反思”不等于所有安装都在每轮执行。[实际触发代码](https://github.com/letta-ai/letta-code/blob/d037abef1468e93f3f085865b267bcb261504a3c/src/cli/helpers/post-turn-reflection.ts)。

### 写什么、怎样去重和更新

反思 Agent 的流程是先读已有记忆版图，再找错误与纠正、稳定偏好、项目事实、矛盾和可复用流程；临时任务状态不入库，已有内容足够则不写，同一主题优先更新已有文件。最后复查过期内容、链接和放置位置，再提交。当前源码同时保留旧布局和 MemFS v2 布局的反思 prompt，按 memory format 选择，不能只看某一个文件推定所有 Agent 都已迁移。[旧布局反思流程](https://github.com/letta-ai/letta-code/blob/d037abef1468e93f3f085865b267bcb261504a3c/src/agent/subagents/builtin/reflection.md)、[构造入口](https://github.com/letta-ai/letta-code/blob/d037abef1468e93f3f085865b267bcb261504a3c/src/cli/helpers/reflection-prompt.ts)。

MemFS v2 的指令进一步区分始终进上下文的根文件、按需打开的主题记忆和可重复执行的 Skill；让模型按持久性、已记录情况和可泛化程度筛选。相对日期要转绝对日期，重复主题合并，矛盾在原位置修正，git 保留历史。文件大小、层级和 frontmatter 有程序约束，但“长期有用”“两段是否等义”“最新说法是否足以推翻旧事实”仍由模型判断。[v2 反思规则](https://github.com/letta-ai/letta-code/blob/d037abef1468e93f3f085865b267bcb261504a3c/src/agent/subagents/builtin/reflection-v2.md)。

### 来源、文档和成本边界

MemFS 是 git 记忆仓库；提交历史、并行 worktree 和同步使变化可追踪。根文件每轮加载，主题目录按需读，默认没有语义向量索引。保存长文档和保存每轮注入的规则，会产生不同的长期上下文成本。[MemFS](https://docs.letta.com/concepts/memfs)。

反思输入是实际对话 payload，也能回放跨会话片段；来源可追到提交中记录的 transcript 路径。不过当前指令倾向于让记忆正文只保留当前知识，不把证据和历史放正文，依赖 git 追溯。这不等价于“每一事实都有经程序验证的原文引文”。读取一份文件或有提交，也不能保证语义提炼正确。[反思输入和提交约定](https://github.com/letta-ai/letta-code/blob/d037abef1468e93f3f085865b267bcb261504a3c/src/agent/subagents/builtin/reflection.md)。

它的优化是把复查、整理和版本管理做得具体；代价是后台 Agent 读对话、查旧文件、编辑、复查，可能再加审查 Agent。异步减少前台等待，却增加模型工作量和修改冲突的处理边界。“审查 Agent 通过”仍不是外部事实证明。当前公开机制没有对任意文档的无遗漏抽取保证。

## 3. LangMem：主 Agent 工具与后台提炼可分别配置

### 两种写入方式

Hot path 中，主 Agent 调 `create_manage_memory_tool` 生成的工具；工具默认说明涵盖新用户偏好、明确记住请求、重要上下文和过期纠正，并非只在用户说“记住”时工作。工具执行 create/update/delete 和 ID 校验；普通 create 不做独立语义去重。[管理工具源码](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/knowledge/tools.py)。

后台方式由应用提交对话给 manager。无存储的 `create_memory_manager` 返回提炼结果；`create_memory_store_manager` 另负责检索旧记忆、写入和删除。官方也承认 hot path 增加前台延迟和工具选择负担；后台把这部分工作移出响应路径。[概念说明](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)、[后台接入例子](https://langchain-ai.github.io/langmem/background_quickstart/)。

### 候选、合并、漏项与来源

manager 使用模型和 Trustcall 结构化抽取。开发者可以用 Pydantic schema 表达“主体、关系、对象、上下文”等，避免只留下无法解释的“用户说可以”。默认内容 schema 只是一个字符串，不自动包含文档 URL、页码、引文或有效期；这些必须由接入方定义和传入。[结构化抽取指南](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)、[默认 Memory schema](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/knowledge/extraction.py)。

`MemoryManager` 默认允许新增和更新、不允许删除，`max_steps` 默认 1，可增加整理轮次。Store manager 先召回一组旧记忆，`query_limit` 默认 5；可让额外模型生成多个检索问题，也可配置后续整理 phase。模型负责把候选对齐到已有 ID、压缩或移除重复；程序应用结果，未被选入旧记忆集合的重复项仍可能漏掉。多轮、schema 和更多查询是可用手段，不是完整性或不误删的证明。[manager 与 store manager 源码](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/knowledge/extraction.py)。

`ReflectionExecutor` 支持延迟提交；同 thread 的待运行任务可被后续提交取消并替换，避免对每个新消息反复整理。它优化调度和合并，不裁决事实。在持续活跃的会话里，需要接受记忆处理延后；本地后台执行也不能直接等同于持久队列交付保证。[延迟处理指南](https://langchain-ai.github.io/langmem/guides/delayed_processing/)、[executor 源码](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/reflection.py)。

成本随提炼轮次、可选查询模型和 consolidation phase 增长，向量与存储行为取决于 BaseStore 配置。默认机制没有 Graphiti 式事实有效区间，也没有 JTH 的读取版本作为更正前置条件；若领域需要，接入方必须建模。模型生成合法结构与事实正确是两个独立问题。

## 4. Graphiti：来源和变化时间比“直接覆盖旧摘要”更完整

Graphiti 的入口是应用提交 `add_episode` / `add_episode_bulk`。episode 可以是文本、说话人标记的对话或 JSON，并带来源说明和参考时间；episode 本身成为图节点，抽出的实体通过 `MENTIONS` 关联它。大文档仍须切成模型上下文能处理的输入；当前 v4 bulk 路径已经支持失效边处理和日期抽取，不能沿用早期“不支持”的判断。[Adding Episodes](https://help.getzep.com/graphiti/core-concepts/adding-episodes)。

实体和关系仍由模型抽取。Pydantic 领域类型、字段说明、类型间关系映射和排除类型可以约束抽取对象；这是 schema 层优化，不是“提交 episode 后所有事实一定入图”。[自定义实体与关系类型](https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types)、[关系抽取 prompt](https://github.com/getzep/graphiti/blob/7b0182f94d27075db488636cd5456981ee10b987/graphiti_core/prompts/extract_edges.py)。

去重先做正文与端点的精确快速匹配并补来源；再检索相关边，让模型判断重复与矛盾。程序校验返回索引并依据 `valid_at/invalid_at` 处理重叠时间，另用 `created_at/expired_at` 表示系统记录生命周期。旧关系通过失效保留历史，而非把变化都归成物理删除。时间缺失时还可能调用小模型提取日期。[边处理源码](https://github.com/getzep/graphiti/blob/7b0182f94d27075db488636cd5456981ee10b987/graphiti_core/utils/maintenance/edge_operations.py)。

它优化的是原文溯源、实体关系和事实变化时间。错误的实体对齐、候选未召回、错误矛盾判断及日期提取仍可能发生；确定的时间运算不能修正前一步模型给错的关系。多个提炼、去重、属性和日期步骤还会带来模型、Embedding 与图数据库成本。对 JTH，值得借来源和时间边界，不必因此整体迁移成知识图谱。

## 5. 对 JTH 可以借什么

JTH 当前默认是主会话声明事实和明确关系，Stop 绑定真实来源，后台做保存、精确去重和 Embedding；默认不另起提炼模型。正文变化的更正、补充、冲突由主 Agent 声明，并结合实际读取版本处理。以下建议以保持这条边界为前提，是机制比较后的推断，不是已经实现或已证明有效的改动。[JTH 声明协议](../memory-declarations.md)。

### 该不该记：把适用条件和排除条件说具体

可借 Letta 的持久性过滤、Mem0 的领域正反例：围绕稳定偏好、已采纳决定、可复用约束、验证后的事实和可复现经验选候选；明确排除没有后续用途的临时操作状态、重复复述、未验证完成声明，以及可从权威当前文档直接读取的大段内容。判断问题应是“以后哪种任务会用它改变决定”，而非“本轮有没有产物”。

没有值得保存的内容可以 skip；“已有正式文档”也不是自动 skip 理由。若事实需要跨任务被发现，可以记短结论和权威来源；若只有这轮有用，则保留在任务产物即可。两种情况必须用具体适用性解释，不能用模糊授权假设替代内容判断。

### 抽取遗漏：先检查候选覆盖，再压成短声明

Mem0 的逐主题、逐消息复查更适合借到主会话收口：回看用户纠正、短确认、后续范围变更、工具实际结果及文档中的关键决定，再选择最终条目。重要的是先找到候选，后做短声明压缩；不要让前一个主题、最后一句回复或条数上限决定整个会话记什么。

这仍是模型自查，不能承诺解决漏项。应在冻结的真实任务里对照原始需求和来源人工回看：被遗漏的到底是不值得记、没有进入候选、还是候选形成后未声明。后台重读一次可能发现另一批候选，也可能重复、误记；只有实际发现的新增有效项足以抵消额外调用，才值得改变当前运行边界。

### 重复与更新：候选检索有用，自动覆盖需要克制

JTH 已有精确重复复用及新增来源关联，不需要因为别的产品也有 hash 去重重新实现。可借“写前看相关旧知识”来辅助主 Agent 选择更正、补充或跳过；相关候选只是比较材料，不能按相似度就认定同一事实，更不能让相似召回自动覆盖旧正文。

变化需要区分：同事实的新来源、同主体的新事件、事实纠正、真正相斥的说法，以及不同有效时期的状态。JTH 已有显式 change 和版本前置条件，应保留这些审查边界。可参考 Graphiti 区分事实发生/有效时间与采集时间；不能把“更新日期更近”一律当“更真实”。

### 文档来源：保留内容依据与定位，不只记文档动作

Mem0 对“提取文档内容而非分享动作”的限制很具体；Graphiti 对原始 episode 的保留则补足溯源。JTH 可沿用短事实加真实来源的方式：先确认正文确实被读取，声明可独立理解的事实，再保留文档身份、版本或读取时间和可回查位置。只有 URL、文件名或“报告已保存”不能证明报告里的事实。

文档引用也需区分用户决定、外部文档陈述、工具观察和助手推断。文档只是某一时点的来源，不自动成为长期规则。无需把全文再复制进向量库；全文和可复用事实承担不同职责。

### 先补观测，再决定是否增加提炼模型

可以借各工具的运行边界，明确区分：主动 skip、没有声明而未知、声明被拒绝、持久化失败、索引失败和实际成功。模型输出了一个合法的 skip、后台队列为空，均不足以证明本轮没有遗漏。

现有真实任务评审可以验证规则改进是否有用；本报告不新增正式评分规则。后台第二模型、跨会话 Dreaming、语义自动合并和整库图谱都属于额外架构选择，不能仅凭“其他工具有”就视为必要优化。优先把候选选择、来源和关系判断讲清楚，再用真实遗漏及重复案例决定要不要增加这些成本。

## 核对版本和来源入口

以下源码链接固定到本次查得的官方默认分支 commit；它们不是各产品已发布 SDK 版本号，部署行为还应与实际安装版本核对。在线文档可能继续更新。

| 项目 | 固定 commit | 重点入口 |
| --- | --- | --- |
| mem0ai/mem0 | `0724291bd864cf807e88ee8981c8226644e8fb42` | `mem0/memory/main.py`、`mem0/configs/prompts.py` |
| letta-ai/letta-code | `d037abef1468e93f3f085865b267bcb261504a3c` | `post-turn-reflection.ts`、`reflection-prompt.ts`、`reflection.md`、`reflection-v2.md` |
| langchain-ai/langmem | `48e3c11f5bb527282c7d5339c6a87a0b35abccfc` | `knowledge/extraction.py`、`knowledge/tools.py`、`reflection.py` |
| getzep/graphiti | `7b0182f94d27075db488636cd5456981ee10b987` | `utils/maintenance/edge_operations.py`、`prompts/extract_edges.py` |

本次依据是官方功能说明和可读实现；没有从宣传用语、第三方教程、未合并 issue 或旧 benchmark 推断当前保证。没有运行服务，因此本文不声称任何工具在准确率、费用或任务收益上优于 JTH。
