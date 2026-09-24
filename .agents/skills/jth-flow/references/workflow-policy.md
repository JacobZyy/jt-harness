# Workflow Policy 与原生计划

主 Agent 理解当前请求并声明语义；JTH 策略和模板不调用模型、不生成固定任务清单。任务完成状态属于宿主。当前有 Codex 适配器，其他宿主尚未实现；不得把子 Agent 误当成另一种宿主。

## 路线与任务关系

- `noop`：无需工作；`question`：普通问答、说明或状态查询，直接回答，不动已有计划。
- `implement`、`debug`、`verify`、`ops`：默认 adaptive；有界小任务走 guarded，直接完成并做相关检查。
- `design`，或存在明确的 `requested`、`dependent-work`、`uncertain-approach`、`significant-impact` 规划理由时走 planned。
- strict 为实质工作要求计划，仍不为普通问答建计划，也不额外调用审查模型。
- `relationship` 使用 new、continue、amend、approve。主 Agent 根据上下文判定，不用关键词或“确认后还有文字”来猜新目标。
- 接续、补充、确认有活动计划时复用；只有已确认方案而无活动计划时，按工作需要创建计划或直接执行。关联上下文缺失时先恢复来源，不创建替代目标。批准实施不代表实施完成。

`contextAvailable` 与 `activePlan` 是主 Agent 根据本会话实际状态提供的声明；CLI 不读取 Codex 私有状态，也不能证明声明真实。问题或无工作请求的 `planAction=none` 表示不操作已有计划，不是清空计划。

## 进入策略

普通问答不必运行 CLI。开始实质工作或工作边界改变时，使用 `jth flow policy`。无需每个工具调用或步骤更新都重新评估。只声明本轮实际成立的事实，不补造默认理由。

```sh
jth flow policy - --plan-tool available --goal-tools available <<'JSON'
{
  "request": {
    "intent": "ops",
    "relationship": "new",
    "planningReasons": ["dependent-work", "significant-impact"]
  },
  "goal": { "authorization": "instruction", "current": "unknown" }
}
JSON
```

只有实际工具列表中存在 `update_plan` 才传 `--plan-tool available`；`get_goal/create_goal/update_goal` 均可用才传 `--goal-tools available`。两者独立，未提供均为 unknown。工具不可用时明确说明未启用的能力。子 Agent 使用 `--role delegate`，只交回分派结果，由主 Agent 整合。

策略返回 `decision`、`template`、`recording` 和 `goal`。template 是规划维度；主 Agent 先列用户要求的可交付结果，再按能独立验收的结果细化、增删或合并工作项。每个任务写清：稳定 id、outcome、dependsOn、doneWhen、verifyWith。`outcome` 说明哪部分用户目标成为事实；`doneWhen` 写完成条件；`verifyWith` 写该结果的证据。只填写真实依赖，不按文件数量或固定阶段凑步骤。

理解、调研、设计、编码、测试、回归和收口验收通常是交付项内的动作，不单列顶层任务；如果用户明确要求调研报告、设计方案或验收报告，它们才是独立交付结果。例如“实现批量取消并逐笔反馈”，可拆成“批量取消 API 返回逐笔结果”和“页面展示逐笔结果”，各自附检查；不要拆成“调研、开发、测试”。根因未知且用户要求排障时，可先列可验证的诊断结果，取得证据后细化修复项。全部交付后主 Agent 复核整体需求，这是收口动作，不另占一个计划步骤。

## 准备与启动原生 Goal

输出中的 `goal` 与 `recording` 独立。前者准备 `get_goal/create_goal`，后者准备 `update_plan`；两者的 `applied=false` 均表示尚未调用原生工具。Goal 生命周期由宿主维护，CLI 不读取私有状态、不执行这些工具，也不保存另一份 Goal。

输入 `goal` 是主 Agent 对实际授权和最近原生结果的声明：

- `authorization`：用户明确要求使用 Goal 填 `user`；系统/开发者明确要求（包括以该角色交付的受信任 Flow 入口）填 `instruction`；没有则填 `none`，也是默认值。不能因为任务大或有计划就填已授权；用户明确停用时不创建。
- `current`：尚未读取为 `unknown`；实际无 Goal 为 `none`；同一未完成目标为 `same`；其他未完成目标为 `other`；上一目标已完成为 `complete`。暂停、阻塞或额度限制仍是未完成目标，不能填 `none/complete`。
- `objective`：用户的完整总目标；省略时复用 `plan.goal`。这只是目标文本，不证明原生 Goal 已创建。
- `tokenBudget`：只有用户明确指定正整数预算时提供，否则省略。

上例返回 `goal.toolCall.name=get_goal`。主 Agent 实际调用后，若无目标，把 `current` 改成 `none`，提供 `objective` 或完整 `plan`，再准备 `create_goal`；也可直接按同一约定调用原生工具，不必为每个动作重复运行策略。创建后核对 `get_goal`，后续填 `same` 复用。

planned 默认入口要求 Goal；普通问答不创建，guarded 小改仅在用户另有明确 Goal 要求时创建。缺授权、工具不可用、目标冲突或上下文缺失分别返回原因；不通过 `update_plan`、Hook 输出或 CLI 的退出码冒充 Goal 已启动。所有交付和验收通过后，由主 Agent 实际调用 `update_goal({status:"complete"})`，不能由此参数适配器推断完成。

## 准备与更新原生列表

CLI 可接收完整 `plan` 及当前 `progress`，输出 Codex 原生 `update_plan` 参数。也可在初次策略调用时一并提供，减少重复调用。

```json
{
  "request": {
    "intent": "ops",
    "relationship": "amend",
    "contextAvailable": true,
    "activePlan": true
  },
  "goal": { "authorization": "instruction", "current": "same" },
  "plan": {
    "goal": "完成配置迁移并接入当前仓库",
    "tasks": [
      { "id": "T1", "outcome": "用户配置独立可用", "doneWhen": "源码配置移走后仍能读取", "verifyWith": "配置回归" },
      { "id": "T2", "outcome": "当前仓库使用新配置", "dependsOn": ["T1"], "doneWhen": "Hook 与 CLI 读取正确配置", "verifyWith": "安装诊断" }
    ]
  },
  "progress": [
    { "id": "T1", "status": "completed", "evidence": ["配置回归通过，来源：本轮测试输出"] },
    { "id": "T2", "status": "in_progress" }
  ]
}
```

将真实内容交给 `jth flow policy <file|-> --plan-tool available --goal-tools available`。上例的 `current=same` 仅在已读取同一未完成 Goal 时成立。`recording.kind=tool-request` 时，由当前 Agent 调用实际 `update_plan`，参数取 `toolCall.arguments`；同时处理 `goal` 结果。`applied=false` 表示 CLI 从未调用原生工具；不能把准备参数当成更新成功。

接续必须显式传入完整当前进度；完成项必须附实际证据引用，不得重置已完成项。依赖和 ID 检查只校验结构，不是语义验收。当前原生接口最多一个进行中项；即使存在并行子工作，主计划仍可用一个进行中的交付项汇总。

生成原生列表后，后续直接用原生工具更新即可。需要准备新的完整参数时再使用适配器；不在 JTH 保存另一份可变进度。详细验收条件留在会话或必要的计划文档中，复用稳定任务 ID。

## 回执与验收

- guarded：`JTH Flow｜guarded｜当前交付结果｜聚焦验证`。
- planned：取得真实结果后输出 `JTH Flow｜planned｜Goal 已创建/已复用（或未启用原因）｜原生计划 N 步｜当前 T1：交付结果`。
- delegate：只返回分派任务 ID、结果、证据、阻塞和下一步，不宣告主任务完成。
- 不可用：如实说明会话步骤或缺失上下文，不伪报原生更新。

沿用 acceptance.md：运行相关现有检查，主 Agent 在收口核对需求、产物和证据；已通过且未失效的检查直接复用。未取得真实工具结果或尚未执行的 Stop 不能作为完成证据。不增加固定多轮审查、独立评审 Agent 或模型调用。
