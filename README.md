# jt-harness

本地 `jth` CLI。当前 Codex 会话提取可复用记忆，正文先落库，后台只负责 Embedding 与索引发布。默认路径不启动 DSH，不把整段会话交给第二个模型。

## 模块

- `packages/memo`：来源与候选契约、PostgreSQL/pgvector、版本校验、修订、索引任务和查询。`./legacy` 单独提供旧 DSH 导入。
- `packages/codex-hooks`：六阶段 Hook、会话身份与原始证据、候选文件暂存。不会自动生成总结或执行 SQL。
- `packages/cli`：命令解析、配置、投递编排、后台进程启动；调用前两个 package。

根目录 `bin/jth.mjs` 是稳定入口，保留已安装 Hook 的命令和信任信息。

## 本地使用

需要 Node.js 24.21+、pnpm 10、PostgreSQL 15+ 和 pgvector。本机已使用 PostgreSQL 18.6 / pgvector 0.8.6。

```sh
pnpm install
pnpm build
# 首次安装时复制模板；不要覆盖已有密钥配置。
cp .env.example .env
chmod 600 .env
node bin/jth.mjs memo init
```

已有 `.env` 请直接保留。配置 `JTH_DATABASE_URL`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`EMBEDDING_API_KEY`；文件被 Git 忽略。环境变量覆盖文件值；`--env-file` 可指定文件。默认数据目录为 `~/.jth`，可用 `JTH_DATA_DIR` 调整。

当前为本地 workspace 交付。DSH SDK 链接仅供 legacy adapter 开发和评测；普通调用不需要 DSH 服务在线。不是独立发布的 npm 安装包。

`memo init` 事务性迁移到 schema v4，保留旧正文、来源、向量和回执。旧任务标记为 `legacy`，默认 worker 不再处理它们。

## 写入与读取

```sh
jth memo prepare --session <当前真实会话ID>
jth memo evidence <evidence-id> --message <message-id>
jth memo record <record.json>
jth memo status <返回的submission-id>
jth memo search '查询内容' --project jt-harness
jth memo read <entry-id>
```

`prepare` 默认预览最近 12 条用户/助手消息，最多 40 条；工具材料必须显式使用 `--include-tools`。`--before <message-id>` 向前翻页；可重复 `--message <message-id>` 精确选择来源。超过预览的正文用 `evidence` 读取。来源来自已登记会话的原始 JSONL，不允许提交者自填会话文本或伪造消息 ID。

`record.json` 示例（替换真实 ID）：

```json
{
  "evidence_id": "prepare 返回的 evidence-id",
  "extraction": {
    "schema_version": 1,
    "memories": [{
      "content": "独立、可复用的事实",
      "scope": "project",
      "source_message_ids": ["真实消息 ID"],
      "basis": "user_statement"
    }],
    "proposals": [],
    "revisions": []
  },
  "changes": []
}
```

当前 Agent 负责选择值得记忆的内容。用户明确声明使用 `user_statement`；用户确认助手建议需要同时引用建议及后续确认，使用 `user_confirmed`；工具观察使用 `tool_observation`。未确认的建议留在 `proposals`，不会直接成为用户事实。程序验证来源角色、顺序、原文、作用域和修订权限，但不能保证模型的语义概括永远正确。

`record` 先保存本地材料，再在同一个数据库事务中保存正文及索引任务。`accepted` 表示正文已保存，`index_status=complete` 才表示向量已发布。数据库断开时返回 `staged`、退出码 1，材料保留；不能将其视为已入库。相同候选重复提交返回同一批次，不自动进行语义去重。

正文可立即通过 `read --submission <id>` 检查。语义 `search` 依赖已完成的向量。当前仅持久化短小候选和明确修订，不把整个工具日志作为记忆。

## 更正与并发

明确更正先 `search` 找到旧条目，再 `read` 获取 `version`。在 `changes` 中声明 `previous_entry_id`、`expected_version`、`current_memory_index`、`kind`、`revision_index`、`source_message_ids`、`evidence_quote`、`explanation`、`resolved_revision_conflict_ids`。

- 提交时旧版本已变：拒绝本次提交，旧事实不变；重新读取后生成新的决定。
- 接受后、索引发布前旧版本改变：新条目保留为待审核候选，旧事实不被覆盖。
- 有效修订和向量在一个事务中发布；时间、生效区间、作用域、证据规则继续适用。

没有明确证据就不猜测替代关系。自动语义去重、自动发现全部矛盾不属于后台 worker 的职责。既有 review、archive、历史读取功能保持可用。

## Hook

```sh
jth memo codex install --project jt-harness
jth memo codex status
jth memo codex uninstall
```

仅配置当前项目 `.codex/hooks.json`，保留其他工具的处理器和原来的安装时间：

- `SessionStart` / `SubagentStart`：登记来源，注入会话内提交说明。
- `Stop` / `Interrupt` / `SessionEnd` / `SubagentStop`：保留原始来源、唤醒待投递和索引任务。

这些 Hook 不调用另一个模型。Agent 若没有主动 `record`，Hook 不会凭空补出总结；中断时只保留已产生的材料。子 Agent 的委派内容属于助手材料，不能冒充用户确认。父会话继承片段不重复导入。

新装 Hook 需要 Codex 加载并信任配置。已安装入口不变时，恢复/开始会话后加载新说明；本轮已收到新的原生 `SessionStart` 登记。

## 恢复与状态

```sh
jth memo work                  # 投递本地候选，处理 index 任务
jth memo retry <submission-id> # 重试失败的 index 任务
jth memo status               # index_counts 与 legacy_counts 分开
jth memo codex status         # 登记会话、本地候选、投递错误
jth memo doctor               # 只读一致性检查
jth memo review list
jth memo stats
```

不增加队列服务。PostgreSQL 的 `jobs` 表保存索引状态；单 worker 锁避免重复发布。失败不无限重试；下一次 Hook/`memo work` 可以恢复中断任务，明确失败使用 `retry`。Embedding 重试复用已落库正文，不重新提取。

本地材料在 `~/.jth/codex`：`inbox/events` 保存登记，`sources` 保留原始日志，`evidence` 保存选定证据，`records/record-errors/receipts` 保存投递状态。后台日志在 `~/.jth/worker.log`。PostgreSQL 内容通过数据库客户端或 `jth memo read` 查看，不把其数据文件当普通文档编辑。

## 旧 DSH 流程

仅在明确需要重放旧任务或导入历史会话时使用：

```sh
jth memo send <submission.json> --legacy
jth memo work --legacy
jth memo retry <legacy-submission-id> --legacy
```

`JTH_DSH_PROVIDER` / `JTH_DSH_MODEL` / `JTH_DSH_TIMEOUT_MS` 只影响这条旧路径。旧失败任务保留，默认不会重新启动 DSH。模型提炼和历史质量评测资料在 `packages/memo/src/agents`。

## 验证

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:postgres
# 真实 API 与数据库，隔离的合成来源；完成后归档测试条目。
node scripts/verify-inline.ts --live
```

详细结果见 [会话内记忆重构验收](docs/inline-memory-verification.md)。真实 API 验收与原生 Hook 触发证据分别记录，不把合成事件当成原生端到端证明。
