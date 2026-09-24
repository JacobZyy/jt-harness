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

本次修复会话已实际调用 `create_goal`，再通过 `get_goal` 读回同一任务目标及 `status: active`，原生计划同时保留。这证明当前宿主工具可用及真实调用成功；不是“CLI 已替主 Agent 启动 Goal”的证据，也不声称所有模型都一定遵守新提示。跨轮自动续跑的历史实测仍属于 9 月 18 日，本轮没有重复启动付费模型或伪造续轮事件。

本次检查结果：`pnpm test` 为 60 项通过、26 项按环境跳过、0 失败；`pnpm typecheck`、Skill 格式检查和 `pnpm bundle` 通过。聚焦的策略、Goal、CLI 和原生安装回归全部通过。跳过的 PostgreSQL、真实模型和另需环境开关的原生集成用例不计为通过。

本机已安装包含修复的本地 `0.3.6` 构建，当前项目通过 `jth upgrade --trust` 同步。已逐字比对安装后的 Skill 与引用文件；原生 `hooks/list` 返回 Flow 入口 `enabled=true`、`trustStatus=trusted`，已安装 CLI 对实际同一目标返回 `goal.kind=reuse`。没有发布 npm 新版本。当前回合保留原有 24 字入口的真实触发记录，没有用手工回放覆盖它；新入口需在宿主重新加载项目后的下一次输入生效。
