# 存储 v3：五项增强交付验证

日期：2026-09-16。范围：原子事实与实体元数据、时间语义、只读体检、候选审核、归档与容量治理。

## 已完成

1. 原子提炼要求每条记忆可独立更正，保留条件和多条来源；实体必须逐字来自引用消息。新运行使用带元数据的严格 Agent 输出契约，旧检查点仍可读取。
2. 保存来源事件时间和明确有效期，区分接收、提炼记录与发布时间。历史读取考虑记录、发布、审核、归档和更正当时的状态。迟到、晚完成的重试、顺序不明或未来生效的自动更正转为待审，不默默覆盖当前事实。
3. doctor 使用只读一致性快照，检查源契约、正文/向量哈希、条目和向量数量、空间维度、完成回执、关系证据/范围及循环。
4. claim_status 区分 candidate/asserted/observed/verified/rejected，独立于生命周期 state。审核决定记录 actor、reason、evidence_ref 和时间，原正文与 basis 不变；DSH 输出不能直接设置审核资格。
5. archive/restore 追加可恢复动作，按会话仅归档 current_task；stats 提供状态分布与各表容量。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| pnpm typecheck | 通过 |
| pnpm build | 通过 |
| pnpm test | 9 项通过，3 项显式跳过外部依赖测试 |
| 原生 PostgreSQL + pgvector 集成测试 | 15 项通过（含顶层测试） |
| 真实 DSH + Qwen Embedding + CLI | 两批材料处理完成；审核、归档、恢复、历史读取和体检通过 |
| 本机 v2 升 v3 | 原有 8 条向量逐条哈希不变 |
| GUI 只读账号 | 可查看新增字段与动作表，写操作仍被拒绝 |

新增数据库场景覆盖了：晚到材料不覆盖，早接收任务晚重试不覆盖，未来/过期时间窗口，历史快照不泄露尚未生成的提炼，审核缺依据拒绝，审核不改原始角色依据，拒绝后默认隐藏，按会话归档不碰长期规则，恢复与历史归档状态，以及注入损坏后 doctor 能识别且不会修复或改写数据。

## 真实材料验证

项目：jth-storage-v3-1789564445958。原始材料只包含隔离测试项目和 example.invalid 域名。

| 类别 | 范围 | 刚入库时生命周期 | 刚入库时审核状态 | 正文 |
| --- | --- | --- | --- | --- |
| memories | project | active | asserted | 项目 StorageDemo 的 API 地址为 https://storage.example.invalid。 |
| memories | project | active | asserted | 项目 StorageDemo 的请求超时为 30 秒。 |
| memories | current_task | active | asserted | 本次 StorageDemo 调试任务的临时约束：只读取 test-fixtures 目录；该约束仅对本次任务有效。 |
| memories | project | scheduled | asserted | StorageDemo 的 season-feature 仅在 2100-01-01T00:00:00Z 至 2100-02-01T00:00:00Z 期间启用。 |
| proposals | project | active | candidate | 建议项目 StorageDemo 启用 local-cache（该建议尚未被用户确认）。 |

地址和 30 秒超时被拆成两条记忆。season-feature 记录明确时间与引文，当前为 scheduled；指定 2100 年 1 月读取为 active，3 月为 expired。

local-cache 建议首先为 candidate，CLI 确认后为 verified，拒绝后为 rejected，原 basis 始终保留。临时任务经过会话归档、恢复、再次归档，长期项目条目没有被连带归档。第二批通过 send --review 投递，即使原文是用户陈述，也保持在候选区。

证据：artifacts/jth/storage-v3-live-result.json，材料目录 artifacts/jth/jth-storage-v3-1789564445958/。

## 本机数据与体检

升级前备份：artifacts/jth/pre-storage-v3.dump，权限 0600。迁移结果：artifacts/jth/storage-v3-migration-check.json。

最终 doctor：0 个错误，1 类警告。警告是原有 8 条记忆缺少完整来源时间；它们保持未知，没有补造为今天。当前共有 14 条条目、14 条向量、5 条管理动作，失败任务 0 个。

## 具体边界

- 原子性是模型提炼规则，实体/时间引用由程序校验；没有宣称能形式化证明任意自然语言都只含一个事实。
- verified 表示用户确认或本机审核认可，不是机器对客观真假的保证。依据引用由操作者提供，未自动联网核实。
- 审核确认不会隐式执行曾被拦截的版本替代计划；相反说法保留冲突，需明确更正裁决。未来更正不会安装定时任务自动作废当前事实。
- --as-of 使用当时已经保存和发布的信息，不用后来发现的知识改写过去快照。
- 归档仅改变默认可见性，不删除证据，不释放物理空间；冷存储、物理清理和自动保留策略不在本次实现中。
- Codex Hook 接入、关键词混合召回、跨模型重建索引继续属于后续工作。

详细操作见 [README](../README.md)，来源研究见 [Rex 参考](rex-memory-reference.md)。
