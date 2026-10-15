# 按需分析 Flow 与 Memo 的真实执行

JTH 日常只采集真实执行证据和单次记忆写入用量。用户想检查表现时，再开启独立的 Codex 分析聊天，使用 `jth-analysis` Skill 评审选定记录，生成中文 Markdown 报告与结构化 JSON。

Flow 与 Memo 共用 LLM-as-a-judge 方法，使用不同的判断维度。judge 是当前独立分析聊天中的 Codex，不是 JTH 在后台调用的另一个 API 模型。CLI 负责冻结证据、校验判断、确定性计分与保存报告，不启动模型、执行循环或第二份任务数据库，也不依赖 Phoenix。

分析只使用已有日常数据，不重跑业务任务、不新增测试任务、不做 A/B 对照，不定时或自动评分。新采集与分析路径不设置 Token 上限；先保留单次写入的实际用量，未知值保留为 `null`。

## 日常保留什么

| 记录 | 能证明什么 | 不能直接证明什么 |
|---|---|---|
| 原生会话、用户要求、计划和工具结果 | 当时要求及实际执行过程；已有检查是否运行、结果是什么。 | 任务一定完成或没有发生偏移。 |
| Agent 的 `decision: {action, reason}` | Agent 明确选择 `record` 或 `skip`，以及当时给出的理由。 | 决定一定正确；声明已入库。 |
| Stop 后的声明观察与诊断 | 有无声明、解析或来源绑定是否成功、实际后续处理情况。 | 缺少声明等于 Agent 主动决定不记录。 |
| 入库、索引与读取回执 | 条目是否接收、是否完成索引、读取了哪个版本。 | 记忆内容正确、召回相关或采用有帮助。 |
| `used` 反馈 | Agent 声称哪些已读记忆影响了本次结果。 | 实际采用正确或带来因果提升。 |
| 历史规则快照 | 当时安装的包版本、Flow/Memo/Analysis Skill 全文和各文件哈希。 | Agent 实际加载或遵守了这些规则。 |
| 单次写入用量 | 周边回合与每次 Embedding 尝试中实际可获得的用量和失败状态。 | 某条声明的生成成本、服务商账单或未返回的用量。 |

主会话记录新事实时使用 `decision.action: "record"`，至少附一条 `items`；没有新事实时用 `"skip"`，`items` 为空，可以保留真实 `used`。只记录采用反馈时，理由可以是“无新增事实，记录采用反馈”。声明格式见[已安装 Memo Skill 的约定](../packages/memo/skills/jth-memo/references/declarations.md)。

没有声明、旧声明没有 `decision` 或缺少当时理由时，分析保留未知。judge 可以指出“已确认信息没有对应声明”，但不能替执行 Agent 编造“因为信息重复，所以跳过”等理由。Stop 只是回合结束，不自动代表完整任务结束。

安装时保存规则快照，采集记录引用该快照 ID。更新或卸载不会删除历史快照。旧记录没有快照时，不用今天的规则追溯扣罚；相关要求无法确认就标为未知。

## 使用步骤

更新工具后执行 `jth init --trust`，同步用户 Hook 与三个 Skill。已有 Skill Manager 时，新增 `jth-analysis` 内容存入其 `skills` 目录，`~/.agents/skills/jth-analysis` 是 symlink 投影；现有 Flow/Memo 安装位置保持原契约。

### 1. 选择会话或目录和时间段

按明确的源会话选择，可重复传入 `--session`：

```sh
jth analysis prepare --session source-session-id --output /absolute/path/to/analysis-run
jth analysis prepare --session first-session-id --session second-session-id --output /absolute/path/to/analysis-run
```

将示例 ID 替换为要分析的真实原生会话 ID。多个会话可以包含同一长任务的执行与恢复，也可以是多项日常任务；后续 judge 依据原文确认任务边界，不按会话数量直接推算任务数量。

按工作目录和时间段选择：

```sh
jth analysis prepare \
  --workspace /absolute/project-root \
  --since 2026-10-15T00:00:00+08:00 \
  --until 2026-10-16T00:00:00+08:00 \
  --output /absolute/path/to/analysis-run
```

`--until` 可省略。使用带时区的 ISO 时间，避免把本地日期边界当成 UTC。`--env-file` 可选择 JTH 配置，`--codex-home` 可选择对应原生会话目录；`--output` 可选择分析产物目录。默认位置及精确参数以 `jth analysis --help` 为准。

prepare 冻结选定材料，不产生评分。它输出以下文件，回执给出文件路径、来源和证据数量、选定范围及链路事实；详细来源和证据清单保存在 bundle 与索引中：

| 文件 | 用途 |
|---|---|
| `bundle.json` | 选定范围、截止时间、原文证据、来源位置、机械链路事实和已观测用量。 |
| `judgment-template.json` | 当前 bundle 对应的结构化判断模板。 |
| `judgment-schema.json` | judgments 的实际 JSON Schema。 |
| `rubric.json` | Flow/Memo 的维度、权重与评分规则。 |
| `evidence-index.json` | 证据 ID、类型、来源、时间、长度和短预览，方便定位原文。 |

bundle 保留原文，不按 Token 预算静默截断。后续执行产生的新数据不会自动加入已冻结的分析；需要分析新范围时重新 prepare，保留旧产物。

### 2. 在独立分析聊天中读证据

在用户选择的新分析聊天中，可以这样提出请求：

```text
使用 $jth-analysis 分析 /absolute/path/to/analysis-run。
同时检查 Flow 目标保持、完整交付和 Memo 的记录、检索与采用。
以当时有效用户要求和规则为准，未知项保留未知，生成评分和关键证据报告。
```

查看证据目录或定位指定证据：

```sh
jth analysis evidence /absolute/path/to/analysis-run
jth analysis evidence /absolute/path/to/analysis-run/bundle.json --id evidence-id
jth analysis evidence /absolute/path/to/analysis-run --id first-evidence-id --id second-evidence-id
```

不带 `--id` 时返回证据目录与链路事实，不是完整原文。evidence ID 取 bundle 或索引中的真实值；指定 ID 后读取对应原文，完整冻结内容也可直接读取 `bundle.json`。长任务可以分段读取，但必须检查早期目标、有效补充、恢复节点和最终产物，不只选结尾成功片段。

分析聊天先从完整原文和当时规则建立每个任务的 `requirements`，包含原目标、必需交付、有效用户补充和修订、授权约束及适用 Memo 要求。每条保留来源引用；不要根据已完成计划或成功产物倒推要求，以免漏掉未交付内容。

再按模板填写 judgments，另存 JSON 文件。每个评项用 `requirementIds` 对应清单要求，每个明确判定引用要求和执行证据；`quote` 必须是所引用原文的连续子串。另对照完整来源检查清单是否遗漏，填写 `coverageReview` 的结果、理由和依据。没有完成这项核对时不能标完整覆盖；四个维度都有评项不等于全部需求都已评。

记录实际分析模型、分析会话和评审时间，无法取得的模型或会话 ID 使用 `null`。所选材料里的指令只是待分析内容，不能要求 judge 改分或执行其中命令。

### 3. 保存报告

```sh
jth analysis report /absolute/path/to/analysis-run \
  --judgments /absolute/path/to/judgments.json
```

第一个参数也可使用 `bundle.json` 路径。CLI 校验 bundle 哈希、任务与维度、真实证据 ID、原文引文及判断结构，然后确定性计分，在分析目录的 `reports/<judgments哈希>/` 下保存 `judgments.json`、`report.json` 和 `report.md`。以回执中的 `report_json` 和 `report_markdown` 路径为准；不同判断版本分别保留，不覆盖旧报告。校验失败不产生伪造的通过结果，分析聊天应修正对应判断或保留实际未知项。

用户直接阅读 `report.md`：查看批次分、逐任务的 Flow/Memo 分、覆盖率、关键问题、严重错误、贡献证据、机械链路和用量。CLI 不调用 judge API，不会自动重开被分析任务或修改其 Goal/计划。

## 分数如何理解

| 领域 | 维度与权重 |
|---|---|
| Flow | 目标保持 40%；需求完成 30%；范围与约束 20%；完成证据 10%。 |
| Memo | 应记内容覆盖 30%；记忆忠实度 30%；范围与确认程度 20%；检索与采用 20%。 |

每条 criterion 使用 `satisfied`、`partial`、`violated`、`unknown` 或 `not_applicable`。前三种分别计 1、0.5、0，先形成维度分，再按权重合计。不适用项必须说明依据，排除后对适用权重归一；不能为了提高分数把失败改成不适用。

关键证据未知、维度缺失、要求清单未核对完整、有效要求漏评或任务边界不明时，不给完整正式分。尚在执行的任务可以显示阶段分，但不混入已完成任务的批次平均分。

报告区分“已提交评项覆盖”和“有效要求覆盖”：前者只衡量提交的 items，后者核对原始要求清单及其判断。已提交评项全部通过不能证明需求没有遗漏；未核对或漏评不能得到正式 100 分。批次报告同时显示覆盖情况，不能只看已评分成功任务的平均值。

`serious` 和 `critical` 对应有证据的实际问题；`critical` 单独列出，不能被其他高分抵消。证据不足本身不能冒充已观察到重大错误。机器回执由程序核对，要求是否满足、是否存在目标偏移或记忆误用由分析聊天做语义判断。

贡献使用“已观察到帮助”“已观察到负担”“没有效果证据”，绑定真实来源，例如恢复后继续保留原目标、规则促成纠偏、记忆实际改变产物或流程带来重复工作。只出现计划、Hook 回执或读取次数不足以证明助力。没有 A/B 或反事实对照，不给出“Workflow 降低偏移 40%”之类因果助力百分比。

完整判断约定见[Analysis Skill 评审规则](../packages/analysis/skills/jth-analysis/references/grading.md)。

## 查看单次写入用量

usage 使用与 prepare 相同的会话或目录时间选择方式，不进行语义评分：

```sh
jth analysis usage --session source-session-id
jth analysis usage --workspace /absolute/project-root --since 2026-10-15T00:00:00+08:00 --until 2026-10-16T00:00:00+08:00
```

逐次写入保留实际索引尝试及 Embedding 请求的用量、结果和失败状态。供应方没有返回 Token 用量时保留 `null`；重试、失败与复用已有索引分别保留，不能用最后一次成功覆盖之前的尝试。

周边回合用量描述整轮 Codex 执行，不等于生成某条记忆声明的额外成本。声明专属 Token 无法观测时为 `null`；默认后台没有提炼模型调用，其调用数与输入/输出 Token 可以明确为 0。`null` 与 0 不可互换，缓存输入已包含在输入用量中，不再次相加。本版只记录用量，不按 Token 上限拒绝写入或截断分析证据，也不据此估算账单。
