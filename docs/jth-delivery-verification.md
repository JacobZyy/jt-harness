# jth 本地 CLI 交付验证

本文记录 v1 首轮交付及图形客户端连接验证，随后有 [v2 修订](memory-revisions-verification.md)和 [v3 存储](memory-storage-v3-verification.md)交付。当前默认入口、v7 存储及独立 npm 分发见[文档导航](README.md)。下方无 Git、依赖 DSH、尚无 Hook 或分发等限制只属于 v1 历史版本。

日期：2026-09-16。范围：CLI 收件、后台处理、DSH SDK 调用、真实 Embedding、PostgreSQL/pgvector、检索与恢复。既有 Agent 语义评测继续保持收口，本次没有重新运行 42 次语义评测矩阵。

## 结论

独立本地 jth 可执行完整写入和读取流程。验证使用真实 DSH 模型与真实 Embedding API，最终向量保存在原生 PostgreSQL + pgvector 中；没有用模拟向量或内存数据库替代真实链路。

本机已安装 ~/.local/bin/jth 软链。PostgreSQL 18.6、pgvector 0.8.6 已安装，开发数据库使用 ~/.jth/postgres 和私有 Unix socket ~/.jth/run。首次交付验证时没有 TCP 监听；后续按用户要求增加了图形客户端连接，见下方补充验证。没有配置开机自启，启动、状态和停止命令见项目 README。

## 图形客户端连接补充验证

2026-09-16 18:19（北京时间），已为现有实例增加仅本机可访问的 `127.0.0.1:5432` 监听，保留 `jth` 原有 Unix socket 连接。创建专用只读账号 `jth_viewer`，随机密码保存在本机 `~/.jth/gui-connection.env`，权限 0600，未写入仓库或报告。

使用新账号通过 TCP 实测：密码认证通过，7 张表可见，3 条 1024 维向量可读，向量可以转换为文本展示；错误密码被拒绝，关闭会话的默认只读选项后仍无法 UPDATE，说明表权限本身限制了写入。重启后 `jth memo status` 仍正常返回原完成任务。监听检查确认只有 `127.0.0.1:5432`，未监听外部网卡。

证据文件：`artifacts/jth/gui-connection-check.json`。本次验证了 PostgreSQL TCP 协议连接与权限，没有代替用户在 DataGrip/Navicat 中创建连接配置。

## 自动化检查

| 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| pnpm typecheck | 通过 | 全部生产 TypeScript、既有 Agent 和新增测试 |
| pnpm build | 通过 | 编译后的 jth 入口及 Agent 配置文件 |
| pnpm test | 7 项通过，2 项显式跳过 | 契约、配置隔离、Embedding 返回验证；默认不调用外部模型和数据库 |
| pnpm test:postgres 对应的临时原生库测试 | 10 项通过 | 9 个场景加顶层集成测试；独立初始化并销毁临时 PostgreSQL 集群 |
| jth 文件/stdin/软链调用 | 通过 | 帮助、接收、重复投递、状态、批次详情 |
| 真实模型/API/数据库链路 | 通过 | 见下方可追溯回执 |

数据库场景覆盖：并发重复收件及不同材料冲突；Embedding 失败保留提炼检查点；数据库第二阶段写入失败后整批回滚；范围隔离和建议默认排除；索引提交后恢复任务；失败后显式重试；空候选 noop；锁等待取消及失效连接禁止写入；worker 被锁阻塞时 CLI 仍及时返回。

## 真实回执

- submission_id：jth-cli-example-1
- 接收耗时：104 ms，仅为本机单次测量，不是性能保证。返回时任务为 queued，未等待模型。
- DSH 模型：zz-tokenhub / deepseek-v4-flash
- DSH session：session-13e412a91e8d4570aac32f6df39f461e
- Embedding：qwen3.7-text-embedding-flash，1024 维
- 最终状态：complete，尝试 2 次
- 最终索引回执：3efbc9d7-cc1f-4655-aa99-d82bf92e9747
- 落库：3 条向量，其中 2 条 memories、1 条 proposal
- 默认项目查询：2 条 memories，无 proposal
- 包含建议查询：3 条
- 无关项目查询：0 条
- 单条 read：可读正文及其真实 message_id 对应的来源消息，不含向量
- 重复 send：duplicate=true，沿用原任务和索引回执

完整非敏感测试证据保存在本机 artifacts/jth/live-acceptance.json 和 artifacts/jth/live-result.json。测试材料使用独立的 jth-cli-verification 项目范围。

## 实际发现与处理

本机配置的 Qwen Flash endpoint 在三条输入的请求中返回三条 1024 维向量，但三个 index 都为 0。严格校验拒绝该响应，任务进入 failed；提炼检查点已保留，向量未发布。这个观察只描述本次 endpoint 响应，不推断所有部署都存在相同行为。

随后把客户端改为每次提交一条文本，仍严格校验 model、index、数量、维度和 float32 有限非零值。retry 后成功写入全部向量。前后 DSH session ID 保持一致，证明恢复复用了已保存提炼，没有再次调用 Agent。另有离线回归测试拒绝重复 index 和错误模型、数量、维度等响应。API 契约参考：[阿里云文本向量同步接口](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api/)。

验证中还发现，在 CLI 正执行时同时运行清理 dist 的打包构建会产生短暂模块缺失。最终验证按先构建、后运行 CLI 的顺序串行执行；本地源码安装不提供运行中原子升级。

## 凭据与交付检查

.env.local 已安全改名为 .env，保留原 Embedding 配置，追加本机 PostgreSQL socket 连接。文件权限为 0600。Git 忽略规则包含 .env 和 .env.*，仅放行无凭据模板 .env.example；当前工作区没有 Git 仓库，没有初始化或提交。

打包检查确认不包含 .env/.env.local，也没有实际 Embedding key 的字节内容。任务执行配置只保存公开模型、空间、配置文件位置；没有写入 API key 或数据库连接凭据。真实验证的 JSON 产物同样检查过不含密钥。

## v1 验证时的边界

- 目前交付依赖相邻 deepseek-harness 的已构建 SDK 0.1.6-alpha.1；尚未改为面向任意机器的独立 npm 分发。
- 不包含 HTTP façade、jt-cli 集成、Codex Hook 安装或后台常驻守护进程。
- 修订、冲突保存为证据；不自动覆盖旧事实、跨批去重合并或决定唯一生效版本。
- 模型/维度变化生成新向量空间；本版没有全库重建索引或跨空间查询。
- 当前精确扫描与单 worker 针对个人本地使用；没有高吞吐、长期运行和极端断电的压力测试。
- 先构建再使用 CLI。系统重启后手动启动数据库，再用 jth memo work 恢复队列。
