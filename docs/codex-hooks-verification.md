# Codex 六阶段自动投递验证

> 历史验证：本文记录旧 DSH 六阶段采集；当前默认只用 Memo Stop 声明入口，Flow 另有 UserPromptSubmit 短提示。现行操作见[文档导航](README.md)。

验证日期：2026-09-17（Asia/Shanghai）。实现位于现有 TypeScript `jth` 项目，没有引入 Rust、HTTP 服务或额外依赖。

## 交付与启用

新增 `jth memo codex install / uninstall / status / capture`。安装器只注册 `SessionStart`、`Stop`、`Interrupt`、`SessionEnd`、`SubagentStart`、`SubagentStop` 六个事件，保留已有 Hook。六个事件共用采集入口，慢处理复用现有 `memo work`、DSH Agent、Embedding 和 PostgreSQL 队列。

本机已安装到 jt-harness 项目的 `.codex/hooks.json`，项目范围为 `jt-harness`。通过 Codex CLI 0.153.0 的原生 `/hooks` 页面逐项检查并信任了这六个定义；没有使用跳过信任参数，也没有信任另外四个待审的第三方 Hook。界面确认这六类新增定义全部处于活动状态，证据保存在 `artifacts/jth/codex-hook-trust-ui.txt`。

真实 CLI 正常关闭触发了 `SessionEnd`。`jth memo codex status` 已显示该原生会话的接收状态、零待投递事件、无来源错误。此次配置检查没有向 Codex 提交开发任务或启动真实子 Agent。

## 数据流与恢复规则

1. Hook 校验来源路径，只读取指定 CODEX_HOME 下的会话文件，在本地保存交接记录并保留来源硬链接，然后启动独立 worker。成功时 stdout 为空，不改变 Codex 的继续或停止决定。
2. 后台按父/子会话和明确的项目范围维护独立游标。子 Agent 的来源 ID 使用 `agent_id`，正文保存父会话关联；委派文本按助手来源处理。
3. 完整 JSONL 行才会消费。文本消息、助手报告、工具结果转为既有提交契约；系统和开发者指令、推理、重复的压缩表示不进入记忆材料。长文本按 Unicode 字符边界拆片。
4. 批次在尝试入库前固定；只有收到 PostgreSQL 持久化接收回执才推进游标。数据库失败或回执丢失时重发同一个固定批次，而不会用增长后的会话覆盖它。
5. 最多保留两条前序对话作为 `context_only`，解释用户确认和修订。新增输出必须引用至少一条新增消息。旧版本输入不带这些可选字段时，原有序列化和哈希保持不变。
6. 启动/恢复和 `memo work` 补采已登记会话。卸载停止继续投递新内容；既有记忆、未完成批次和来源仍保留。

数据库 schema 仍为 v3。本次仅扩展可选的来源元数据和上下文标记，不修改既有记忆状态、冲突、更正或审核规则。

## 自动验证

- TypeScript 类型检查与生产构建通过。
- 默认离线测试：15 通过，3 个需要外部环境的测试按既有约定跳过。
- 临时 PostgreSQL + pgvector：15 个场景通过；Node 测试器计入父测试后报告 16 通过。
- 新增测试覆盖六事件重复触发、父子来源隔离、委派不冒充用户、跨批确认上下文、前序事实不可单独重发、回执不确定后重放、日志增长和删除、UTF-8 半行、长消息完整拆片、不同配置隔离、错误线程/父会话、游标前日志被改写、配置合并、重复安装和卸载停止投递。
- 实际读取当前主会话和一个已有子会话的日志，验证当前 Codex 格式与角色映射。该项只做本地解析，不将这些历史会话发送给模型，记录见 `artifacts/jth/codex-real-transcript-check.json`。
- 将数据库地址指向不可连接的测试端口后，编译后的采集 CLI 仍在 81 毫秒内返回成功、stdout 为空，本地保留 1 条待投递事件。证据见 `artifacts/jth/codex-database-offline-result.json`。

复现：

```sh
node node_modules/typescript/bin/tsc --noEmit
node scripts/build.mjs
node --test src/codex.test.ts
node --test memory-agent/*.test.ts memory-agent/evaluation/*.test.ts src/*.test.ts src/memo/*.test.ts
node scripts/test-postgres.mjs
```

构建完成后再执行 CLI 验证，避免清理 `dist` 时与正在启动的 Hook 或 worker 冲突。

## 真实 DSH、Embedding 和数据库验证

通过编译后的 CLI 依次回放六种 Hook 输入，使用独立合成项目 `jth-codex-live-1789574971505`，实际调用 `.env` 中配置的：

- DSH：`deepseek-official / deepseek-v4-flash`。
- Embedding：阿里云 `qwen3.7-text-embedding-flash`，1024 维。
- 数据库：本机 PostgreSQL `jth`，独立测试项目范围。

六次采集进程分别耗时 76、66、72、67、69、75 毫秒，stdout 均为空。此耗时只覆盖该本机样本的短交接，不等待模型或向量写入。

重复事件最终产生两个批次，均为 `complete`，没有错误：

| 来源 | 结果 | 向量发布回执 |
| --- | --- | --- |
| 主会话 | 2 条用户陈述，其中默认请求超时为 17 秒 | `d1d77b95-7e3a-406f-b496-0c82a88b3f11` |
| 子 Agent | 1 条建议，3 次重试保持 `candidate` | `b7ff6302-e983-43a9-be8a-bb4990eb1957` |

默认搜索能召回 17 秒超时；子 Agent 的 3 次重试建议只在包含候选的查询中出现。完整来源、状态和搜索结果保存在 `artifacts/jth/codex-live-result.json`。

最终本机库 `doctor` 通过，10 个任务均为 `complete`；生产采集目录待投递事件为 0、来源错误为 0。离线故障测试使用独立目录，未污染生产采集进度。

## 验证边界

- 六类事件的完整投递链路使用真实 CLI 加合成 Hook 输入验证。原生 Codex 已验证定义加载、逐项信任和 `SessionEnd` 触发；尚未在真实并行子 Agent 任务中观测所有原生生命周期事件，不能把回放当作这项证据。
- Hook 采用短同步落盘加独立后台进程，不承诺零毫秒开销。数据库不在线时仍可接收本地交接，但后续记忆发布需要数据库恢复。
- 原始来源保留使用硬链接，要求 CODEX_HOME 与 JTH_DATA_DIR 位于同一支持硬链接的文件系统。没有自动回收来源硬链接的策略。
- 目前按项目安装，默认只采集安装后的新内容。其他项目需要分别安装并指定项目 ID；没有全局扫描或历史自动导入。
- 采用显式事件唤醒，没有新增计时器或常驻监听服务。没有下一次唤醒时，遗漏内容等待后续 Hook 或手动 `memo work`。
- Codex 不保证 transcript 格式稳定。格式校验、来源身份或游标校验失败时保留状态并报告错误；新增事件表示需要针对实际版本更新适配。

官方行为依据：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)。
