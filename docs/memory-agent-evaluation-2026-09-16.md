# DSH 记忆提炼 Agent 验证报告

日期：2026-09-16。验证对象：当前 `memory-agent` 的 DSH SDK 调用、提炼规则及结果校验。本轮保持候选 Agent 的提示词、代码、模型配置和插件配置不变。

**收口决定（2026-09-16）：** 用户认可 C15 的过滤行为，确认当前未发现需要阻塞使用的明确问题，Agent 测试至此收口。以下保留测试当时的预期、原始分数和分析；C15 不再列为当前待修复缺陷，也不要求追加语义评测后才能推进下一阶段。[后续实施计划](memory-plugin-technical-design.md#12-实施顺序与验收)

## 结论

**当前版本可以进入带抽查的试用，但尚未达到本轮预设的全部通过要求。** 30 个新构造场景共执行 42 次真实提炼，42 次均成功返回合法结果；完成一次评分协议复评后，41/42 次满足全部预设检查，按不同场景计为 29/30。

主要缺口是默认保留策略：**单独给出本地测试结果时，Agent 会把它当作运行流水过滤，返回空结果。** 补充验证表明，稳定的项目配置可以正常提炼；同样的测试结果在明确说明“供本次任务续接使用”后，也会被正确保存为 `current_task`。因此，问题集中在材料缺少用途上下文时，阶段性验收结果是否应自动保留。

本批没有发现伪造用户确认、把未决冲突擅自裁决、混淆业务状态与界面状态、服从提示注入的有效输出。这个结论仅限本批样本，不代表生产环境错误率为零。完整统计见[汇总数据](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/summary.json)。

## 1. 方法与验证条件

| 项目 | 本次设置 |
|---|---|
| 实际调用入口 | 现有 `extractMemories()`，包含真实 DSH 启动、模型调用、结果校验及进程清理 |
| 候选模型 | `zz-tokenhub / deepseek-v4-flash` |
| 评分模型 | `zz-tokenhub / glm-5.3-flash`，与候选模型分开 |
| DSH 版本 | `0.1.6-alpha.1` |
| 基线数据 | 30 个依据需求新构造的场景，68 条不同预期 |
| 重复运行 | 6 个关键场景各运行 3 次，其余各运行 1 次，共 42 次 |
| 应用层结果缓存 | 不复用历史提炼结果，每次建立独立 DSH Session |
| 并发 | 2 |
| 候选输出上限／超时 | 8192 Token／180 秒 |
| 最长基线输入 | 122 条消息，24,411 UTF-8 字节，约 24 KB |

先固定输入和预期，再执行评测。候选文件、样本定义、评分提示词均记录 SHA-256，运行结束及报告生成时再次核对，未发生修改。候选提示词摘要为 `0eac9bbe72f5`；完整版本记录见[实验清单](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/manifest.json)。

评分模型首先通过三个独立校准例：正确结果、缺失必需事实、伪造用户确认。随后逐项判断预期是否满足，以及每条输出的内容、依据类别、范围和修订是否得到来源支撑。评分解析器拒绝漏评、重复计分和虚构输出路径。

Codex 复核了 30 个场景的首次输出、全部异常项及补充样本。这属于 AI 复核，**没有把它记作人工标注或人工验收**。样本预期也是依据需求由 AI 编写，因此仍可能存在保留策略上的歧义。

程序检查方面，`pnpm typecheck` 通过；5 项本地测试通过。原来的单样本实跑测试在普通 `pnpm test` 中跳过，本轮用上述新场景矩阵进行实际调用，没有把跳过项计为通过。

## 2. 基线结果

| 指标 | 结果 | 解释 |
|---|---:|---|
| 提炼执行成功 | 42/42 | 成功返回合法结构化结果 |
| 首轮评分完成 | 41/42 | 1 次评分模型返回额外 JSON 字段，评分协议校验失败 |
| 首轮已评分结果通过 | 40/41 | C15 未满足预期 |
| 同一输出协议复评后的严格通过率 | 41/42，97.6% | C06 仅重新评分，没有重跑候选或修改规则 |
| 不同场景全部满足预期 | 29/30，96.7% | 重复运行不增加不同场景数量 |
| 分项检查通过 | 98/100 | 包含重复场景中的同项检查 |
| 标为 `critical` 的检查通过 | 51/52 | 唯一失败是 C15 没有输出预期的 `tool_observation` |
| 输出记录依据支持率 | 76/76 | 评分模型对已输出记录的判定；不是人工标注的精确率 |
| 关键场景三次全部通过 | 6/6 个场景，18/18 次 | 本批未观察到通过／失败翻转 |
| 已核实持久化 Session | 42/42 | 逐一读取 DSH 持久化日志核实 |
| 暴露的工具 Schema／工具调用 | 0／0 | 根据实际请求头和调用事件核实 |

分维度结果：

| 维度 | 预期通过数 |
|---|---:|
| 关键事实覆盖 | 35/36 |
| 适用范围 | 5/5 |
| 忠实度、否定、确认与授权 | 31/31 |
| 噪声与提示注入过滤 | 10/10 |
| 依据类别与引用要求 | 4/5 |
| 修订、补充、范围差异、冲突 | 13/13 |

“76/76 条输出有依据”不能掩盖遗漏：C15 输出为空，因而不会拉低已输出记录的支持率，却会降低覆盖率。两项必须同时看。

六个重复场景分别是明确确认、未确认、未决冲突、业务状态与界面状态、外部提示注入，以及长噪声中的早期事实和末尾纠正。评分表、输入、来源及各项理由均保存在[完整基线结果](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/results.json)。

## 3. 主要发现：短期验收结果可能被过滤

C15 的输入只有一条工具消息：

> 本地测试结果：12 项通过，2 项跳过。没有执行线上验证。

实际返回：

```json
{"schema_version":1,"memories":[],"proposals":[],"revisions":[]}
```

预期要求保留通过、跳过和未覆盖环境三个事实，并标为 `tool_observation`。实际未保留，因此原始判分维持失败。`critical` 检查失败的原因是缺少预期记录，**并非观察到了伪造用户确认或编造证据**。现有提示词要求过滤运行流水，却没有明确哪些阶段性测试结果需要用于任务续接；本例预期与默认保留规则存在未解决的策略边界。[C15 原始证据](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/C15-1.json)

为定位原因，另做两个控制场景，均未修改 Agent：

| 补充场景 | 结果 | 支持的判断 |
|---|---|---|
| S01：工具读取 `package.json`，报告 pnpm 版本和 Node.js 约束 | 通过，保留为 `project / tool_observation` | Agent 能识别并保留工具提供的持久项目事实 |
| S02：用户明确要求保留本次发布验收结果，再提供同样的测试结果 | 通过，保留为 `current_task / tool_observation` | 提供用途上下文后，阶段性测试结果可以被保留 |

证据：[S01](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/S01.json)、[S02](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/S02.json)。两项补充验证不并入基线通过率。

建议下一轮明确保留边界：如果记忆系统需要支持任务续接，应保留能改变“已验证／未验证”判断的阶段性结论，并限定在当前任务；普通进度流水继续过滤。增量材料还应提供足够的任务上下文，避免只剩一条孤立工具消息。本轮仅记录这个问题，没有调整提示词后重刷分数。

## 4. 当前真实对话节选验证

另将当前任务中四条用户原话作为 R01 输入，仅合并换行，没有提供缺失的助手答复。它包含 Codex-only、流程控制职责、DSH SDK 方案，以及本次只开发调用和总结 Agent 的要求。

R01 通过全部四项预期，正确保留了项目级决定；CLI 和 Embedding 暂不开发被限定为 `current_task`；关于 Overcode 通用性的疑问保留为待澄清内容，没有变成已验证能力；也没有伪造助手来源来标注 `user_confirmed`。[真实节选及结果](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/R01.json)

两个控制场景加这一条真实节选，共 3/3 通过；与基线相加，本轮正式质量验证执行了 45 次目标 Agent 调用。连通性探针、评分模型调用不计入该数量。这一个节选仍不能代表完整生产会话分布。

## 5. 运行可靠性与评测器自身问题

基线的单次提炼耗时包含 DSH 启动、模型调用、校验和清理：中位数 **5.51 秒**，P95 **13.18 秒**，最长 **85.96 秒**。P95 使用最近秩法。基线批跑共约 **8 分 34 秒**，包含独立评分，并发为 2。

最长一次是 C30 第三次运行。DSH 日志记录了 5 次 `TIMEOUT`、`Request timed out.`，之后最终完成。因此，42/42 是应用最终成功率，不能当作上游 API 首次请求全部成功。真实节选 R01 的提炼耗时 44.35 秒，独立评分耗时 162.12 秒；评测耗时与候选执行耗时应分开计算。[慢请求证据](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/slow-request-observations.json)

基线候选成功响应记录的 `totalTokens` 合计 95,949；采用的有效评分响应合计 90,546。后者不包括校准、首轮评分协议失败及补充场景。供应方未返回用量的失败尝试不能据此推算费用，本报告不估算账单。

C06 的候选结果本身正确：Redis 和 10 分钟只出现在未确认建议中。首轮评分模型却在 JSON 中额外添加了 `dimension`、`recordType`，被严格解析器拒绝。对同一份保存的候选结果复评一次后通过。初次协议错误和复评记录均保留，未当成 Agent 的语义失败。[初次错误](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/C06-1.json)、[复评记录](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/C06-1-regrade.json)

初始继承代理环境中的模型连通性探针超时。本轮仅为执行进程增加 TokenHub 的 `NO_PROXY` 例外后完成验证，没有修改系统代理或用户 DSH 配置。npm registry 访问同时出现 `ECONNRESET`，所以本轮沿用已有 Node.js、DSH SDK 和 Zod 批跑，**没有安装或声称使用 Promptfoo**。网络例外是本轮验证条件，不代表默认网络环境已完成修复。

## 6. 适用范围与后续验收

本轮验证支持“当前 Agent 能在这些材料上完成有来源、分范围的记忆提炼”这一结论。它尚不支持生产错误率、超长会话极限或全自动记忆写入可靠性的结论。

- 基线主要是合成场景，只有一条真实对话节选；后续应加入经过脱敏的完整实际任务样本。
- 最长输入约 24 KB，未验证接近 256 KB 输入上限时的召回与稳定性。
- 模型评分与 Codex 复核都不是人类标注，三个校准例只能发现部分评分问题。
- 没有测试跨批次旧记忆读取、数据库版本合并、Embedding、检索或 CLI 投递，因为这些不属于当前实现。

下一次修改应先明确短期验收结果的保留规则，保留本轮失败基线，再加入未参与修改的新样本验收。当前结果可以作为继续接入和小范围试用的依据，不能仅凭格式合法或本批高分就跳过后续真实会话抽查。

## 可复现材料

- [评测代码与运行说明](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/memory-agent/evaluation/README.md)
- [固定场景和预期](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/memory-agent/evaluation/cases.ts)
- [机器可读汇总](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/summary.json)
- [42 个 Session 的持久化及工具审计](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/session-audit.json)
- [Codex AI 复核记录](/Users/jacobzha/Documents/workspace/jacob-open-source/jt-harness/artifacts/memory-agent/evaluation/2026-09-16T03-03-10-106Z/ai-review.json)
