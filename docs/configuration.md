# 用户配置与仓库接入

共享连接和凭据默认保存在 `~/.jt-harness/.env`。该文件是独立普通文件，不链接到源码仓库。配置目录权限为 `0700`，凭据文件为 `0600`；CLI 输出只显示来源路径、范围及缺失字段，不打印 API Key 或数据库密码。

| 范围 | 内容与位置 |
| --- | --- |
| 用户级 | `~/.jt-harness/.env`：数据库连接、Embedding 服务地址、模型、维度、API Key，以及可选的运行数据路径和 legacy 模型设置 |
| 仓库级 | 项目和业务范围属于当前仓库的 Memo 安装记录；`.jth/flow.json` 定位配置，`.jth/monitor.json` 控制项目采集；`.codex/` 和 `AGENTS.md` 保存宿主接入及项目约定 |
| 程序 | npm 等包管理器管理自己的全局安装；`install --cli` 使用 `~/.local/bin/jth` 和 `~/.local/share/jth/releases/`。程序目录不存放权威凭据 |
| 运行数据 | 继续使用当前 `JTH_DATA_DIR`、PostgreSQL 和队列位置；未指定数据目录时沿用 `~/.jth`，升级不迁移或清空数据 |

项目范围继续由现有 Memo 安装记录维护，Flow 不复制第二份范围或任务状态。仓库的 Hook、Skill 路径本来就应指向该仓库；共享 `env_file` 默认指向用户配置。

## Workflow Policy 配置

流程模式与 Memo 凭据分开读取：用户默认在 `~/.jt-harness/workflow.json`，仓库覆盖在 `.jth/workflow.json`。缺省为 adaptive；用 `jth flow config --scope user|project --mode adaptive|strict|inherit` 设置。`flow status/context` 显示最终模式与来源；数据库或凭据不可用不影响策略命令。详见 [Workflow Policy](workflow-policy.md)。

## 初始化

先准备可连接的 PostgreSQL（已安装 pgvector）和 Embedding 服务的地址、模型、向量维度及 API Key。工具本体安装后，在项目目录只需运行：

```sh
jth init
```

问卷分两层：

- **项目级**：首次默认使用当前文件夹名作为项目标识，回车接受，也可以修改；已有安装始终复用原范围。随后确认是否信任当前 Codex 项目并启用 JTH 自动流程与记忆，默认是。
- **全局级**：默认使用 `~/.jt-harness/.env`。完整配置直接复用，不重复询问；首次配置或缺项时，交互填写服务地址、模型、向量维度、数据库连接和 API Key。凭据隐藏输入，文件权限为 `0600`；项目只保存配置引用，不复制凭据。

问答完成后，`init` 自动连接数据库、初始化或升级 Memo 表、安装项目指引和 Hooks、按回答处理信任，再执行接入检查并输出人类可读摘要。不需要另跑 `memo init` 或 `doctor`。数据库连接失败时，可在同一问卷中重新输入连接并重试；数据库软件、目标数据库与 pgvector 仍需提前准备。

Ctrl+C 取消当前问答，尚未完成的输入不保存；此前已经完成保存的共享配置保留。初始化完成后重新打开 Codex 任务，新输入和回复才会产生运行回执。第二个项目仍只运行 `jth init`，复用同一全局配置。

AI 或脚本运行时保留非交互 JSON 输出，项目名同样可以省略；配置缺项时直接退出，不写入项目安装文件。需要明确覆盖默认值时仍可传参数：

```sh
jth init --project my-project --env-file /absolute/path/to/private.env --trust
```

非交互的 `--trust` 仅信任 JTH Hooks，Codex 项目配置层需要已受信任；交互问卷中的确认则明确包含当前项目的信任。`--env-file` 保留显式指定的独立配置，不覆盖全局文件。`init` 不发送 Embedding 或生成模型测试请求；`doctor` 仍可作为后续只读诊断命令。`install --cli` 只安装程序，`upgrade` 同步已有接入，两者不弹出完整初始化问卷。

## 覆盖与来源

Memo、数据库、监控和项目接入命令的配置文件选择顺序为 `--env-file`、`JTH_ENV_FILE`、当前仓库及其父目录中已有的 Flow 配置引用、用户配置。选择文件后，进程环境变量覆盖文件值；不会自动合并当前仓库任意 `.env`。`flow status/context` 按仓库绑定读取安装状态，避免临时覆盖改变所报告的项目范围。

项目初始化时显式选择的 `--env-file` 继续作为该项目的覆盖配置，升级不将它擅自改为用户默认。`init`、`upgrade`、`flow status` 和 `doctor` 的 `configuration` 会显示 `scope`、实际 `envFile` 和默认 `userFile`；`scope=user` 表示用户默认，`scope=override` 表示显式覆盖。

需要隔离或便携安装时可设置 `JTH_CONFIG_DIR` 改变用户配置目录；运行 CLI 和 Hook 的环境应保持这个变量一致。通常无需设置。数据库、Embedding 和模型选择不额外引入第二套配置格式。

## 从旧安装迁移

旧版 `share/jth/.env` 可能链接到源码仓库。安装新 CLI 或升级使用该旧默认配置的仓库时，程序将其内容复制到用户配置目录，并把相对数据路径转换为原位置的绝对路径。原文件保留，已有用户配置不会被覆盖。

`config-migrations.json` 只记录已确认等价的旧配置路径。旧 Hook、待投递声明、暂存记录、索引和显式 legacy 队列仍可解析旧路径，即使旧配置文件随后移走。不会改写历史来源、项目范围、任务执行快照，也不会因此重跑 legacy 队列。

迁移后的旧路径作为用户配置的别名，不再作为独立配置编辑；后续修改用户目录中的 `.env`。需要独立覆盖配置时，使用新的文件路径并显式传入 `--env-file`。

直接通过 Bun 调用入口时，使用 `bun -- bin/jth.mjs ...`。`--` 保证 `--env-file` 由 JTH 解析，避免 Bun 提前读取配置文件。安装的命令、Hook 和后台启动入口已包含这个分隔符。

若现有用户配置与旧配置不同，不建立等价映射，也不覆盖其中任何一份；已有项目继续保留自己的配置引用。明确核对后再选择需要的配置。

安装或升级后，用 `jth doctor` 检查 Hook 信任；定义变化时运行 `jth upgrade --trust` 或在 `/hooks` 重新审阅，再重新加载 Codex 任务。诊断与实际触发的区别见[接入和升级](local-delivery-monitoring.md#项目接入和升级)。
