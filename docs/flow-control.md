# Codex 原生流程

JTH 的流程控制只补充项目约定和 Memo 接入。目标续跑、任务列表、会话恢复、压缩、工具执行和权限使用 Codex 原生能力。原 PostgreSQL 任务系统留作显式历史兼容，不参与默认新任务。

## 执行职责

| 内容 | 当前负责人 |
| --- | --- |
| 长任务持续推进 | Codex 原生 Goal；遵守宿主启用条件及用户授权 |
| 待办、进行中、完成 | 宿主真实计划工具；主 Agent 主动更新 |
| 用户反馈与恢复 | 当前会话、原生 Goal 和计划；保留原目标，更新相关步骤 |
| 机器检查 | 已有命令或适用 Hook，保留实际结果与产物 |
| 任务验收 | 主 Agent 在原生计划的验收节点核对交付、范围和适用约定，复用机器检查证据 |
| 长期经验 | `jth memo search/read` 与主会话短声明 |

普通问答不创建计划。实质任务按 [Workflow Policy](workflow-policy.md) 选择 guarded 或 planned；小改完成后聚焦验证，需要规划时再使用原生计划，步骤状态随执行更新。反馈改变的是相关约束或步骤，只有用户明确改变目标才切换总目标。恢复时读取同一会话、Goal 和计划，不从旧 Flow 数据库里自动选一个目标。

主 Agent 读取 Skill 并建立或接续实际计划后，在对话中输出一行 `JTH Flow｜已进入/已恢复｜当前步骤`。没有原生工具时明确标注会话步骤；入口 Hook 本身不能证明主 Agent 已执行流程。超过 10 分钟的任务，有效反馈间隔不超过 15 分钟，阶段反馈重置计时，每条不超过 200 字。必要回执不因精简风格省略。

检查点沿用原生计划和会话记录；需要可回溯的结论时，保存小份证据文件或 Git 提交。没有额外的逐工具回执、后台调度器或第二份进度状态。完成前运行项目检查，并核对真实交付与验收条件；工具调用成功或任务列表打勾都不能单独证明需求完成。

## 验收节点与项目配置

实质任务由主 Agent 读取[任务验收约定](../packages/flow/skills/jth-flow/references/acceptance.md)。planned 路线且原生计划工具可用时，按可交付结果拆分计划，末尾安排“验收本次交付”；工具不可用时沿用当前会话的任务项。简单修改把验收并入收口动作。每个交付项复用原生 ID；没有逐项 ID 时使用 T1 等稳定标签，使反馈、证据和完成状态能对应到同一项。

通用底线随 Skill 分发；项目条件写在适用 `AGENTS.md` 的 `Flow acceptance` 段落，也可链接项目自己的 Markdown。没有项目补充时，通用底线和当前用户要求仍然生效。这里的配置由主 Agent 阅读执行，不增加 CLI 参数、JSON/YAML 解析器或任务状态表。

例如项目可以这样配置：

```markdown
## Flow acceptance

- 修改 CLI 参数时，帮助文本、文档与实际执行一致；证据使用对应 --help、调用结果与变更文件。
- 涉及业务命名时，名称须表达实际职责；证据使用本次改动及相关调用方，格式由已有 lint 检查。
```

单测、覆盖率、lint 等机器检查仍交给已有工具或适用 Hook；主 Agent 在验收节点检查任务是否做完、是否越界、适用 Skill 是否落实。本次涉及命名或项目条件要求时，再核对名称是否表达真实职责。两者共用证据，不互相代替。新节点不安装新的测试 Hook，也不会因每次验收再启动一个模型。

验收通过才结束原生计划和 Goal；不通过就回到对应交付项。检查输入、运行环境或验收条件发生影响结果的变化，要更新受影响的证据。最终回复之后才运行的 Stop Hook 不能提前算作验收通过；必须先验证的内容应提前执行已有命令。安装验证只能证明文件和命令可达，不能证明每个模型都正确完成语义验收。

## 安装与调用

```sh
jth flow install --project jt-harness
jth flow status
jth flow context
jth flow uninstall
```

`install` 管理项目 Skill、`UserPromptSubmit` 短入口提示和 Memo Stop 声明入口，移除旧 `jth flow context` Hook。项目 `.jth/flow.json` 仅定位 workspace 和 `.env`；Memo 的安装记录提供 `memo_scope`，不复制到第二张配置表。卸载 Flow 移除 Skill 与入口 Hook，保留 Memo、第三方 Hook 和历史数据。

入口执行 `jth flow prompt --workspace <项目目录>`，接收 Codex 的 Hook JSON，只输出固定流程提醒和 Skill 路径。它不读取用户正文、聊天记录、旧目标或记忆，不连接数据库或模型；普通问答由主 Agent 直接回答，实质任务按 Skill 进入与验收。Hook 定义设置 512 的 `additionalContextLimit`，异常输出诊断并放行，防止入口故障阻塞会话。

`.jth/flow-entry.json` 仅保留最近一次输出的时间、会话/回合 ID、工作目录和字符数。`flow status/context` 的 `entry_hook` 展示安装与最近输出记录；这不是任务状态表，也不能单独证明模型遵守流程。Codex 必须同时信任项目层和当前 Hook 定义；仅写入 hooks.json 不代表已激活。已有会话重新加载后，同会话恢复的下一次用户输入会再次收到短提示。

`status/context` 只读本地配置，不连接 PostgreSQL，不读取旧任务、旧阶段和缓存记忆，也不声称读取了原生 Goal/计划的实时状态。原生状态在 Codex 中查看。安装、状态和退役 Hook 入口在数据库离线时也可运行。

Memo 继续通过 Stop 保存主会话声明，后台仅执行存储和 Embedding。语义搜索只在需要历史依据时进行；原有每轮自动召回与五分钟缓存仅属于显式旧 Flow 路径。数据库启动、向量空间、来源、版本和冲突规则不因流程模式改变。

## 原生工具边界

原生 Goal 和计划工具由当前宿主提供，不由 `jth` 模拟。Skill 要求实际工具可用时主动创建/更新计划；未暴露工具时明确说明，并继续当前任务，不用 Markdown 清单或旧 Flow Task 冒充原生 UI。

Codex CLI 0.152.0 起计划工具默认关闭。`jth init` 会在项目 `.codex/config.toml` 设置 `tools.update_plan.enabled = true`；`install` 和 `upgrade` 保留已有选择。新配置由重新加载的受信任项目会话读取，是否实际提供工具仍以宿主工具清单为准。

`turn/plan/updated` 是宿主发出的计划通知，不是可以写入的公共计划接口。本版不伪造这些通知、不修改 Codex 私有数据库，也不为适配原生功能添加一个新服务。

本次开发实际使用了原生 `create_goal/get_goal`。当前会话没有暴露原生计划更新工具；另用本机 Codex CLI 0.155.0 执行一次只读、临时会话探测，关闭记忆生成和子 Agent，结果同样明确返回 `原生计划工具 unavailable`。未伪造任务列表，也未将旧 Flow 任务当成原生计划。原生 TaskList 的真实展示仍需要在暴露计划工具的宿主会话验收。

## 历史与恢复

```sh
jth flow legacy status --all
jth flow legacy status --task <旧任务ID> --history
jth flow legacy context
```

历史任务、回执、会话绑定、离线事件及 SQLite 文件均保留。旧命令需要显式 `legacy`，不会因安装原生模式而自动执行。旧后台进程残留的默认 `hook/sync/recall --request` 调用只返回跳过结果，不访问任务库或模型。

即使显式读取旧任务，已完成任务的 `context` 也只返回简短完成提示及历史入口；完整内容由 `legacy status --history` 按需读取，不再把旧目标、约束和缓存记忆重新当成当前指令。

原任务运行器和它已有的隔离测试暂时保留于兼容路径；待原生使用验证满足需求后可进一步移除代码。它不是默认执行依赖。原实现说明见 [历史 Flow](flow-legacy.md)。

## 验证

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:postgres
```

新增检查使用不提供 PostgreSQL/Embedding 协议的本地连接探针：原生安装、状态、旧 Hook 和后台调用必须保持零连接；同时验证只移除本工具旧 Hook、保留 Memo 和其他工具、重复安装不重复注册、旧离线文件原样保留。旧 Flow 的 PG 集成测试通过显式 `legacy` 入口继续验证历史兼容。

完成态回归确保上下文不含旧目标、约束、工作回执与召回记忆。真实安装使用已配置 `.env`，不调用 DSH、不重新生成记忆向量，也不清理历史队列。

本次类型检查、37 项离线检查与 44 项隔离 PostgreSQL 检查通过。原生 CLI 探测事件保存在 `artifacts/native-flow/native-plan-events.jsonl`：一次请求输入 38,785 tokens，其中缓存命中 29,824，输出 86；这次仅核对宿主能力，未读写测试文件或生成向量。原生 Goal 用于本次实际实施，旧 Flow 未新增任务。

## 原生能力依据

- [Codex Goal](https://developers.openai.com/zh-Hans/use-cases/follow-goals)：负责持久目标与跨轮推进。
- [App Server](https://developers.openai.com/zh-Hans/docs/app-server)：会话恢复、steering、压缩、计划通知与工具结果。
- [定制机制](https://developers.openai.com/es-419/docs/customization/overview)：AGENTS.md、Skills 与工具接入的职责。
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)：`UserPromptSubmit` 的上下文输出、项目及定义信任、上下文长度阈值。

## 短入口实测（2026-09-20）

本次实现使用原生 Goal 管理总目标，按 JTH Flow 的验收约定收口。主会话没有原生任务列表工具，以会话中的交付项和忽略目录内的证据报告关联结果；没有创建第二套任务数据库或审阅 Agent。

构建、类型检查、Skill 校验、39 项离线测试和 44 项隔离 PostgreSQL 测试通过。入口回归验证配置文件离线、非法及过大输入、跨项目事件、诊断写入失败、重复安装和卸载后残留调用；入口不访问 PG、模型或原始对话。原有 Memo 与第三方 Hook 保留。

真实 Codex App Server 在可移除项目和独立 CODEX_HOME 中执行了一次小型代码修复。由宿主自动触发两次 UserPromptSubmit，均返回上下文，耗时分别为 133 ms 和 110 ms，提示各 249 字符。模型实际读取了安装后的 Flow Skill 及验收约定，修改目标文件并运行项目检查。在检查执行时使用原生 `turn/interrupt` 中断，随后卸载该线程的连接并通过 `thread/resume` 恢复；仅发送“继续刚才的任务，从中断的位置恢复”，仍完成同一目标、重跑检查并核对修改范围。最终只有目标文件发生变化，检查输出 `slug checks passed`。

最初的隔离 CLI 尝试未获得入口输出，因此不算通过。最终场景通过原生配置 API 在独立 CODEX_HOME 中记录已审阅 Hook 的信任，并以宿主 `hook/completed` 事件、实际 Skill 读取、代码差异和检查结果共同判定通过；测试结束后移除了独立运行目录。主项目也经原生 API 确认入口为 trusted，只更新了该入口的信任哈希，保留用户模型、委派设置及 Memo Hook 配置。

原始证据位于本地忽略目录 `artifacts/flow-entry/`：`task.md`、`live-result.json`、`live-app-server.jsonl`、`activation.json` 和测试日志。实测证明该场景的自动进入与恢复执行；Hook 输出本身仍不等于语义验收结果。
