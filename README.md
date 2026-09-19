# jt-harness · jth

`jth` 是本地 TypeScript CLI，提供长任务流程控制与长期记忆。`jth flow` 用 Skill、Codex Hook 和持久任务状态保持目标、阶段与恢复点；`jth memo` 通过 DSH SDK 提炼会话，再调用 Embedding API，将候选记忆和来源保存在 PostgreSQL + pgvector。

本版本直接在进程内调用业务模块，不提供 HTTP 服务，不依赖 `jt-cli`。DSH SDK 启动自己的本地子进程，通过 stdio 通信，不调用 3080 Web 接口。

## 模块与运行模式

生产代码分为 `packages/flow`（任务状态、上下文、验收和 Skill）、`packages/memo`（DSH Agent、存储、队列）、`packages/codex-hooks`（Hook 适配与增量来源采集）、`packages/cli`（命令和进程编排）。根 `bin/jth.mjs` 保持稳定。

默认恢复 DSH：Hook 保存事件，后台 `memo work` 收集增量会话，交给 DSH 提炼及关系比较，再生成向量并发布。Hook 不等待模型。SessionStart 不再注入会话内提取说明；已有会话中的旧说明需恢复会话后刷新。

数据库使用 schema v6，并保留所有已有记录。表中的 `kind=legacy` 是 DSH 队列的历史字段名，不代表当前停用。`memo work --legacy` 与默认 DSH 路径兼容；`memo work --index` 仅恢复先前手动 record 的索引任务。失败任务仍需显式 retry，不自动重跑旧失败记录。

会话内 `prepare / evidence / record` 保留为手动工具，不再由 Hook 指示 Agent 自动调用。`record` 自己启动 index worker，不会额外进入 DSH。

## 轻量流程控制

在需要使用的 Git 项目里运行，`--project` 与该项目已有 Memo 安装保持一致：

```sh
jth flow install --project jt-harness
# 在 Codex /hooks 审阅并信任本工具新增的定义，再恢复会话。
jth flow start '交付本次明确目标' --phase execution --accept '可检查的完成条件' --check 'pnpm test'
jth flow focus '追踪关键调用路径' --accept 1 --read packages --expect '调用位置及对应证据'
# 使用 focus 返回的 work.id；每个工作单元可包含多次工具调用。
jth flow checkpoint --work-id '<work.id>' --outcome progress --done '已确认关键调用路径' --evidence 'packages/flow/src/store.ts' --next '完成实现与验证'
jth flow status
jth flow verify
jth flow finish --summary '达成目标的结果'
```

Codex 中这些命令由 `jth-flow` Skill 在长任务需要时调用，日常简短问答不要求建任务。新增约束用 `checkpoint --constraint`；只有用户明确改变目标才用 `revise ... --reason ...`。`start` 默认处于 discussion；用户已授权实施时指定 execution。SessionStart（含 compact）、UserPromptSubmit 和 SubagentStart 注入目标与少量上下文；Stop、Interrupt、SessionEnd、SubagentStop 只记录活动，不自动判定完成。

新会话使用 `jth flow status --all` 选择原任务，`jth flow resume <id>` 恢复；旧会话仍占有主控时显式加 `--takeover`。子 Agent 只能读取主任务状态。终端不带 Codex 会话 ID 时，用 `--task <id>` 指定操作对象，或 `--session <id>` 明确绑定。

用户明确切换到独立目标时，用 `jth flow pause --reason '切换依据'` 解除当前绑定，再 start 新任务。暂停保留旧任务，不假装完成；恢复时仍用 resume。

长任务可以在 `start` 或 `checkpoint` 使用重复的 `--step '阶段交付'` 保存有序计划。工作结果回执加 `--complete-step 1` 完成当前阶段。Hook 注入当前单元、计划、最近回执与下一步；恢复时继续未回执的单元，全部阶段完成后仍需总体验收。用户明确要求启用 Codex Goal 且宿主提供原生 Goal 工具时，主 Agent 保持一个总 Goal，由 Flow 保存阶段与证据；`flow finish` 后才完成原生 Goal。CLI 不依赖私有 App API，也不另起自动续跑循环。

`focus` 的 `--accept` 使用验收条件的顺序编号，`--read` 是项目内读取范围，`--expect` 是预期产出。一个任务同时只有一个未回执单元。回执支持 `progress / failed / no-progress / blocked`，保存实际结果、证据、下一步和阻塞；同一 ID 重试不重复累计。相同阶段与目标版本下，连续两次失败或无进展且没有新证据/新假设时，下一单元需要不同的 `--hypothesis`，或记录实际阻塞。Hook 活动和普通问答不参与计数。证据语义与读取必要性由主 Agent 判断，程序不把字符串变更当作已证明业务进展。

开始、恢复和输入时的记忆召回由短生命周期后台子进程完成。Flow Hook 对 PostgreSQL 做短时读取，不等待数据库冷启动、模型或 Embedding。数据库离线时先保存本地事件，后台准备数据库并重放；不能把缺少注入当成没有任务。结果按已配置项目、业务和用户范围检索，缓存 5 分钟，最多注入 5 条简短摘要；用 `jth flow recall` 立即刷新，用 `jth memo read <id>` 获取证据和冲突双方。长期写入继续沿用原有六阶段捕获与 DSH 队列。

任务状态统一在 PostgreSQL 的 `jt_flow` schema，按 workspace 隔离。`.jth/flow.json` 只保存配置定位；验收日志在 `.jth/checks/`，召回日志在 `.jth/recall.log`，离线事件在 `.jth/flow-events/`，均不入 Git。旧安装运行 `jth flow migrate`：先备份 SQLite，事务性迁入任务、绑定和历史，成功后切换配置定位；原文件保留且不再作为运行存储。`jth flow uninstall` 只移除流程 Hook 和 Skill 链接，保留任务及 Memo 捕获。

验收命令是当前任务明确记录的本地 shell 命令，具有调用者权限。只配置原本就允许执行的项目检查。完成需要当前目标版本的通过结果、未变化的文件快照、已解决的待讨论问题；文档型实施任务可提供 `--evidence <项目内文件>`。流程提示不能代替沙箱，也不能证明语义上绝不偏题。完整设计、约束和验证记录见 [流程原型说明](docs/flow-control.md)。

## 当前本机使用

当前工作区已构建，并安装 `~/.local/bin/jth` 软链。配置位于本工具目录的 `.env`。

```sh
jth --help
jth memo send examples/conversation.json
jth memo status jth-cli-example-1
jth memo search '这个项目如何使用 CLI？' --project jth-cli-verification
jth memo read <entry-id>
jth memo read --submission jth-cli-example-1
```

`send` 默认在 PostgreSQL 持久化材料后返回，不等待模型和 Embedding。`queued` 表示已接收，`complete` 且具有 `index_receipt_id` 表示处理完成；待审条目是否进入默认搜索还由 `claim_status` 决定，状态输出包含 `candidate_count` 和 `publication_notes`。示例会话限定在 `jth-cli-verification` 项目范围内。

### 按条目接收与输出留存

提炼不再要求实体名称逐字出现在原文、不强制每条引用新增消息、不按来源角色或确认顺序拒收模型分类。原始消息、角色和顺序保持原样。Agent 判断语义；程序仍校验 JSON、真实引用 ID、项目范围、有效期证据和关联事务。

小的格式差异会规范化：实体去空和去重、重复来源 ID 去重、未提供的可选元数据保留为空。未知辅助字段留在原始模型输出中，不进入规范条目。无法接收的独立条目保存 `path/error/value`，其他有效条目继续生成向量、发布。无效关系不修改旧事实，也不把已经通过提炼检查的正文重新降级；它作为未应用的关系保留诊断，不冒充更正成功。

队列 `partial` 表示有未接收条目或未应用关系，不等于 DSH 调用失败，也不保证至少有一条成功；结合 `entry_count`、`issue_count` 查看。全部条目不合规时也会保留原始输出并明确报告，不会冒充“没有值得记忆”的正常空结果。`failed` 继续用于整体 JSON 无法读取、模型/网络调用或数据库等执行问题。

```sh
jth memo status <submission-id>          # 条目数、问题路径、原始输出数量
jth memo read --submission <id>          # 已接收结果及未接收条目的完整数据
jth memo outputs <submission-id>         # 原始模型返回，含 JSON 修复前后的每次尝试
```

从 v5 起，DSH 已返回的响应在业务解析前写入 `jt_memo.agent_outputs`；因 token 上限停止时，SDK 已返回的片段也会保留并标明执行错误。因此后来发生条目校验或 Embedding 错误，不会丢失第一次返回。旧版本没有留存的模型输出不能凭空恢复；原会话仍可重跑。基础设施失败使用 `retry`，复用已保存的提炼检查点。v6 在 retry 时将原失败原因保存在 `jobs.failure_history`。

`memo model` 的选择只影响新提交。需要让某个失败任务改用新 Provider/model 时，显式运行 `jth memo retry <id> --provider <id> --model <id>`；两个选项必须一起提供。原执行配置保存在 `failure_history[].agent`，来源、已保存的提炼、Embedding 空间和其他执行选项不变。普通 retry 继续沿用任务快照；不为重试设置 effort 或输出 token 上限。纯索引任务不接受模型覆盖。

`partial` 使用按条恢复，保留原有正文、向量、模型输出和回执。先查看原材料与诊断，主 Agent 或调用者据此提供修正文件，不会自动请求模型重写整批：

```sh
jth memo recover <id>                 # 返回 issue 的 path/error/value 及现有恢复记录
jth memo read --submission <id>       # 核对引用原文和已接收内容
jth memo recover <id> corrections.json
```

文件是数组；每项是 `{ "path": "memories[2]", "action": "replace", "reason": "修正依据", "value": { ...完整修正条目 } }`，或 `{ "path": "relations[0]", "action": "dismiss", "reason": "原关系已过时，当前证据不支持应用" }`。整个集合格式错误时，原 path 为集合名，value 使用修正后的数组。`dismiss` 只记录不采纳的原因，不删除原错误内容。

修正的提炼条目产生独立后续批次，保留原接收时间，复用原执行配置并跳过再次提炼，只为新增正文生成向量、比较关系。关系修正复用既有正文与向量，在原发布事务规则下追加；引用已失效事实时拒绝应用，避免旧关系回退当前状态。同一路径的相同请求幂等，不同请求不能覆盖恢复回执。后续批次失败仍用其 ID `retry`。

`recover` 返回 `unresolved_count`；后续批次尚未完成或关系仍需审核时不会报已解决。原任务继续显示历史 `partial`，`status` 的 `recoveries` 和 `jt_memo.intake_recoveries` 记录处理结果，不将有错误的历史运行改写为一次干净成功。

本机开发库位于 `~/.jth/postgres`。`jth` 使用 `~/.jth/run` 私有 Unix socket；图形客户端使用仅监听本机的 `127.0.0.1:5432`。在 `.env` 明确配置 `JTH_PG_DATA_DIR` 和 `JTH_PG_BIN_DIR` 后，数据库访问会复用运行实例或按需启动它；电脑重启后的第一次访问也适用。没有增加开机常驻服务，PG 启动后不随单次 CLI 退出而关闭。

```sh
jth db status
jth db start
jth db stop
```

`status` 只观察，不启动；`stop` 关闭明确配置的本机实例，活动事务回滚，数据保留。停止前应先完成正在执行的任务；以后需要数据库的命令会再次启动它，`jth memo work` 恢复未完成队列。启动管理复用 `pg_ctl`，不重复安装、初始化或升级已有 PG；没有配置托管目录的外部实例只连接，不启停。移除 CLI 软链可运行 `unlink "$HOME/.local/bin/jth"`；该操作不删除配置或记忆数据库。

DSH Web/桌面是否打开不影响提炼：SDK 会自行启动并关闭 `sdk-minimal` 子进程。`jth memo status --summary` 显示执行方式、队列计数与失败原因。`failed` 表示调用、整体 JSON 或存储等执行问题；`partial` 表示独立有效条目已处理，存在未接收条目或未应用关系。整体 JSON 无法解析时最多带错误反馈重试一次，单条数据问题不重新生成整批结果。模型参数继续采用 Provider 默认行为。旧 failed 任务用 `memo retry <id>` 恢复，已存提炼直接从后续阶段继续。

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

## 本地构建与配置

需要 Node.js ≥ 24.21.0、pnpm 10，以及已经安装并构建的 DeepSeek Harness。当前 SDK 和开发工具依赖仍链接到相邻 `../deepseek-harness` 工作区，已验证版本为 `0.1.6-alpha.1`；这是本机源码交付，不是可独立分发到任意机器的 npm 包。

```sh
pnpm install --frozen-lockfile
pnpm build
node bin/jth.mjs --help
# 初次配置时复制模板；已有 .env 时不要覆盖。
cp -n .env.example .env
chmod 600 .env
# 配置 PostgreSQL 连接与 Embedding API 后：
node bin/jth.mjs memo init
```

`memo init` 创建 `jt_memo` schema 和 `vector` 扩展，或将已有 v1/v2/v3/v4 库事务性升级到 v5，保留原材料、条目、向量与回执。v5 增加原始模型输出、按项诊断和 partial 状态，不重写旧正文或哈希。本版使用 PostgreSQL 15+ 的约束能力，本机验证版本为 18.6。命令不安装 PostgreSQL；配置本机托管后会按需启动既有实例，连接用户需要建表、扩展权限，未知版本会被拒绝。

`.env.local` 已改为 `.env`。`.gitignore` 忽略 `.env` 和 `.env.*`，只允许无凭据的 `.env.example`。仓库已初始化并托管于 GitHub 私有仓库 `JacobZyy/jt-harness`。打包文件采用白名单，同样不包含 `.env`。实际部署的凭据注入后续处理。

默认读取**工具安装目录**下的 `.env`，不读取业务项目当前目录中的同名文件。`--env-file /absolute/path/.env` 或 `JTH_ENV_FILE` 可指定配置；进程环境变量优先于文件。配置内的相对目录、DSH 入口路径以配置文件所在目录为基准。环境变量不会写回 `.env`，文件内容也不会整体导出给 DSH。

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

## 指令和输入契约

`send` 支持 JSON 文件和 stdin。输入格式见 `examples/conversation.json`：`submission_id` 必须稳定，消息必须有稳定、唯一的 `message_id`。同一 ID、同一材料重复投递返回原任务；同一 ID、不同材料报冲突。新增会话增量使用新 ID，保留足够上下文。

```sh
cat examples/conversation.json | jth memo send -
jth memo send examples/conversation.json --wait
jth memo send new-conversation.json --provider deepseek-official --model deepseek-v4-flash
jth memo status
jth memo status --summary
jth memo outputs <submission-id>
jth memo retry <failed-submission-id>
# 为已经失败、仍保存旧预算的任务显式延长 Agent 时间预算：
jth memo retry <failed-submission-id> --timeout-ms 600000
jth memo work
```

`--wait` 适合手动联调，会等待队列处理。Codex 自动采集入口使用下方六阶段适配器，不等待 Agent 或 Embedding。

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

`--workspace /absolute/project/path` 可以安装到其他项目。安装仅修改该项目的 `.codex/hooks.json`，保留其他工具的 Hook，更新前备份到 `~/.jth/codex/backups/`。重复安装不会重复注册。Codex 要求通过 `/hooks` 审阅并信任新的定义；本工具不绕过该信任机制。

安装六个事件，全部调用同一个 `jth memo codex capture` 入口：`SessionStart`、`Stop`、`Interrupt`、`SessionEnd`、`SubagentStart`、`SubagentStop`。没有注册其他阶段。启动事件登记来源并补采；停止事件提交增量。子 Agent 用自己的 `agent_id` 作为来源会话 ID，保留父会话 ID，不把父 Agent 的委派当作用户直接陈述。

Hook 短暂同步保存本地交接记录后启动独立 worker，超时为 3 秒，成功时不向 Codex 输出内容。Hook 内不连接数据库、不调用模型、不等待 Embedding。数据库离线时，本地记录仍保留；恢复数据库后执行 `jth memo work`，或者等待下次 Hook 唤醒。`SessionEnd` 返回后 Codex 可能删除原会话文件，因此采集入口用本地硬链接保留来源 inode，并执行 fsync。来源和 `JTH_DATA_DIR` 必须位于支持硬链接的同一文件系统；跨文件系统会明确报错，不假装完成投递。

默认仅采集安装时间之后的新内容，不自动补录全部历史。采集读取已登记会话的文本消息、助手报告和工具结果，排除系统/开发者注入、推理内容和压缩摘要的重复表示。图片和音频二进制不送入文字记忆。读取适配已核对本机 Codex 0.153.0 的实际日志；官方不保证 transcript 格式稳定，升级后遇到未知格式会保留进度并报错。

`~/.jth/codex/` 保存本地交接记录、来源硬链接、采集游标、未获回执的固定批次和安装备份。JSON 文件权限为 0600，目录为 0700。硬链接继承原来源文件权限，目录限制其访问。卸载停止继续发现新内容，已经接收的批次仍可处理；不会删除历史记忆或来源。当前没有自动回收硬链接的策略。

每批有稳定 ID；同一个来源片段被多个 Hook 重复触发也只接收一次。游标只在 PostgreSQL 返回持久化接收回执后推进；回执不确定时先重发完全相同的批次。完整 UTF-8 日志行才会被消费，大消息按字符边界拆片。批次附带最多两条前序对话作为 `context_only`，供确认和代词消歧使用；输出必须引用新增消息，不能只靠前序上下文重复写入旧事实。

启动/恢复和 `memo work` 会补采已登记的父子会话，因此子 Agent 没有正常触发 `SubagentStop` 时仍有恢复入口。没有常驻文件监听器或定时任务；如果此后没有任何唤醒，补采会等待下一次 Hook 或手动 `memo work`。查看接收、等待来源和错误状态用 `jth memo codex status`，查看提炼和向量发布状态仍用 `jth memo status`。

实现与验收边界见 [Codex Hook 验证报告](docs/codex-hooks-verification.md)。

Agent 模型、向量空间和原材料在接收时固定；重复提交不会悄悄换模型。凭据在处理时从对应 `.env` 重新读取，支持修复或轮换密钥。改变模型、维度或 Embedding 地址会产生不同向量空间；未完成任务必须恢复原配置后重试。本版本没有全库重建索引命令。

`status` 列出状态计数与最近 20 个任务；指定 ID 后显示尝试次数、错误、提炼和比较两个阶段的 DSH session ID、索引提交回执及直接修订数量。`read --submission` 可以查看完整提炼结果和修订证据。

`search` 必须显式指定一种范围，默认 10 条、最多 50 条；只输出 400 字符以内的正文预览，不返回向量。完整正文和引用原文通过 `read` 获取。

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

新提炼要求一条记忆表达一个可独立更正的事实，保留限定条件与多条必要来源；`entities` 只能引用消息中实际出现的对象、路径或符号。程序校验实体和时间证据，语义上是否完全原子仍需模型判断；原有条目不会被静默拆写。

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
jth memo send conversation.json --review
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
- Agent 提炼成功先保存检查点。Embedding 失败后 `retry` 复用该结果，不重复调用 Agent。
- 整批向量、向量空间与索引回执在同一事务内提交；提交失败全部回滚。已提交索引但未更新任务状态的中断，可恢复为完成，不重复嵌入。
- 零候选同样生成 `noop` 提交回执。失败不会无限自动重试；修复原因后显式 `retry`。
- 异常退出后，下一次 `send` 启动的 worker 或手动 `memo work` 会恢复遗留 `running` 任务。没有常驻守护进程，因此整机重启不会自动唤醒队列。
- 当前 API 实测批量响应重复返回 `index: 0`，无法安全据此绑定来源。本版本逐条调用 Embedding 并校验模型、数量、序号、1024 维及 float32 有限非零值，不猜测批量响应顺序。
- 精确余弦搜索只提供关系比较候选。独立 DSH 比较阶段判断更正、补充和冲突，程序校验来源、范围、时间与审核资格后，与向量在同一事务里提交。v3 为提炼 Agent 增加原子事实和元数据约定，保留已有来源与角色规则。
- 更正建立替代关系，旧正文和来源保留，默认查询隐藏旧版本；补充保留双方并关联；冲突保留双方依据并标记 `conflicted`。Agent 根据来源语义判断更正，程序保留真实 ID、同范围、有效引文和事务约束，不再用角色组合代替判断；时间更新或相似度更高都不是替代依据。
- 仅更新冲突一方时，未决争议会跟随新版本保留。明确裁决双方时才解除冲突。若新批次只产生 conflict revision，也能把该证据关联到既有记忆；没有命中旧记忆的批内冲突仍保存在批次证据中，通过 `read --submission` 查看。
- 比较阶段每个查询探针最多取 5 条同范围候选，去重后最多 20 条旧记忆，整体比较材料上限 384000 UTF-8 字节；超限明确失败，不截断证据。召回和模型语义判断不能保证发现所有冲突；未检出的关系不会被程序凭空建立。
- 暂无 ANN、全库同义去重或跨空间重建索引。方案参考和后续清单见 [Rex 记忆机制参考](docs/rex-memory-reference.md)。
- 多项目/多业务输入尚未细分每条记忆的独立范围，所以采取保守匹配：涉及 A、B 的记录只在查询同时包含 A、B 时返回，单独查 A 不混入 B。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm test:postgres
```

默认测试不调用真实模型或 Embedding。PostgreSQL 测试启动独立临时数据库并在结束时关闭、删除；需要 PostgreSQL + pgvector。macOS 默认使用 `/opt/homebrew/opt/postgresql@18/bin`，其他安装位置通过 `PG_BIN` 指定。

真实端到端证据见 [交付验证报告](docs/jth-delivery-verification.md)。当前技术设计见 [记忆系统设计](docs/memory-plugin-technical-design.md)。Agent 语义评测已由用户收口，本次仅验证新增 CLI、存储、恢复和调用串联。

修订功能验证见 [三条规则验证报告](docs/memory-revisions-verification.md)。手动运行 `node scripts/verify-revisions.ts --live` 会使用真实模型/API，在独立测试项目中验证新增、更正、补充、冲突和裁决；`DSH_RECONCILE_LIVE=1 node --test packages/memo/src/agents/reconcile.test.ts` 验证没有明确更正时不得覆盖旧事实。

v3 五项存储能力及真实 CLI 验证见 [存储增强验证报告](docs/memory-storage-v3-verification.md)。`node scripts/verify-storage-v3.ts --live` 会调用真实 DSH/Embedding，在独立测试项目中验证原子提炼、时间窗口、候选审核、归档恢复与体检。

本次默认流程恢复与真实 DSH 验收见 [恢复记录](docs/dsh-restore-verification.md)。

此前强制关闭思考的历史实验见 [配置同步报告](docs/dsh-thinking-off-verification.md)，已撤销该配置。

## 交互切换记忆 Agent 模型

运行 `jth memo model`，使用方向键从 DSH 实时目录中单选模型；直接输入可搜索模型名称、ID 或 Provider，空格分隔多个关键词。列表分页显示并标注当前项，回车确认，Ctrl+C 取消。`jth memo model --list` 输出 JSON；也可用 `jth memo model --provider zz-tokenhub --model deepseek-flash` 精确选择。

选择只保存项目 `.env` 的 Provider 和模型。记忆执行器不指定 reasoningEffort 或 maxTokens，也不修改 Provider 的能力声明；全部采用 DSH/Provider 默认行为。任务超时仍由本工具管理。配置冲突或取消选择不会覆盖文件，已有凭据和其他配置保持原样。

模型发现复用独立 DSH SDK 进程中的 llm.listProviders/listModels；只读目录插件补充 SDK 缺少的目录端点，不调用模型、不依赖浏览器或 Web 服务。只在选择时查询目录，正常提取没有额外目录查询进程。

旧队列的 Provider/model 快照不改写、不批量重跑；历史 effort/maxTokens 字段仅用于读取旧记录，不再被执行器转发。
