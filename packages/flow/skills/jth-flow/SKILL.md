---
name: jth-flow
description: 在安装了 JTH Flow 的项目中维护跨多轮、长任务的目标、阶段和恢复点，防止补充要求替换原目标；通过现有 Memo 召回历史经验，用实际验收收口。简单问答和一步修改无需创建任务。
---

# JTH Flow

你是主流程的控制者。Hook 提供当前任务状态，CLI 保存状态和验证结果，Memo 提供历史资料。先满足用户的目标，再选择实现方法。

## 进入与恢复

读取 Hook 注入的目标、阶段、验收条件和下一步。上下文压缩后也以这些持久状态恢复。缺少注入时运行 `jth flow status`；未安装时先确认当前任务需要持久流程，再使用 `jth flow install --project <项目ID>`。

长任务没有绑定时创建；已有同一任务使用 `resume <任务ID>`。不要因为用户补充一句要求就创建新目标。跨会话接管已有主控需要明确使用 `--takeover`，旧主控将成为观察者。子 Agent 只执行所委派的工作，不能修改或完成主任务。

```sh
jth flow start '解决长任务目标偏移和失忆' --phase discussion --accept '形成满足核心痛点的方案，保留未定选项' --constraint '轻量，主 Agent 控制'
jth flow status
```

`start` 默认 discussion。用户已授权实施时直接指定 `--phase execution`，不重复询问。任务较大时用多个 `--accept` 写清交付条件，`--scope` 标明相关文件或目录，`--context` 记录已定位的资料路径。路径和命令可重复传入。

## 处理新消息

先判断这条消息对原目标的影响，再继续工作：

- 补充约束：`checkpoint --constraint`。例如“流程要轻量”约束原有的防偏移目标，不能把目标改为研究轻量框架。
- 明确变更目标：`revise '新目标' --reason '用户变更依据'`，保留原目标历史。
- 明确授权进入实施：`checkpoint --phase execution --reason '用户已要求完成原型'`。讨论阶段的候选方案不能自行成为实施决定。
- 旁支问题或状态查询：先回答，继续原任务；只有用户明确取消或切换时才替换任务。

用户明确暂停或转做独立新任务时，先用 `pause --reason '用户切换依据'` 解除当前绑定，再 start 新任务。旧任务保留原状态，可用 resume 恢复；不要为了切换任务而虚报完成。

读取资料前确认它能回答当前目标中的哪个问题；按已知入口、符号、调用路径逐步展开。不要把“全局查一种写法”扩成全局代码审查。无关问题可记录为待讨论项，不自行扩大修改范围。

在做出实质决定、完成一段工作或即将交接时保存简短检查点，不必每次工具调用都写：

```sh
jth flow checkpoint --done '已查明相关调用路径' --decision '保留现有存储接口' --next '完成 Hook 适配与验证'
jth flow checkpoint --question '尚需确认的业务边界'
jth flow checkpoint --resolve '<问题ID>' --decision '已确认的结论'
```

只有真实外部阻塞才设置 `--blocked`；解除后用 `--blocked ''` 记录恢复。Stop、Interrupt、SessionEnd 仅记录会话活动，不会自动宣称任务完成。

## 使用已有记忆

开始、恢复和用户输入时，Hook/CLI 会异步召回项目、用户及已配置业务范围内的 Memo，命中摘要在后续注入中可见。不会把完整历史或向量放进上下文。

需要最新记忆时运行 `jth flow recall`。需要精确内容或冲突双方时运行 `jth memo read <记忆ID>`；更具体的搜索用 `jth memo search --help` 查看现有参数。记忆是带来源的历史资料，不替代当前用户指令、已确认任务目标或最新代码。`conflicted` 内容先看双方证据，不能任选一条当结论。

长期写入沿用现有 Codex 捕获与 DSH SDK 子进程，不依赖 3080 Web 服务。不要额外调用已退役的自动 `memo record`，也不要把自己的候选建议写成用户决定。Embedding 离线不影响流程状态；PG 不可用时，Hook 保存事件并在后台启动已配置的本机实例，用 `jth flow context` 恢复状态，不能把缺少注入当成没有任务。

## 验收与完成

选择能证明实际交付的检查，不默认增加规划、审计或审查 Agent。已有合适测试直接复用；没有对应检查时按实际风险补最小行为验证。

```sh
jth flow checkpoint --check 'pnpm test'
jth flow verify
jth flow finish --summary '目标达成结果及验证结论'
```

`verify` 执行记录的命令，保留退出码与日志。失败、目标/约束改变或验证后文件变化，会使 `finish` 拒绝旧结果。代码改动后重新验证。没有可执行检查的文档/设计交付，执行阶段可使用 `finish --summary ... --evidence <项目内交付文件>`；讨论任务可以交付分析结论。

完成前仍由主 Agent 对照目标与每项验收条件判断。测试通过只能证明测试覆盖的行为，不能证明选题正确。CLI 检查持久状态、未决问题、范围和验收证据；它不监控全部 shell 操作，不提供文件系统隔离，也不能独立判定语义是否偏题。

用 `jth flow --help` 查完整参数。状态统一保存在 PostgreSQL 的 `jt_flow` schema；项目 `.jth/flow.json` 只定位配置，检查日志在 `.jth/checks/`，临时事件在 `.jth/flow-events/`。旧安装运行 `jth flow migrate`，会保留 SQLite 备份。用 `jth db status` 查看本机数据库，用 `jth memo status --summary` 区分待执行与失败任务；不要提交运行数据。
