# Codex 原生流程

JTH 的流程控制只补充项目约定和 Memo 接入。目标续跑、任务列表、会话恢复、压缩、工具执行和权限使用 Codex 原生能力。原 PostgreSQL 任务系统留作显式历史兼容，不参与默认新任务。

## 执行职责

| 内容 | 当前负责人 |
| --- | --- |
| 长任务持续推进 | Codex 原生 Goal；遵守宿主启用条件及用户授权 |
| 待办、进行中、完成 | 宿主真实计划工具；主 Agent 主动更新 |
| 用户反馈与恢复 | 当前会话、原生 Goal 和计划；保留原目标，更新相关步骤 |
| 项目验收 | 已有测试命令、实际退出码、产物和必要证据 |
| 长期经验 | `jth memo search/read` 与主会话短声明 |

普通问答不创建计划。实质任务开始时用原生计划明确步骤；步骤状态随执行及时更新。反馈改变的是相关约束或步骤，只有用户明确改变目标才切换总目标。恢复时读取同一会话、Goal 和计划，不从旧 Flow 数据库里自动选一个目标。

检查点沿用原生计划和会话记录；需要可回溯的结论时，保存小份证据文件或 Git 提交。没有额外的逐工具回执、后台调度器或第二份进度状态。完成前运行项目检查，并核对真实交付与验收条件；工具调用成功或任务列表打勾都不能单独证明需求完成。

## 安装与调用

```sh
jth flow install --project jt-harness
jth flow status
jth flow context
jth flow uninstall
```

`install` 管理项目 Skill 和 Memo 声明入口，移除旧 `jth flow context` Hook。没有新增 Flow Hook。项目 `.jth/flow.json` 仅定位 workspace 和 `.env`；Memo 的安装记录提供 `memo_scope`，不复制到第二张配置表。

`status/context` 只读本地配置，不连接 PostgreSQL，不读取旧任务、旧阶段和缓存记忆，也不声称读取了原生 Goal/计划的实时状态。原生状态在 Codex 中查看。安装、状态和退役 Hook 入口在数据库离线时也可运行。

Memo 继续通过 Stop 保存主会话声明，后台仅执行存储和 Embedding。语义搜索只在需要历史依据时进行；原有每轮自动召回与五分钟缓存仅属于显式旧 Flow 路径。数据库启动、向量空间、来源、版本和冲突规则不因流程模式改变。

## 原生工具边界

原生 Goal 和计划工具由当前宿主提供，不由 `jth` 模拟。Skill 要求实际工具可用时主动创建/更新计划；未暴露工具时明确说明，并继续当前任务，不用 Markdown 清单或旧 Flow Task 冒充原生 UI。

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
