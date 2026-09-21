# 用户配置与仓库接入

共享连接和凭据默认保存在 `~/.jt-harness/.env`。该文件是独立普通文件，不链接到源码仓库。配置目录权限为 `0700`，凭据文件为 `0600`；CLI 输出只显示来源路径、范围及缺失字段，不打印 API Key 或数据库密码。

| 范围 | 内容与位置 |
| --- | --- |
| 用户级 | `~/.jt-harness/.env`：数据库连接、Embedding 服务地址、模型、维度、API Key，以及可选的运行数据路径和 legacy 模型设置 |
| 仓库级 | 项目和业务范围属于当前仓库的 Memo 安装记录；`.jth/flow.json` 定位配置，`.jth/monitor.json` 控制项目采集；`.codex/` 和 `AGENTS.md` 保存宿主接入及项目约定 |
| 程序 | `~/.local/bin/jth` 和 `~/.local/share/jth/releases/` 保存命令链接与不可替换发行目录，不存放权威凭据 |
| 运行数据 | 继续使用当前 `JTH_DATA_DIR`、PostgreSQL 和队列位置；未指定数据目录时沿用 `~/.jth`，升级不迁移或清空数据 |

项目范围继续由现有 Memo 安装记录维护，Flow 不复制第二份范围或任务状态。仓库的 Hook、Skill 路径本来就应指向该仓库；共享 `env_file` 默认指向用户配置。

## 初始化

```sh
jth init --project my-project --trust
```

先在 Codex 中打开并信任项目。`init` 检测用户配置，完整配置直接复用；首次配置或缺项时，在交互终端询问服务地址、模型、向量维度、数据库连接和 API Key。凭据输入隐藏，Ctrl+C 取消时不保存本次输入。第二个仓库复用同一用户配置，不重复询问凭据。

非交互模式缺项时退出并列出缺失字段，不写入仓库的安装文件。可先在终端完成初始化，或明确提供已有配置：

```sh
jth init --project my-project --env-file /absolute/path/to/private.env --trust
```

`init` 补齐配置，不为验收发送 Embedding 请求。服务连接情况通过 `jth doctor` 检查。`install --cli` 只安装程序和准备用户配置，不询问 API Key；`upgrade` 保留既有选择，不弹出配置向导。

## 覆盖与来源

Memo、数据库、监控和项目接入命令的配置文件选择顺序为 `--env-file`、`JTH_ENV_FILE`、当前仓库及其父目录中已有的 Flow 配置引用、用户配置。选择文件后，进程环境变量覆盖文件值；不会自动合并当前仓库任意 `.env`。`flow status/context` 按仓库绑定读取安装状态，避免临时覆盖改变所报告的项目范围。

项目初始化时显式选择的 `--env-file` 继续作为该项目的覆盖配置，升级不将它擅自改为用户默认。`init`、`upgrade`、`flow status` 和 `doctor` 的 `configuration` 会显示 `scope`、实际 `envFile` 和默认 `userFile`；`scope=user` 表示用户默认，`scope=override` 表示显式覆盖。

需要隔离或便携安装时可设置 `JTH_CONFIG_DIR` 改变用户配置目录；运行 CLI 和 Hook 的环境应保持这个变量一致。通常无需设置。数据库、Embedding 和模型选择不额外引入第二套配置格式。

## 从旧安装迁移

旧版 `share/jth/.env` 可能链接到源码仓库。安装新 CLI 或升级使用该旧默认配置的仓库时，程序将其内容复制到用户配置目录，并把相对数据路径转换为原位置的绝对路径。原文件保留，已有用户配置不会被覆盖。

`config-migrations.json` 只记录已确认等价的旧配置路径。旧 Hook、待投递声明、暂存记录、索引和显式 legacy 队列仍可解析旧路径，即使旧配置文件随后移走。不会改写历史来源、项目范围、任务执行快照，也不会因此重跑 legacy 队列。

迁移后的旧路径作为用户配置的别名，不再作为独立配置编辑；后续修改用户目录中的 `.env`。需要独立覆盖配置时，使用新的文件路径并显式传入 `--env-file`。

直接通过 Node 调用入口时，使用 `node -- bin/jth.mjs ...`。`--` 保证 `--env-file` 由 JTH 解析，避免 Node 提前读取已经迁移的旧文件。安装的命令、Hook 和后台启动入口已包含这个分隔符。

若现有用户配置与旧配置不同，不建立等价映射，也不覆盖其中任何一份；已有项目继续保留自己的配置引用。明确核对后再选择需要的配置。

安装或升级后重新加载 Codex 任务，使新的 Hook 定义和项目指令生效。
