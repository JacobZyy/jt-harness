# jt-harness · jth

`jth` 是本地 TypeScript CLI，提供长任务流程控制与长期记忆。`jth flow` 用短 Skill 配合 Codex 原生 Goal、任务列表、会话恢复和项目测试；`jth memo` 接收主会话末尾的短记忆声明，只将新记忆正文发送给 Embedding API，记忆和来源保存在 PostgreSQL + pgvector。

本版本直接在进程内调用业务模块，不提供 HTTP 服务，不依赖 `jt-cli`。默认记忆路径不启动 DSH，不发送聊天记录给第二个提炼或比较模型。

项目接入只需运行 `jth init`：问卷默认用当前文件夹名，复用完整的全局配置，缺项才询问。确认后自动准备记忆表、安装项目指引和 Hooks、处理信任并检查接入。首次接入默认开启原生 `update_plan`、关闭本项目 Codex 原生记忆读写；再次运行保留现有偏好。高级参数 `--codex-memory inherit` 可改为跟随上层记忆设置。

开始前准备 Bun 1.3.14 或以上、Codex、可连接的 PostgreSQL（已安装 pgvector），以及 Embedding 服务的地址、模型、维度和 API Key。安装工具后，进入项目目录运行 `jth init`，按问卷填写并重新打开 Codex 任务即可。后续项目仍运行同一命令，不重复配置全局凭据。

更新工具本体后，在每个已接入项目重新运行 `jth init`：复用已有配置、迁移记忆表并刷新 Hook 和 Skill。`jth uninstall` 清理仓库内的 JTH 接入配置，保留数据库、待处理队列和用户凭据。其他交付命令为 `jth install / doctor`，观测命令为 `jth monitor start / stop / status / open / flush`。可通过 `pnpm bundle` 构建独立发行包。Phoenix 直接在本机运行，复用 PostgreSQL 的独立 schema，不使用 Docker。详见 [本地交付](docs/local-delivery-monitoring.md)。

共享配置与凭据默认存放于 `~/.jt-harness/.env`；仓库只保存自己的接入、范围与开关，默认不依赖源码仓库的 `.env`。`init` 在终端补齐缺项并隐藏凭据输入，完整配置跨仓库复用。详见[用户级与仓库级配置](docs/configuration.md)。Flow 进入/恢复和实际 Memo 检索/读取后，主 Agent 按事实输出简短回执。

当前操作说明与历史设计的入口见[文档导航](docs/README.md)。历史报告中的“当前”“默认”和未完成项只描述报告当时的版本，不作为今天的安装或执行指令。

记忆读取现支持启动/恢复后的有限关键词线索、`memo recall` 本地召回、`memo search` 混合检索、`memo read --level summary|evidence|full` 分层证据，以及末尾声明 `used` 采用反馈。反馈只记录实际采用，不是质量评分；Phoenix 评分接入后置。操作、预算和升级边界见[记忆读取](docs/memory-retrieval.md)。

## 模块与运行模式

生产代码分为 `packages/flow`（原生流程 Skill 与历史任务兼容代码）、`packages/memo`（声明契约、存储、队列、历史 DSH Agent）、`packages/codex-hooks`（Hook 适配与来源绑定）、`packages/cli`（命令和进程编排）。根 `bin/jth.ts` 保持稳定。

默认使用主会话声明：安装项目 `jth-memo` Skill，`UserPromptSubmit` 注入短入口，Agent 按需读取规则并在有值得保留的结论时输出最多三条短声明。Stop Hook 保存事件，后台 `memo work` 绑定原始证据、精确去重并生成向量。没有声明就不调用 Embedding；Hook 不等待后台处理。

用户以“可以，你做吧”等短回复采纳前文方案时，主会话保留已确认决策，并在收口时用 `user_confirmed` 声明；`quote` 与 `confirmation_quote` 分别绑定助手方案和后续用户确认。后台校验来源角色及顺序，语义关联仍由主会话核对。未确认方案可作为候选保存，批准实施不代表已经完成。详见 [声明契约](docs/memory-declarations.md)。

数据库使用 schema v8，在 v7 声明回执和来源关联之上增加采用记录，保留所有历史数据。`memo work` 与 `memo work --index` 处理声明和索引队列；只有显式 `memo work --legacy` 才处理旧 DSH 队列。失败任务仍需显式 retry，不自动重跑旧失败记录。

会话内 `prepare / evidence / record` 保留为手动工具，默认声明流程不需要调用。`record` 只启动 index worker。协议、流程图与实测见 [主会话记忆声明](docs/memory-declarations.md)。

## Codex 原生流程

在需要使用的项目运行一次，项目 ID 与已有 Memo 范围保持一致：

```sh
jth flow install --project jt-harness
jth flow status
```

安装保留 Memo Stop 声明入口，链接项目 `jth-flow` 和 `jth-memo` Skill，增加 `UserPromptSubmit` 短入口，并移除旧 Flow 的七阶段注入 Hook。不会连接或初始化 `jt_flow`，不会创建第二份任务列表。`status/context` 只读取本地安装配置、最近一次入口输出与 Memo 范围，不返回旧目标、阶段或缓存记忆。入口记录位于 `.jth/flow-entry.json`，不保存用户正文；实际任务完成仍需主 Agent 核对交付和验收证据。

Workflow Policy 默认 adaptive：普通问答直接回答，有界小改直接执行并做聚焦验证；多阶段或明确要求规划时走 planned，受信任入口明确要求主 Agent 启动或复用一个 Codex 原生 Goal，并用 `update_plan` 记录进度。用户明确停用 Goal 时不创建。`jth flow policy` 分别准备 Goal 和计划参数，不调用原生工具或保存任务；`plan.goal` 只是文本，更新计划不会自动启动 Goal。用户确认、补充及恢复沿用同一目标。工具未暴露时说明具体缺失，不伪造原生状态。配置与调用约定见 [Workflow Policy](docs/workflow-policy.md)。

检查点复用原生计划、会话记录、必要的证据文件与 Git 提交。主 Agent 直接运行项目检查并核对产出，通过后更新计划和 Goal；不为每次工具调用复制一份流程日志。权限、会话恢复和压缩使用 Codex 自带机制。

通过 `flow status` 查看 `memo_scope`。Memo 在启动/恢复后的首次输入提供有限关键词线索；同一会话的新任务由主 Agent 主动 `recall`，需要时 `search` 深查、`read --level evidence` 展开。Flow 不运行旧自动召回循环；线索不读取旧任务或调用模型。主会话末尾短声明的后台存储与 Embedding 保持独立。

历史 PostgreSQL 任务、绑定、回执和 SQLite 迁移材料不删除；显式使用：

```sh
jth flow legacy status --all
jth flow legacy status --task <旧任务ID> --history
jth flow legacy migrate
```

旧版本已经加载的 `flow hook`、`flow sync` 和后台 `flow recall --request` 入口会安静跳过，不重放历史事件或启动旧任务召回。`jth flow uninstall` 移除 Flow Skill，Memo 和历史数据保留。详细说明见 [原生流程与验证](docs/flow-control.md)；旧运行器见 [历史 Flow](docs/flow-legacy.md)。

## 当前本机使用

工具本体可通过 npm 包 `@jacob-z/jt-harness` 或独立发行包安装；命令位置由安装方式决定，用 `command -v jth` 确认。共享配置默认位于 `~/.jt-harness/.env`，项目可显式选择覆盖配置。安装、版本更新与项目同步见[本地交付](docs/local-delivery-monitoring.md)。

```sh
jth --help
jth memo codex status
jth memo status --summary
jth memo search '这个项目如何使用 CLI？' --project jth-cli-verification
jth memo read <entry-id>
jth memo work
```

`memo codex status` 查看声明待投递数量和本地诊断，`memo status` 查看索引任务。`queued` 表示已接收，`complete` 且具有 `index_receipt_id` 表示处理完成。重复声明可以直接复用已有条目，不新增索引任务；详情及新增来源通过 `memo read` 查看。当前仓库采用 Memo Stop Hook 与原生流程 Skill；旧 Flow 生命周期 Hook 已退出默认路径。Memo 自动执行以 Codex 加载并信任定义为准，后台只处理声明与向量索引。

### 历史 DSH 路径：按条目接收与输出留存

本节仅适用于显式 `--legacy` 的会话提炼及旧任务恢复，不参与默认声明流程。

DSH 使用独立的模型材料视图，数据库继续保留完整来源。用户和助手消息保持原文；长工具结果只提供元数据与首尾原文片段，单条最多 1,200 个 Unicode 字符、每批最多 8,000 个工具正文字符，优先保留最近结果，并明确标记省略数量。工具中段的独有事实可能需要回查来源，不把这个压缩视图当成完整日志。

关系比较只提供被新事实/修订引用的消息、新旧事实的必要字段与相关冲突，不重复发送整批 submission 和新事实正文。向量召回保留每个查询 top 5，同时要求余弦相似度至少 0.5，合并最多 24 条；模型侧旧事实再按 24,000 字节预算选择整条事实，不截断事实含义。候选不足不代表数据库没有其他冲突。这些预算是模型输入约束，不修改模型的 effort 或输出上限。

固定规则放在 system prompt；模型材料按明确顺序构造，来源 ID 等动态元数据放在语义内容之后，旧候选选定后按 ID 稳定排序。每次返回的 DSH 输出附带 `run.usage`（实际输入、缓存命中、输出与请求数），以及 `source_bytes / input_bytes / system_prompt_bytes`。`jth memo outputs <id>` 可查看每次尝试，计算总命中率应汇总所有尝试后用命中 token 除以输入 token；没有 usage 不代表零消耗。

手动验证两条独立用例，不安装 Hook、不读取生产队列：

```sh
node scripts/test-postgres.mjs --memory-live --env-file /absolute/path/to/.env
```

该命令调用真实 DSH 与 Embedding API，在隔离 PostgreSQL 中验证更正和冲突，随后清理测试数据库；报告保存在 `artifacts/memo-inputs/`。运行结果见 [输入优化验证](docs/memory-input-optimization-verification.md)。普通 `pnpm test:postgres` 不调用真实模型。

提炼不再要求实体名称逐字出现在原文、不强制每条引用新增消息、不按来源角色或确认顺序拒收模型分类。原始消息、角色和顺序保持原样。Agent 判断语义；程序仍校验 JSON、真实引用 ID、项目范围、有效期证据和关联事务。

小的格式差异会规范化：实体去空和去重、重复来源 ID 去重、未提供的可选元数据保留为空。未知辅助字段留在原始模型输出中，不进入规范条目。无法接收的独立条目保存 `path/error/value`，其他有效条目继续生成向量、发布。无效关系不修改旧事实，也不把已经通过提炼检查的正文重新降级；它作为未应用的关系保留诊断，不冒充更正成功。

队列 `partial` 表示有未接收条目或未应用关系，不等于 DSH 调用失败，也不保证至少有一条成功；结合 `entry_count`、`issue_count` 查看。全部条目不合规时也会保留原始输出并明确报告，不会冒充“没有值得记忆”的正常空结果。`failed` 继续用于整体 JSON 无法读取、模型/网络调用或数据库等执行问题。

```sh
jth memo status <submission-id>          # 条目数、问题路径、原始输出数量
jth memo read --submission <id>          # 已接收结果及未接收条目的完整数据
jth memo outputs <submission-id>         # 原始模型返回，含 JSON 修复前后的每次尝试
```

从 v5 起，DSH 已返回的响应在业务解析前写入 `jt_memo.agent_outputs`；因 token 上限停止时，SDK 已返回的片段也会保留并标明执行错误。因此后来发生条目校验或 Embedding 错误，不会丢失第一次返回。旧版本没有留存的模型输出不能凭空恢复；原会话仍可重跑。基础设施失败使用 `retry`，复用已保存的提炼检查点。v6 在 retry 时将原失败原因保存在 `jobs.failure_history`。

`memo model` 的选择只影响新 DSH 提交。需要让某个旧失败任务改用新 Provider/model 时，显式运行 `jth memo retry <id> --legacy --provider <id> --model <id>`；两个选项必须一起提供。原执行配置保存在 `failure_history[].agent`，来源、已保存的提炼、Embedding 空间和其他执行选项不变。普通 retry 继续沿用任务快照；不为重试设置 effort 或输出 token 上限。纯索引任务不接受模型覆盖。

`partial` 使用按条恢复，保留原有正文、向量、模型输出和回执。先查看原材料与诊断，主 Agent 或调用者据此提供修正文件，不会自动请求模型重写整批：

```sh
jth memo recover <id>                 # 返回 issue 的 path/error/value 及现有恢复记录
jth memo read --submission <id>       # 核对引用原文和已接收内容
jth memo recover <id> corrections.json
```

文件是数组；每项是 `{ "path": "memories[2]", "action": "replace", "reason": "修正依据", "value": { ...完整修正条目 } }`，或 `{ "path": "relations[0]", "action": "dismiss", "reason": "原关系已过时，当前证据不支持应用" }`。整个集合格式错误时，原 path 为集合名，value 使用修正后的数组。`dismiss` 只记录不采纳的原因，不删除原错误内容。

修正的提炼条目产生独立后续批次，保留原接收时间，复用原执行配置并跳过再次提炼；显式运行 `memo work --legacy` 后为新增正文生成向量、比较关系。关系修正复用既有正文与向量，在原发布事务规则下追加；引用已失效事实时拒绝应用，避免旧关系回退当前状态。同一路径的相同请求幂等，不同请求不能覆盖恢复回执。后续批次失败仍用其 ID `retry --legacy`。

`recover` 返回 `unresolved_count`；后续批次尚未完成或关系仍需审核时不会报已解决。原任务继续显示历史 `partial`，`status` 的 `recoveries` 和 `jt_memo.intake_recoveries` 记录处理结果，不将有错误的历史运行改写为一次干净成功。

本机开发库位于 `~/.jth/postgres`。`jth` 使用 `~/.jth/run` 私有 Unix socket；图形客户端使用仅监听本机的 `127.0.0.1:5432`。在 `.env` 明确配置 `JTH_PG_DATA_DIR` 和 `JTH_PG_BIN_DIR` 后，数据库访问会复用运行实例或按需启动它；电脑重启后的第一次访问也适用。没有增加开机常驻服务，PG 启动后不随单次 CLI 退出而关闭。

```sh
jth db status
jth db start
jth db stop
```

`status` 只观察，不启动；`stop` 关闭明确配置的本机实例，活动事务回滚，数据保留。停止前应先完成正在执行的任务；以后需要数据库的命令会再次启动它，`jth memo work` 恢复未完成队列。启动管理复用 `pg_ctl`，不重复安装、初始化或升级已有 PG；没有配置托管目录的外部实例只连接，不启停。移除 CLI 软链可运行 `unlink "$HOME/.local/bin/jth"`；该操作不删除配置或记忆数据库。

显式使用 DSH 时，Web/桌面是否打开不影响提炼：SDK 自行启动并关闭 `sdk-minimal` 子进程。`jth memo status --summary` 显示队列计数与失败原因。旧 DSH failed 任务用 `memo retry <id> --legacy` 恢复，已存提炼直接从后续阶段继续。

### DataGrip / Navicat 查看数据

新建 PostgreSQL 连接，填写下面的信息。该连接账号仅用于查看数据，记忆写入继续由 `jth` 管理。

| 字段 | 值 |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `5432` |
| Database | `jth` |
| User | `jth_viewer` |
| Password | 本机 `~/.jth/gui-connection.env` 中的 `PGPASSWORD` |
| Schema | `jt_memo` |
| SSL | 关闭；连接仅限本机回环地址 |

密码文件权限为 0600，保存在工作区之外。不要将密码复制进项目文档或 JDBC URL。DataGrip 可使用 `jdbc:postgresql://127.0.0.1:5432/jth`，用户名和密码填写在各自输入框；在 Schemas 中勾选 `jt_memo` 后即可浏览表。

`entries` 是记忆正文，`embeddings` 是向量，`jobs` 是任务状态。客户端查询中可用 `embedding::text` 查看向量的数值列表。

本机已验证密码认证、表与向量可读、写操作拒绝。`entry_states` 视图展示每条记忆的当前状态，`entry_relations` 保存更正、补充和冲突关系；`entries` 保留全部历史正文。监听地址通过 PostgreSQL 原生 `ALTER SYSTEM` 配置；账号拥有当前表的 SELECT 权限，并自动获得 `jacobzha` 后续在 `jt_memo` 中创建的表的 SELECT 权限。

## 本地源码运行与配置

Codex 工作树使用 `.codex/environments/environment.toml` 中的 `jt-harness` 本地环境。参考已有项目的 setup 模式，创建工作树时执行 `bun scripts/setup-worktree.ts`；已经存在或手动创建的工作树运行 `pnpm setup:worktree`。

设置脚本从 Git 找到主工作区，复用主安装的项目/业务范围和已选配置（通常为用户目录 `.env`），为当前工作树单独安装依赖，并重新生成 Memo/Flow Hook、`.jth/flow.json` 和项目 Skill 链接。不会复制主工作区绑定了绝对路径的 Hook 或任务状态；Flow 任务按工作区隔离，长期记忆按相同项目范围共享。新 Hook 定义仍遵守 Codex 的信任机制。

工作树 `.env` 链接到主配置，密钥更新立即共享，不提交 Git；相对运行路径以源配置所在目录解析。仓库现有 `link:../deepseek-harness` 依赖通过相邻目录链接复用主工作区的 DSH 源码，工作树自身的 `node_modules` 保持独立。若目标位置已有不同配置或依赖目录，脚本保留原文件并报告冲突，不覆盖。主工作区需要先完成依赖安装与 `jth flow install`，作为可用的配置来源。

JTH 命令使用 Bun ≥ 1.3.14 直接运行 TypeScript 源码，不需要构建。源码开发的 pnpm 与检查脚本另需 Node.js ≥ 24.21.0、pnpm 10；开发工具及可选 DSH SDK 仍链接到相邻 `../deepseek-harness` 工作区。普通使用者安装 npm 包或独立发行包即可，默认 Flow/Memo 不依赖该源码目录。发行包不捆绑显式 legacy 路径需要的 DSH SDK。

```sh
pnpm install --frozen-lockfile
bun bin/jth.ts --help
# 问卷补齐共享配置，自动建表并接入当前项目。
bun -- bin/jth.ts init
```

`init` 自动调用现有建表与迁移逻辑，创建 `jt_memo` schema 和 `vector` 扩展，或将支持的旧版本事务性升级到 v8，保留原材料、条目、向量与回执。高级手动入口 `memo init` 继续保留。v8 只在 v7 上增加采用记录，不重写旧正文或哈希。本版使用 PostgreSQL 15+ 的约束能力，本机验证版本为 18.6。命令不安装 PostgreSQL 或创建数据库实例；配置本机托管后会按需启动既有实例，连接用户需要建表、扩展权限，未知版本会被拒绝。

仓库公开托管于 [JacobZyy/jt-harness](https://github.com/JacobZyy/jt-harness)，npm 包为 `@jacob-z/jt-harness`。`.gitignore` 忽略 `.env` 和 `.env.*`，仅允许无凭据的 `.env.example`。用户凭据独立于仓库和发行目录；打包白名单不包含凭据、数据库、运行记录或本地备份。

配置文件按 `--env-file`、`JTH_ENV_FILE`、仓库绑定、用户默认 `~/.jt-harness/.env` 的顺序选择，不自动读取业务项目当前目录中的同名文件。选定后，进程环境变量覆盖文件值。配置内的相对目录、DSH 入口路径以配置文件所在目录为基准。环境变量不会写回文件，文件内容也不会整体导出给 DSH。详见[配置来源与迁移](docs/configuration.md)。

| 配置 | 用途 |
| --- | --- |
| `JTH_DATABASE_URL` | PostgreSQL 连接地址，必须配置 |
| `JTH_PG_DATA_DIR` / `JTH_PG_BIN_DIR` | 可选本机托管实例目录与原生 PG 工具目录；配置后按需启动，只允许本地地址或 socket |
| `EMBEDDING_BASE_URL` | OpenAI-compatible API 根地址，以 `/v1` 结尾；CLI 添加 `/embeddings` |
| `EMBEDDING_API_KEY` | API 密钥，只在调用 Embedding 时使用 |
| `EMBEDDING_MODEL` | 本机配置为 `qwen3.7-text-embedding-flash` |
| `EMBEDDING_DIMENSIONS` | 默认 1024 |
| `EMBEDDING_TIMEOUT_MS` | 单次调用超时，默认 60000 ms |
| `JTH_DSH_PROVIDER` / `JTH_DSH_MODEL` | 默认读取 `packages/memo/src/agents/runtime.json` |
| `JTH_DSH_TIMEOUT_MS` | 当前运行配置为 600000 ms，可按模型延迟调整 |
| `JTH_DSH_BIN` / `JTH_DSH_HOME` | 可选 DSH JS 入口及 DSH 配置目录 |
| `JTH_DATA_DIR` | 默认 `~/.jth`，存放 worker 日志和 Agent 工作目录 |

DSH 模型密钥继续由现有 DSH credentials/settings 管理，不复制进本项目。DSH 子进程继承调用者网络代理环境；如本机代理影响模型服务，可按实际网络配置 `NO_PROXY`，不修改全局代理。

## 历史 DSH 指令和输入契约

`send --legacy` 支持 JSON 文件和 stdin；没有显式 `--legacy` 时拒绝启动 DSH。输入格式见 `examples/conversation.json`：`submission_id` 必须稳定，消息必须有稳定、唯一的 `message_id`。同一 ID、同一材料重复投递返回原任务；同一 ID、不同材料报冲突。新增会话增量使用新 ID，保留足够上下文。

```sh
cat examples/conversation.json | jth memo send - --legacy
jth memo send examples/conversation.json --legacy --wait
jth memo send new-conversation.json --legacy --provider deepseek-official --model deepseek-v4-flash
jth memo status
jth memo status --summary
jth memo outputs <submission-id>
jth memo retry <failed-submission-id> --legacy
# 为已经失败、仍保存旧预算的任务显式延长 Agent 时间预算：
jth memo retry <failed-submission-id> --legacy --timeout-ms 600000
jth memo work --legacy
```

`--wait` 适合手动联调，会等待队列处理。默认 Codex 入口使用下方声明适配器，不调用 DSH。

任务接收时会保存执行配置。调整 `.env` 的 `JTH_DSH_TIMEOUT_MS` 只影响新任务；已有失败任务可通过 `retry --timeout-ms` 显式覆盖时间预算。该选项不改变原文、模型、Embedding 空间或已保存的提炼检查点。Agent 执行错误现在携带 DSH session ID，可用于关联 DSH 中的请求轨迹。

## Codex 自动投递

在需要开启记忆采集的项目中执行安装命令。项目 ID 由调用者明确指定；多个项目共享业务知识时可以额外指定 `--business`。

```sh
jth memo codex install --project jt-harness
jth memo codex status
jth memo work
# 关闭当前项目的自动采集，保留已经接收的材料和记忆：
jth memo codex uninstall
```

`--workspace /absolute/project/path` 可以安装到其他项目。安装管理该项目 `.codex/hooks.json` 中的 Memo 声明和线索 Hook，以及 `.agents/skills/jth-memo` 链接。升级时移除 `AGENTS.md` 中旧的 `JTH_MEMORY_START/END` 区块，保留其他说明并备份原文到 `~/.jth/codex/backups/`。重复安装不会重复注册；卸载移除受管 Hook 和 Skill。Codex 的 Hook 信任机制保持不变。

Memo 安装 `Stop` 声明入口，以及 `SessionStart` / `UserPromptSubmit` 有限线索入口。重新安装会替换本工具原来的六阶段捕获定义。子 Agent 不直接提交记忆，由主 Agent 核对后声明；原生 Flow 另用 `UserPromptSubmit` 注入短流程提示，不恢复旧任务生命周期 Hook。

Hook 检查本轮最终回复，只保存含声明的本地交接记录并启动独立 worker，超时为 3 秒。Hook 内不连接数据库、不调用模型、不等待 Embedding。来源以硬链接保留，文件边界和原始位置一并记录；声明解析和引文匹配在后台本地执行。只有新记忆正文发送到 Embedding API。

Agent 在正常回复末尾按固定格式输出最多三条事实声明，正文合计最多 500 字符，每条附最多 240 字符的原文短引文。来源 ID、时间、存储字段与已读取的旧条目版本由程序补齐。实际采用的已读 ID 可放入 `used`；没有新结论时允许 `items: []` 只提交反馈，反馈本身不生成向量。没有新事实或采用反馈就不输出声明。代码块中的格式示例不会被当成记忆执行。

`~/.jth/codex/` 保存交接记录、来源硬链接、证据、声明回执、读取版本和安装备份。JSON 文件权限为 0600，目录为 0700；硬链接继承原文件权限。解析异常保存在 `declaration-errors/`，通过 `memo codex status` 查看，不阻塞回复，不调用模型修复。数据库尚未接收的有效声明留在 `records/`，恢复数据库后用 `memo work` 继续投递。

重复 Stop 幂等；同范围、同资格、同有效期的精确重复正文复用已有条目和向量，新增来源通过 `declaration_sources` 关联。更正先 `memo read <旧ID>`，主 Agent 在声明中明确目标及关系；程序复用原有版本、冲突和发布事务，不另起比较 Agent。

查看投递和诊断用 `jth memo codex status`，查看索引任务用 `jth memo status`，查看正文、来源与修订用 `jth memo read <id>`。Embedding 失败后执行 `jth memo retry <submission-id>`，只重试索引，不重新提炼。旧 DSH 队列保留，默认 worker 不消费。

当前协议及验收见 [主会话记忆声明](docs/memory-declarations.md)；此前六阶段采集记录见 [历史 Codex Hook 验证报告](docs/codex-hooks-verification.md)。

Agent 模型、向量空间和原材料在接收时固定；重复提交不会悄悄换模型。凭据在处理时从对应 `.env` 重新读取，支持修复或轮换密钥。改变模型、维度或 Embedding 地址会产生不同向量空间；未完成任务必须恢复原配置后重试。本版本没有全库重建索引命令。

`status` 列出状态计数与最近 20 个任务；指定 ID 后显示尝试次数、错误、提炼和比较两个阶段的 DSH session ID、索引提交回执及直接修订数量。`read --submission` 可以查看完整提炼结果和修订证据。

`search` 必须显式指定一种范围，默认混合检索，3 条、最多 50 条；只输出 400 字符以内的正文预览及匹配依据，不返回向量。`recall` 只用本地关键词。`read --level evidence` 给出有界证据片段，`--level full` 保留完整原文；默认 full 兼容旧输出。

默认搜索只返回已入库、当前有效、未归档且具有可用来源资格的条目。`state` 区分 `pending/active/conflicted/superseded/scheduled/expired`，`claim_status` 区分来源和审核资格，`archived` 单独表示归档。`--history` 包含被更正、过期、未生效的条目；`--candidates` 包含待审条目（兼容原 `--proposals`）；`--archived` 包含归档。被拒绝的条目仍可按 ID 读取，不进入默认或候选搜索。

`read` 保留原文、双方证据和审核/归档日志，关系与动作各最多 100 条并注明是否截断。DataGrip 中可查看 `entry_states`、`entry_relations`、`entry_actions`。

```sh
jth memo search '接口约定' --project project-a
jth memo search '共同约定' --project project-a --project project-b
jth memo search '发货状态' --business shipping
jth memo search '本次任务' --session codex-session-id
jth memo search '个人偏好' --user
jth memo search '范围未明确的信息' --submission submission-id
jth memo search '尚未确认的建议' --project project-a --proposals --limit 5
jth memo search '已经更正的旧约定' --project project-a --history
jth memo search '当时的接口约定' --project project-a --as-of '2026-09-16T12:00:00+08:00'
```

## 事实粒度、时间与审核

每条声明表达一个可独立更正的结论，并保留限定条件。程序绑定原文短引文与真实消息，复用现有范围、版本和发布事务；语义判断由主 Agent 完成，不要求主 Agent 重复输出整套存储字段，原有条目不会被静默拆写。

每条输入消息可带 `occurred_at`（带时区的 ISO 8601）；已提供的时间必须与消息顺序一致。只有全部引用消息都有时间，才保存其最后时间为 `source_occurred_at`；缺失时保持 null。`received_at` 是持久化接收时间，`stored_at` 是提炼检查点时间，`published_at` 是向量发布时刻。`valid_from/valid_until` 来自明确的时间原文，未知时为 null，不用今天补齐。

`search/read --as-of` 重现指定时刻已记录、已发布及已生效的状态，同时考虑当时的审核、归档和替代关系。它不会把今天才生成的提炼结果泄露进过去的快照。未来时刻查询仅基于当前已记录的有效期，不代表未来必然发生。

旧材料晚到、较早任务重试晚完成、缺失可比较来源时间、过期材料或未来生效的自动更正，会转入待审并写明原因，旧事实保持有效。未来更正不会由后台定时自动作废旧事实。审核确认只是认可条目，不会偷偷执行原先被拦截的替代计划；存在相反说法时保留冲突，继续通过明确更正裁决。

| claim_status | 含义 |
| --- | --- |
| `asserted` | 用户直接陈述 |
| `observed` | 工具观察，保留观测局限 |
| `verified` | 用户明确确认，或本机 CLI 审核确认 |
| `candidate` | 助手建议、推断、显式待审材料或被时间规则拦截的自动更正 |
| `rejected` | 本机 CLI 明确拒绝 |

这些是来源和审核状态，不是程序对客观真假的保证。模型输出不能设置审核状态，DSH 运行器没有审核工具；操作记录中的 actor 是实际数据库账号，origin 区分本机 CLI 与运行时。本版面向个人本机，不提供多用户身份认证。

```sh
jth memo send conversation.json --legacy --review
jth memo review list
jth memo read <entry-id>
jth memo review approve <entry-id> --reason '已核对实际配置' --evidence 'docs/decision.md#api'
jth memo review reject <entry-id> --reason '该建议未采用'
```

确认必须提供理由和依据引用；引用由操作者提供，不自动联网核验。所有决定追加到 `entry_actions`，不改写原始正文或 `basis`。确认已被替代的历史条目不会使其重新成为当前版本。

## 体检、容量与归档

```sh
jth memo doctor
jth memo stats
jth memo archive <entry-id> --reason '暂时移出活跃记忆'
jth memo archive --session <session-id> --reason '该任务已结束'
jth memo archives
jth memo restore <entry-id> --reason '继续处理这条记忆'
```

`doctor` 在只读一致性快照内检查来源契约、正文及向量哈希、数量、维度、完成回执、关系范围/证据和版本循环。错误退出码为 1；旧数据缺少来源时间等警告不会伪装成损坏，也不会自动修复或删除数据。

`stats` 显示按范围、生命周期、审核和归档状态分组的数量，以及各表含索引/TOAST 的物理大小。按会话归档只影响 `current_task`，不会顺带归档该会话产生的长期项目规则。不会根据记录年龄自行推断任务结束。

归档是可恢复的可见性变更，保留原文、来源、向量与全部关系，不释放物理空间。恢复归档不撤销拒绝、失效或更正状态。数据增长后的冷存储导出和物理清理仍需独立设计。

所有命令返回 JSON。错误写入 stderr，退出码为 1。`send` 若已落库但无法启动后台进程，仍返回包含 `submission_id` 的回执、`worker.started: false` 和恢复指令；材料不会丢失，也不会被误报为已完成。

## 持久化与恢复边界

- PostgreSQL 同时持有记忆处理队列与记忆数据，不另设队列服务器或本地状态数据库。Codex 适配器的本地文件仅负责数据库接收之前的交接、来源保留和增量进度。
- 后台进程串行消费同一库，队列空后退出。数据库 session advisory lock 防止并发消费，锁与全部写入共用同一连接；连接失效后旧进程无法继续提交。
- 声明落库与索引任务在同一事务中保存。Embedding 失败后 `retry` 复用该结果，不调用 Agent。
- 整批向量、向量空间与索引回执在同一事务内提交；提交失败全部回滚。已提交索引但未更新任务状态的中断，可恢复为完成，不重复嵌入。
- 零候选同样生成 `noop` 提交回执。失败不会无限自动重试；修复原因后显式 `retry`。
- 异常退出后，下一次声明唤醒的 worker 或手动 `memo work` 会恢复遗留索引 `running` 任务。旧 DSH 队列需要显式 `--legacy`。没有常驻守护进程，因此整机重启不会自动唤醒队列。
- 当前 API 实测批量响应重复返回 `index: 0`，无法安全据此绑定来源。本版本逐条调用 Embedding 并校验模型、数量、序号、1024 维及 float32 有限非零值，不猜测批量响应顺序。
- 默认由主 Agent 根据召回/读取的旧记忆声明更正、补充和冲突；程序校验实际版本、来源、范围与时间，再与向量一起发布。仅显式旧 DSH 路径保留独立比较阶段。
- 更正建立替代关系，旧正文和来源保留，默认查询隐藏旧版本；补充保留双方并关联；冲突保留双方依据并标记 `conflicted`。Agent 根据来源语义判断更正，程序保留真实 ID、同范围、有效引文和事务约束，不再用角色组合代替判断；时间更新或相似度更高都不是替代依据。
- 仅更新冲突一方时，未决争议会跟随新版本保留。明确裁决双方时才解除冲突。若新批次只产生 conflict revision，也能把该证据关联到既有记忆；没有命中旧记忆的批内冲突仍保存在批次证据中，通过 `read --submission` 查看。
- 程序只合并精确重复正文。语义改写或更正通过显式关系处理，不按相似度直接覆盖旧事实。
- 暂无 ANN、全库同义去重或跨空间重建索引。方案参考和后续清单见 [Rex 记忆机制参考](docs/rex-memory-reference.md)。
- 多项目/多业务输入尚未细分每条记忆的独立范围，所以采取保守匹配：涉及 A、B 的记录只在查询同时包含 A、B 时返回，单独查 A 不混入 B。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm test:postgres
```

默认测试不调用真实模型或 Embedding。PostgreSQL 测试启动独立临时数据库并在结束时关闭、删除；需要 PostgreSQL + pgvector。macOS 默认使用 `/opt/homebrew/opt/postgresql@18/bin`，其他安装位置通过 `PG_BIN` 指定。

当前声明模式及真实 Embedding 证据见 [声明验证记录](docs/memory-declarations.md)。历史 DSH 交付见 [交付验证报告](docs/jth-delivery-verification.md) 和 [原记忆系统设计](docs/memory-plugin-technical-design.md)。

修订功能验证见 [三条规则验证报告](docs/memory-revisions-verification.md)。手动运行 `node scripts/verify-revisions.ts --live` 会使用真实模型/API，在独立测试项目中验证新增、更正、补充、冲突和裁决；`DSH_RECONCILE_LIVE=1 node --test packages/memo/src/agents/reconcile.test.ts` 验证没有明确更正时不得覆盖旧事实。

v3 五项存储能力及真实 CLI 验证见 [存储增强验证报告](docs/memory-storage-v3-verification.md)。`node scripts/verify-storage-v3.ts --live` 会调用真实 DSH/Embedding，在独立测试项目中验证原子提炼、时间窗口、候选审核、归档恢复与体检。

此前恢复 DSH 默认流程的历史验收见 [恢复记录](docs/dsh-restore-verification.md)，当前默认入口已改为声明模式。

此前强制关闭思考的历史实验见 [配置同步报告](docs/dsh-thinking-off-verification.md)，已撤销该配置。

## 交互切换历史 DSH Agent 模型

运行 `jth memo model`，使用方向键从 DSH 实时目录中单选模型；直接输入可搜索模型名称、ID 或 Provider，空格分隔多个关键词。列表分页显示并标注当前项，回车确认，Ctrl+C 取消。`jth memo model --list` 输出 JSON；也可用 `jth memo model --provider zz-tokenhub --model deepseek-flash` 精确选择。

选择只保存当前选定配置文件中的 Provider 和模型，默认文件为 `~/.jt-harness/.env`，不影响声明模式。DSH 执行器不指定 reasoningEffort 或 maxTokens，也不修改 Provider 的能力声明；全部采用 DSH/Provider 默认行为。任务超时仍由本工具管理。配置冲突或取消选择不会覆盖文件，已有凭据和其他配置保持原样。

模型发现复用独立 DSH SDK 进程中的 llm.listProviders/listModels；只读目录插件补充 SDK 缺少的目录端点，不调用模型、不依赖浏览器或 Web 服务。只在选择时查询目录，正常提取没有额外目录查询进程。

旧队列的 Provider/model 快照不改写、不批量重跑；历史 effort/maxTokens 字段仅用于读取旧记录，不再被执行器转发。
