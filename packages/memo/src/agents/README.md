> 默认 `jth memo send / work` 使用此 DSH Agent；`record / work --index` 仅处理手动候选。

# DSH 记忆提炼 Agent

状态：2026-09-16，用户确认 Agent 测试收口，当前版本继续使用。C15 的孤立测试流水过滤不列为待修复缺陷；完整系统现通过 [jth CLI](../README.md) 提供接收、后台处理、Embedding 与持久化。

本目录交付可以直接调用的 TypeScript SDK 模块和专用 DSH Agent 配置，负责提炼与关系比较。CLI、队列、Embedding 和数据库由 `src/` 中的确定性代码负责。

v2 新增独立关系比较阶段：`reconcile.ts` / `reconcile.md` 接收程序限定的旧记忆候选、本批事实和未决冲突，输出 correction/supplement/conflict 及原文证据。两个阶段共用 `runtime.ts` 的无工具运行器。比较 Agent 无法自由搜索或修改数据库，发布由存储事务负责。详见 [修订验证报告](../docs/memory-revisions-verification.md)。

v3 在既有来源/角色规则上新增原子事实、原文实体标识和有证据的有效期字段。新运行使用严格的 `agentExtractionSchema`；读取旧检查点时仍兼容未提供元数据的原契约，保持旧哈希和历史内容。原有 C15 等语义评测不重新开启，新增能力单独验证。详见 [存储增强验证](../docs/memory-storage-v3-verification.md)。

## 运行

当前环境复用相邻的 `../deepseek-harness` 已构建 SDK 和运行时，验证版本为 `0.1.6-alpha.1`。`package.json` 中的 `link:` 依赖绑定这份本地安装，不是独立发布包；目录移动或 DSH 升级后需要重新核对路径和兼容性。TypeScript 由 Node.js 24.21+ 直接运行，类型检查复用 DSH 已安装的 TypeScript，没有新增 TS 执行器。

在 `jt-harness` 根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --silent memo:extract packages/memo/src/agents/example.json
```

`example.json` 是根据讨论整理的非敏感验证样本，包含助手建议、任务临时约束、业务状态纠正，以及一条用来验证资料隔离的提示注入文本。用自己的 JSON 文件替换它即可。输入应是调用方已脱敏的文本材料。

`runtime.json` 已指定本机配置中的 `zz-tokenhub / deepseek-v4-flash`。凭据和 provider 路由继续由 DSH 的设置与 credentials 服务读取，没有将 API Key 复制到本项目。第二个文件参数可以指定另一份模型配置：

```sh
pnpm --silent memo:extract /absolute/path/conversation.json /absolute/path/model.json
```

成功时 stdout 只有 JSON；参数、模型调用或结果校验失败时退出码为 1，诊断输出到 stderr。`pnpm --silent` 用于避免 pnpm 自己的命令提示混入 JSON。

## SDK 调用

```ts
import { extractMemories } from '@jt-harness/memo/legacy'

const result = await extractMemories(submission, {
  provider: 'zz-tokenhub',
  model: 'deepseek-v4-flash',
  maxTokens: 8192,
  timeoutMs: 180000,
})

console.log(result.run.session_id)
console.log(result.memories)
```

每次调用创建独立的 DSH SDK 运行时和新会话，模型在初始化时指定，不修改 Web 的全局默认模型。可选 `reasoningEffort` 使用所选 adapter 支持的值，DSH 会拒绝不支持的组合；省略时采用该模型默认值。`dshBin` 可以指定另一份兼容的 DSH JavaScript CLI 模块，`dshHome` 可以指定另一个 DSH home。

SDK 启动本机 `dsh` 子进程，不请求 `http://127.0.0.1:3080`。函数的 Promise 等待本次提炼结果；它不提供队列回执，也不是脱离调用者存活的后台服务。`jth memo send` 负责持久化接收和启动后台 worker，避免 Hook 等待这个 Promise。当前目录的运行入口仍用于直接验证 DSH 侧能力。

## Agent 和数据职责

`agent.md` 定义提炼规则，`contract.ts` 同时提供运行时校验、TypeScript 类型和给模型的 JSON Schema。原始会话作为独立 JSON 用户消息传入，不拼接到 system prompt 中；资料内的角色与命令不改变提炼 Agent 的职责。

Agent 通过 `sdk-minimal` 加载 `agent.cordis.patch.yml`：关闭 shell 与 MCP 资源工具；不加载项目指令、Skills、文件工具、Web 工具或子 Agent；增加 DSH 原生 settings、credentials 和多模型 adapter。主模型请求没有工具 Schema。独立运行时工作目录为 `artifacts/memory-agent/workspace`，jth worker 使用 `JTH_DATA_DIR/agent-workspace`，原项目与业务范围由输入显式提供。

输入字段见 `example.json`：

- `submission_id`、来源会话 ID 和消息 ID 用于关联材料；直接重复调用本函数会建立新的 DSH 会话，`jth memo send` 则提供持久化幂等队列。
- `messages` 按原会话顺序排列，角色仅为 `user`、`assistant`、`tool`，每条保留原文和唯一 ID。
- `scope.project_ids` 和 `scope.business_ids` 分开。未知范围使用空数组，不从目录名推断业务归属。
- 单批最多 1000 条消息、序列化后最多 256000 UTF-8 字节。超限明确失败，不截断。拆批必须保留确认与纠正所需的上下文。

返回值的 `status` 固定为 `extracted`，不表示记忆已经落库：

- `memories`：带依据类别、适用范围和消息引用的知识候选。临时任务约束标为 `current_task`，后续消费者不应把它们直接当作长期偏好。
- `proposals`：未确认的助手建议或推断。
- `revisions`：本批材料内的补充、纠正、范围差异和未解决冲突，保留两端内容及引用。这里不修改旧知识或生成数据库版本。
- `run`：本次 DSH Session ID 与模型路由。调用方提供的来源和范围由程序回填，不由模型编造。

程序验证 JSON 格式、字段、来源存在性、依据与角色的一致性、确认顺序以及范围是否提供。它拒绝失败、取消或 token 截断的运行，拒绝额外工具和未知消息引用。格式与角色检查不能证明语义真实，候选内容仍可能存在模型误判；没有把“JSON 合法”宣称为“知识已确认”。

超时会关闭本次 SDK 运行时；成功和异常也都会通过 SDK 清理子进程。不自动重做语义提炼，底层网络重试沿用 DSH。调用者强制终止进程时不提供队列恢复保证。

## 记录与验证

DSH 会话日志使用现有 `$DSH_HOME/sessions`，默认 home 为 `~/.dsh`，编码与本机 Web 服务保持一致（`zstd`）。提炼结果示例保存在 `artifacts/memory-agent/example-result.json`；日志可追溯不等于已写入记忆数据库。当前不保证 SDK Session 自动出现在 Web Workspace 侧栏。

```sh
pnpm typecheck
pnpm test
pnpm test:live
```

前两项不调用模型。`test:live` 使用现有 DSH 凭据执行真实提炼，校验项目范围、未确认建议、任务范围、纠正来源及资料中的提示注入，并保存提炼结果。`artifacts/memory-agent/verification.json` 记录本次人工验收的持久化日志证据；重新运行测试不会自动更新这份验收快照。

本模块只把已给出的材料转成记忆候选。自动读取旧记忆、跨批次合并、冲突裁决、Embedding、数据库写入、CLI 传输和 Web 管理界面需要各自后续实现。

批量质量验证另见 [评测说明](evaluation/README.md) 和 [2026-09-16 验证报告](../../../../docs/memory-agent-evaluation-2026-09-16.md)。报告区分程序运行成功、语义预期、评分协议错误及保留策略缺口。
