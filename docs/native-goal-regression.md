# 原生 Goal 触发回归分析（2026-09-24）

## 结论

用户期望的是：单目标持续执行交给 Codex Goal，任务进度交给 Codex 原生计划，JTH 保留短指引、验收和 Memo。迁移方向没有错；迁移时删除了原生 Goal 的启动约定，之后的改动只补齐了计划链路。结果是可以看到任务列表，却没有创建承担跨轮续跑的 Goal。

这不是 Goal 工具本身不可用，也不是当前 Hook 没触发。本次开始时，原生 `get_goal` 返回 `goal: null`，当前宿主同时提供 Goal 工具和 `update_plan`；`flow status` 中本轮 `UserPromptSubmit` 已输出旧版 24 字入口。该入口只要求使用 Skill，Skill 又只要求“读取、复用已有 Goal”，没有“何时创建不存在的 Goal”。

## 聊天与提交演进

主要依据为任务“AI开发记忆系统蓝图”（`01a0724a-b095-7000-929c-b5ddaee2d4a1`）的原始聊天、对应 Git 差异，以及“Locate update_plan toggle config”的入口精简讨论。以下时间均为北京时间。

1. **9 月 18 日：Goal 是明确启用的附加能力。** 用户要求把异常恢复作为长任务，并评估配合 Codex Goal。`6811192` 的 Skill 明确规定主 Agent 调用 `get_goal/create_goal/update_goal`；旧 Flow 保存阶段和检查点，Goal 负责续轮。原始会话确有 Goal 自动续轮消息，[恢复实测报告](recovery-goal-verification.md)记录了当时的结果。这只能证明该任务启用成功，不能证明之后所有 Flow 任务都会自动启用。
2. **9 月 20 日 16:55：用户已经指出类似症状。** 用户问“我看本次修复逻辑似乎没有用到 gpt 的 goal 模式？”。当时答复确认 Goal 为空，使用的是旧 Flow 状态与循环。此时显式启用仍是旧设计边界。
3. **9 月 20 日 17:20–17:36：用户明确要求原生替代并批准实施。** 原话包括“我所谓的 task 指的是 agent 自带的 task 模式。于 codex 而言，则是 codex 自己的 任务列表模式”，以及“能用 Codex 或其他 Agent 工具原生自带的东西，就不要自己单独写”。随后批准“就照着这个方案优化一下”。用户没有要求取消 Goal 或只保留计划。
4. **`2e66d65`：发生关键遗漏。** 旧任务、Hook、运行器退至 `legacy` 是正确收缩，但整个“阶段计划与 Codex Goal”段落被删除，包括读取、创建、恢复和完成的具体操作。新 Skill 只剩“先读取当前会话、Goal、任务列表和已有计划”“已有 Goal 或任务直接复用”。没有 Goal 时如何启动已经丢失。
5. **当次验收存在范围误判。** 9 月 20 日 18:06 的交付答复称“本次实际使用原生 Goal，已完成”，18:16 又称“已经是依托 Codex 原生 Goal 执行的单目标 Loop 工程”。前者证明实施会话自身使用了 Goal，不能证明安装后的新任务会自动创建 Goal。把一次手动调用的成功当成入口行为已完成，是验收缺口。
6. **`1bf8419`：补入口，未补创建。** `UserPromptSubmit` 提醒进入 Flow；Goal 仍只有“遵守宿主启用条件”。Hook 被触发、Skill 被读过，都不等于 Goal 被创建。
7. **`bf40633`、`decb513`、`8e73a63`：原生计划与进度逐步接通。** 项目开启 `tools.update_plan.enabled`，增加进入/恢复回执，Workflow Policy 区分 guarded/planned，并由适配器准备 `update_plan` 参数。`plan.goal` 仅成为计划的 `explanation`，没有传给 `create_goal`。因此计划成功无法补偿 Goal 缺失。
8. **`51d7831`、`5f9f321`：不是首次回归点。** 前者按用户要求把入口压缩成“实质任务按 jth-flow Skill 执行。”，后者改善按交付结果拆分计划。它们都没有删除仍然存在的 Goal 创建链路，因为链路早在 `2e66d65` 已丢失。不能把问题归咎于精简提示词或最近的任务拆分修复。

可复核的历史差异：

```sh
git show 6811192 -- packages/flow/skills/jth-flow/SKILL.md
git show 2e66d65 -- packages/flow/skills/jth-flow/SKILL.md
git show 8e73a63 -- packages/cli/src/plan-adapters/codex.ts
git show 51d7831 -- packages/flow/src/entry.ts
```

## 修复范围

- **入口恢复明确指令。** 受信任 Hook 要求主 Agent 的 planned 任务使用原生 Goal，先读取，没有未完成目标才创建。用户明确停用时不创建；普通问答和 guarded 小改不自动启用。保留短入口，不恢复每轮长提示词。
- **Skill 恢复完整生命周期。** 主 Agent 实际执行 `get_goal/create_goal`，创建后核对返回结果；续轮、恢复与补充沿用同一 Goal。全部交付和验收完成后才调用 `update_goal`。暂停、阻塞和额度限制均不能当成“无目标”。
- **策略输出同时覆盖目标和计划。** `goal` 独立准备原生 Goal 参数，原有 `recording` 继续准备原生计划参数；两者均标记 `applied=false`。没有计划工具不妨碍可用的 Goal，计划成功也不证明 Goal 已创建。
- **明确授权来源。** 宿主要求创建 Goal 必须有用户或系统/开发者明确指令，不能仅从普通任务推断。受信任入口以系统/开发者角色交付时提供这一依据；单独读取 Skill、准备 JSON 或看到 `planned` 不构成授权。不修改 Codex 私有数据库、不启动额外 runner、不恢复旧任务库。

## 验证与边界

回归覆盖未知状态先读取、无目标创建、完成后新建、同一目标复用、其他目标不覆盖、缺授权、工具缺失、子 Agent 不接管、问答和小改不自动创建，以及预算不默认注入。真实 CLI 检查分别验证“只有 Goal 工具”和“只有计划工具”，保留离线、零任务落盘约束。

安装测试通过实际 `flow install` 和 `flow prompt` 核对安装后的 Skill、引用文件、短入口与上下文上限，继续验证 Memo、第三方 Hook 和历史数据保留。提示词断言只保护入口约定，不等于模型行为证明。

首次修复提交 `d068ed5` 的实施会话实际调用了 `create_goal`，再通过 `get_goal` 读回同一任务目标及 `status: active`，原生计划同时保留。这只能证明宿主工具可用及真实调用成功；当时没有完成普通新任务自动启用 Goal 的实测。用户随后明确要求创建多个任务实测，下面补充该项验收，不再把实施会话的手动成功代替自动触发证据。跨轮自动续跑的历史实测仍属于 9 月 18 日，本次新增测试重点是自动创建与正常收口。

本次检查结果：`pnpm test` 为 60 项通过、26 项按环境跳过、0 失败；`pnpm typecheck`、Skill 格式检查和 `pnpm bundle` 通过。聚焦的策略、Goal、CLI 和原生安装回归全部通过。跳过的 PostgreSQL、真实模型和另需环境开关的原生集成用例不计为通过。

本机已安装包含修复的本地 `0.3.6` 构建，当前项目通过 `jth upgrade --trust` 同步。已逐字比对安装后的 Skill 与引用文件；原生 `hooks/list` 返回 Flow 入口 `enabled=true`、`trustStatus=trusted`，已安装 CLI 对实际同一目标返回 `goal.kind=reuse`。没有发布 npm 新版本。首次修复时保留了旧版 24 字入口的真实记录；随后新建会话的原生事件和开发者消息证实，新入口已经实际生效。

## 普通新任务的自动触发实测

2026 年 9 月 24 日，使用本机 `codex-cli 0.155.1` 的原生 App Server 和默认模型 `gpt-6-sol`，在已接入 JTH 的当前工作区新建独立会话。测试驱动仅通过 `thread/start` 和 `turn/start` 提交普通开发需求，用 `thread/goal/get` 读取状态；不调用 `thread/goal/set`，不添加自定义 Goal 工具或额外开发者指令，不在任务提示中要求 `/goal`、`create_goal`、`update_plan` 或 taskList。

以下三项均在原生 Goal 初始为空时，由宿主自动运行受信任的 `UserPromptSubmit`，将 Flow 入口作为 developer 消息交付。模型随后实际调用 `create_goal`、`get_goal` 和 `update_plan`，没有由测试驱动代建目标或任务列表：

- **库存汇总**：`01a0d152-4a81-7de0-aeb3-a7948683f6c0`，原生计划 2 项；输入校验、重复合并、排序和文件 CLI。
- **配置迁移**：`01a0d152-4bb1-7603-8d4a-e86b362e0398`，原生计划 2 项；版本迁移、重复执行、错误校验和拒绝覆盖。
- **订单对账**：`01a0d154-49a8-73d3-8d87-39c2a80b80ea`，原生计划 3 项；设计约定、校验比较模块和双格式报告 CLI。

原始证据保留在忽略提交的 `artifacts/native-goal-live/` 与 `artifacts/native-goal-design/`：`results.json` 保存普通请求、会话 ID、起止 Goal 状态和事件；`events.jsonl` 保存宿主真实通知。`node artifacts/native-goal-live/verify.ts` 核对 developer 入口、恰好一次真实 `create_goal` 调用、Goal 的 active 与 complete 状态、原生计划的进行中与全部完成状态；只出现 Hook 文本或模型口头宣称不算通过。原始会话由 Codex 自身保存，未提交运行日志或另建 JTH 任务数据库。

**最终结果：三个 planned 样例全部通过。** 各自恰好创建一个 Goal，均有三次原生计划更新，最终所有计划项完成，Goal 为 `complete`；测试驱动退出后再次通过独立的原生连接读回相同状态，均未设置 token 预算。主任务另外复跑了样例检查：库存断言通过，配置迁移 4/4 通过，订单对账 4/4 通过；guarded 发布说明的断言也通过。`verify.ts` 输出 `3 planned cases passed; guarded control kept Goal absent.`，退出码为 0。

### 对照与适用边界

- **guarded 小任务不自动创建 Goal。** 发布说明样例 `01a0d152-48aa-7b62-bcb0-f3bc46c7e7ac` 实际收到同一入口、读取同一 Skill，被 adaptive 策略判定为 `guarded`，最终 Goal 仍为空，检查通过。这符合当前策略；不能把“每个任务都开启 Goal”当成验收标准。
- **主工作区安装不等于新 worktree 已安装。** 最先通过桌面工具创建的三个样例使用新 worktree：原生计划均有真实更新，Goal 均为空。检查发现其本地 Skill 和 Flow 连接配置缺失；`hooks/list` 继承的是主工作区的定义，而 `flowEntryHook` 会拒绝安装目录之外的 cwd。此批不计入已安装项目的成功样本。新 worktree 应先执行现有环境设置或项目安装，再验证其自己的 Skill、入口和信任状态；不能删除目录边界来制造通过。
- **验收结论限于实际运行的宿主与输入。** 这次证据覆盖普通 planned 请求的自动创建、真实任务列表和收口；不代表所有模型、未安装工作区或未提供原生工具的宿主均保证触发，也没有将手动提示开启 Goal 的成功混入结果。
