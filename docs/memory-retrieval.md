# 记忆线索、检索、证据与采用反馈

本版实现四项读取能力，继续使用原有来源、范围、时效、审核、修订和索引契约。Phoenix 评分、界面调优及 Jev 接入后置；检索分数和采用次数都不是正确率。

## 主动线索

Memo 安装两个轻量线索 Hook，和原有 Stop 声明入口共存：

- `SessionStart` 只重置本会话的线索投递标记，不读数据库。
- 启动或恢复后的首次 `UserPromptSubmit` 用当前输入做本地关键词召回，最多给出 3 条短线索，随后同一会话不再每轮重复查询。
- 同一会话开始新任务或明确换目标时，由主 Agent 按 Flow 指引主动 `recall`。已有线索足够时不重复查询；语义任务边界仍由主 Agent 和原生计划负责。

线索使用安装记录中的项目、业务范围及用户全局范围，沿用正式检索的状态过滤。Hook 只连接已经运行的 PostgreSQL，不启动数据库、不迁移、不调用 Embedding 或生成模型。连接超时 200 ms、数据库语句超时 500 ms；不可用时放行，继续主任务，之后可手动检索。

投递状态存于 `JTH_DATA_DIR/codex/cues/`，可通过 `jth memo codex status` 查看。它只记录会话投递状态、查询哈希、命中 ID 与匹配信息，不是任务库，也不保存完整用户提示。`no-match` 与 `unavailable` 分开报告。需要关闭自动线索时，可在 Codex `/hooks` 禁用 `jth memo cues`，保留手动查询和 Stop 声明。

## 按需深查

```sh
jth memo recall 'source_session_id' --project my-project
jth memo search '跨会话的来源怎么关联' --project my-project
jth memo search 'source_session_id' --project my-project --mode keyword
jth memo search '跨会话来源' --project my-project --mode semantic --min-similarity 0.7
```

`recall` 只走关键词通道，不需要 Embedding 配置；`search` 默认 `hybrid`，也支持 `keyword` 和 `semantic`。语义或混合搜索继续只请求一次查询 Embedding，没有额外重排模型。

关键词通道使用 Unicode 分词并保留标识符/路径词元；正文或实体字段匹配至少一半查询词元才进入候选，完整短语匹配优先。向量通道默认要求余弦相似度至少 0.6，可通过 `--min-similarity` 调整。两个通道采用 reciprocal rank fusion 合并排名，不把不同比例的原始分数相加。返回 `match` 包含命中词、关键词覆盖率、余弦相似度与融合排名分数。

范围、候选资格、归档与时效过滤发生在排序前；相关性不足时返回空列表。不能将相似度当作事实正确性，也不能将空结果理解成全库没有答案。当前阈值是可调起点，真实业务质量仍需日常使用记录评估。

CLI 默认返回 3 条，可用 `--limit 1..50` 调整。原内部向量 `MemoStorage.search` 契约保留，供历史兼容调用；当前 CLI 使用新的混合检索入口。

## 证据分层

```sh
jth memo read <ID> --level summary
jth memo read <ID> --level evidence
jth memo read <ID> --level full
```

- `summary`：事实正文、范围、资格、有效期和版本。
- `evidence`：再加有限来源片段与关系。优先定位完全匹配的原文，否则选择包含较多事实关键词的原文窗口；没有可定位内容时保留开头预览。片段明确标为 `preview`，携带原长度、起点和是否截断，不能冒充完整原文。
- `full`：原有完整读取结果，保留引用消息、关系和动作。默认仍为 `full`，保持旧 CLI JSON 契约；Flow 指引建议普通任务先用 `evidence`。

证据层最多展示 6 条来源、每条 600 字符，以及 6 条关系。更多内容或被截断的条件需要通过返回的 `next` 命令展开。更正、补充、冲突声明需要本会话的完整来源读取回执；只读摘要不能代替修订依据。

## 采用反馈

主 Agent 仅对实际影响本次结果、且已通过本会话 `read` 读取的记忆，在末尾声明顶层 `used` 数组列出 ID。展示过或读过不自动等于采用；最多 10 个 ID。没有新事实时可以只提交反馈：

```text
<!-- jth-memory {"items":[],"used":["00000000-0000-0000-0000-000000000001"]} -->
```

示例 UUID 必须替换为真实已读 ID。程序复用本会话读取回执，保存当时读取版本与声明来源；反馈和声明收件同事务、重复 Stop 幂等。反馈本身不会新增记忆条目、索引任务或 Embedding 请求；被唤醒的既有 worker 仍可处理先前积压的正常索引任务。`--as-of` 历史读取不产生当前版本回执，不能用来提交此版采用反馈或更正关系。

```sh
jth memo usage --project my-project
jth memo usage --session <Codex会话ID>
```

返回的是主 Agent 报告的采用记录。它不提升审核资格、不修改事实、不自动影响排序，也不表示采用正确。未来可据此接入 Phoenix 真实使用评估。

## 升级与边界

数据库 v8 只在 v7 上增加 `memory_uses` 采用记录表；原文、向量、版本、队列与历史回执保持原样。

```sh
jth init
```

问答式 `init` 自动复用配置、准备表结构、同步项目入口并检查。`memo init`、`upgrade` 和 `doctor` 继续保留为高级分步或诊断入口。

共享同一数据库的旧 CLI 需要升级其运行入口，避免旧 worker 因版本不符停止接收。不要清空队列或删除历史来源；新版 worker 继续沿用原收件流程。已有 Codex 会话重新加载后使用新 Hook 与指引。

当前仍使用适合个人存量的精确扫描，没有新增搜索服务、ANN 索引、常驻进程或评分模型。数据量导致读取延迟上升后，再根据测量结果增加数据库索引。

## 本次验收（2026-09-22）

- `node scripts/test.mjs`：60 项通过，24 项依赖独立环境的检查跳过；`node scripts/test-postgres.mjs`：45 项通过，覆盖范围隔离、混合召回、分层读取、声明幂等及采用反馈不产生新事实或索引任务。
- `JTH_NATIVE_CONFIG_TEST=1 node --test packages/cli/src/delivery.test.ts`：8 项通过；`node scripts/typecheck.mjs` 通过。
- 本机 Codex 原生启动、恢复均触发线索 Hook，分别返回 2 条线索。使用本地 Responses 服务验证协议，付费模型调用与新增记忆事实均为 0。已有 Phoenix 采集链路另通过 `node scripts/verify-monitor.ts` 验证，未实现新增评分功能。
- 本机数据库升级至 v8 后，原有 1,426 条记忆、1,426 个向量、137 个任务的来源、内容和任务载荷核对一致。`jth doctor` 六项检查通过，当前项目 7 个 JTH Hook 均启用且受信任。

本次只安装本地构建，未发布 npm、未推送远端。共享数据库的 `jt-cli` 仅更新 Memo Stop Hook 的运行入口与对应信任记录，其既有 AGENTS 改动保持原样。上述检查验证代码与接入行为，不是日常记忆质量评分，也不替代后续真实业务验证。
