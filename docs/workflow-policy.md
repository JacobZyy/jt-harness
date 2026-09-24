# Workflow Policy：规划与宿主记录分层

默认 `adaptive`。JTH 提供确定性策略和规划模板；主 Agent 生成具体工作项。Codex 适配分别准备 `get_goal/create_goal` 和 `update_plan` 参数，由当前会话实际调用原生工具。JTH 不保存第二份 Goal 或任务进度。

## 代码边界

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 策略 | `packages/flow/src/policy.ts` | 校验显式语义，选择 noop/direct/guarded/planned、创建或复用计划、恢复上下文及验证范围 |
| 规划内容 | `packages/flow/src/planning.ts` | 提供模板维度；工作项包含结果、依赖、完成条件、验证方式；校验 ID 和依赖图，不持有完成状态 |
| 宿主记录 | `packages/cli/src/plan-adapters/codex.ts` | 将草稿和调用者提供的当前进度映射为 Codex 参数；处理工具不可用、委派回传及已有进度保护 |
| 原生目标 | `packages/cli/src/codex-goal.ts` | 根据明确授权、实际 Goal 读取结果和工具可用性准备读取或创建参数；同一未完成目标复用，冲突不覆盖 |
| 接入 | `packages/cli/src/flow-policy.ts`、`workflow-settings.ts` | CLI 参数、配置来源、JSON 输入输出；不执行模型或任务 |
| Hook 与 Skill | 既有 Flow 入口、`references/workflow-policy.md` | 提醒主 Agent 按真实上下文调用策略、创建计划、执行和验收 |

策略和规划内容不导入宿主适配器、不出现 Codex 工具名；以后接入其他客户端，应新增相应记录适配器及其参数验证，不改任务拆分规则。`--role delegate` 表示 Codex 内的子 Agent，不是另一个客户端。当前 `--host` 只支持 codex，其他名称明确报错。

## 使用

```sh
jth flow config
jth flow config --scope user --mode adaptive
jth flow config --scope project --mode strict
jth flow config --scope project --mode inherit
jth flow policy request.json --plan-tool available --goal-tools available
```

配置只使用非敏感的 `{ "mode": "adaptive" }` 或 `{ "mode": "strict" }`：

- 用户默认：`~/.jt-harness/workflow.json`，跟随 `JTH_CONFIG_DIR`。
- 仓库覆盖：`.jth/workflow.json`。
- `inherit` 清除该层的 mode；缺省值为 adaptive。
- 优先级：`policy --mode`、进程 `JTH_WORKFLOW_POLICY_MODE`、仓库、用户、内置默认。

`flow status/context` 和安装结果显示 `workflow_policy.mode/source/file`。初始化、升级复用这些配置，不为默认值创建多余文件。不实现旧配置迁移，Memo 凭据和队列保持原有职责。策略和配置命令不要求数据库、Embedding 或 API Key 可用。

请求示例、完整草稿字段及进度准备见 [随安装分发的操作说明](../packages/flow/skills/jth-flow/references/workflow-policy.md)。普通问答不必调用 CLI；实质工作进入、范围变化或恢复需要判断时调用一次即可，不在每次工具调用后评估。

## 决策与验证边界

- 语义由主 Agent 声明，程序不根据关键词、文本长度、确认后是否还有文字来猜任务性质。
- `question` 在两种模式下都直接回答。`activePlan=true` 不会让状态查询清空或完成计划。
- 继续、补充和确认必须有可关联的上下文；有活动计划时复用，没有活动计划但有方案来源时按工作需要创建。上下文缺失只返回 recover-context，不猜新目标，也不改变宿主 Goal 状态。
- `planningReasons` 指定真实的依赖、重要影响、未确定方案或明确规划要求。模板不固定任务数量；每项应是可独立验收的用户目标部分，不把调研、开发、测试和收口复核机械拆成顶层步骤。用户明确要求的报告或诊断结果可以成为独立交付项。
- strict 只提高规划要求；验证仍用现有项目检查和主 Agent 的收口核对，不引入 Superpowers 多轮审查、评审 Agent 或 Jev。
- 原生工具可用性由当前 Agent 根据实际工具清单声明。`applied=false` 始终表示 JTH 只准备了参数；调用者取得真实工具结果后才能报告已更新。
- planned 的受信任入口明确要求使用原生 Goal；该指令由宿主作为系统/开发者指令交付时，可作为创建依据，不要求用户每次重复 `/goal`。仅有 planned 分类或 Skill 文件不构成授权。用户明确停用时不创建；guarded 仅在用户明确要求时使用 Goal。
- `goal` 与 `recording` 独立返回；缺少计划工具不禁用已授权的 Goal，计划更新也不能替代 Goal 创建。`current` 来自主 Agent 最近一次真实 `get_goal` 结果，不是 CLI 推测。暂停、阻塞或额度限制均不等于无 Goal；只复用同一未完成目标，恢复遵守宿主规则。
- 接续参数必须携带所有任务的当前状态，防止默认 pending 重置进度。完成项要有实际证据引用，推进项的前置任务须已完成。这些结构检查不证明证据语义正确，也不拦截 Agent 直接调用宿主工具。

## AIOS 参考与后续同步

本次以本机 AIOS `0d5cea23863d88adf5a6a6532d71686a5c4c9711` 及其锁定的 rex-harness `8011956d0c82bed10d15061c6b4392a052137edf` 为参考。核对文件：`scripts/lib/planning/workflow-policy.mjs`、`auto-gate.mjs`、`schema.mjs` 及 `scripts/tests/workflow-policy.test.mjs`。上游策略基线 23 项测试通过。

迁移显式语义、adaptive/strict 和路线决策。任务进度、Goal、恢复仍由 Codex 管理；不引入 AIOS 自有任务落盘或 Rex Activation 执行器。中文确认和补充由主 Agent 结合上下文声明，避免把“可以，你做吧”错误地当成新目标；“blocked”不映射为宿主 Goal 的终态。

后续同步按固定提交比较上述源码和测试，逐项评估规则变化，并运行本地契约用例；不在运行时读取开发者的 AIOS 目录，不自动跟踪上游 main。策略的语义输入日后可以由其他组件提供，本版不预建 Jev 接口。
