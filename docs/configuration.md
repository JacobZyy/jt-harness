# 用户配置与自动目录分组

JTH 在本机安装一次用户级 Hook 和 Skill，不需要逐仓库初始化。凭据默认保存在独立普通文件 `~/.jt-harness/.env`；配置目录权限为 `0700`，凭据文件为 `0600`。CLI 只显示配置来源和缺失字段，不打印 API Key 或数据库密码。

| 内容 | 本机位置 |
| --- | --- |
| 数据库、Embedding、可选 legacy 模型配置 | `~/.jt-harness/.env` |
| 显式选择的共享配置路径 | `~/.jt-harness/configuration.json` |
| 目录身份、显示名及旧范围读取别名 | `~/.jt-harness/projects/` |
| Codex 用户 Hook | `$CODEX_HOME/hooks.json`，默认 `~/.codex/hooks.json` |
| Flow 与 Memo Skill | `~/.agents/skills/jth-flow`、`~/.agents/skills/jth-memo` |
| 用户 Workflow Policy | `~/.jt-harness/workflow.json` |
| 目录 Workflow Policy | `~/.jt-harness/workflow/<目录哈希>.json` |
| 运行数据、原数据库与队列 | 沿用 `JTH_DATA_DIR`；缺省 `~/.jth` |

工具安装目录不保存权威凭据。npm 等包管理器管理自己的全局安装；`install --cli` 使用 `~/.local/bin/jth` 和 `~/.local/share/jth/releases/`。升级不移动或清空数据库、待投递声明、索引和 legacy 队列。

## 初始化与更新

准备可连接的 PostgreSQL（已安装 pgvector）以及 Embedding 地址、模型、维度和 API Key。安装 CLI 后运行一次：

```sh
jth init --trust
jth doctor
```

交互初始化只补齐用户配置缺项，不询问项目 ID，不在当前仓库写 Hook、Skill 或 `.jth/flow.json`。随后连接数据库，执行保留数据的表迁移，安装用户级入口并检查接入。`init` 不调用 Embedding 或生成模型。数据库软件、目标数据库与 pgvector 需提前准备。

已有完整配置直接复用。Ctrl+C 取消尚未完成的问答；已经保存的共享配置保留。非交互调用保留 JSON 输出；配置缺项时退出，不安装入口。独立配置可明确选择：

```sh
jth init --env-file /absolute/path/to/private.env --trust
```

明确选择的配置路径保存在本机用户指针中，后续用户 Hook 使用同一配置。`--trust` 仅信任本次 JTH Hook 定义。用户原生记忆、Goal、计划和模型偏好继续由 Codex 配置管理；初始化不写项目覆盖或强制修改全局偏好。更新 CLI 后重新执行一次 `init --trust`，再重新加载已有 Codex 会话；新增仓库无需再次执行。

## 目录与读取范围

目录组依据当前会话实际绑定的工作目录；权限允许访问的额外目录不会自动成为记忆组。没有绑定目录时使用 `default`。多个目录各自保留分组，主目录负责 CLI 执行和未指定归属的默认写入。目录显示名取文件夹名，内部身份依据规范绝对路径，避免同名目录碰撞。

默认搜索读取全部当前绑定目录和用户范围。声明可通过 `items[].workspaces` 选择一个或多个已绑定目录；共同事实保存一次并关联多个目录。旧主仓库保留已登记的项目 ID；复制的工作目录使用独立新写入组，旧 ID 只作读取别名。详细例子见[用户级迁移](user-local-jth.md)。

## 覆盖与来源

配置文件选择顺序为 `--env-file`、`JTH_ENV_FILE`、用户 `configuration.json` 指针、用户默认配置。选择文件后，进程环境变量覆盖文件值；不自动合并当前仓库任意 `.env`。`configuration` 输出显示实际 `envFile`、默认 `userFile` 和来源范围。

`JTH_CONFIG_DIR` 可改变用户配置目录；运行 CLI 和 Hook 时应保持该变量一致。目录分组和 Workflow Policy 不新增数据库或模型配置格式。

流程模式与 Memo 凭据分开读取，缺省 adaptive：

```sh
jth flow config --scope user --mode adaptive
jth flow config --scope project --mode strict
jth flow config --scope project --mode inherit
```

`project` 覆盖存于本机用户配置目录，命令不写仓库。`flow status/context` 显示最终模式与来源；数据库或凭据不可用不影响策略命令。详见 [Workflow Policy](workflow-policy.md)。

## 从旧安装迁移

```sh
jth migrate --dry-run
jth migrate
```

迁移枚举旧安装记录及对应 Git 工作目录；`--workspace <路径>` 可重复传入以补充未登记目录。迁移先保存本机备份、目录映射和旧范围读取别名，再清理可确认属于 JTH 的仓库入口。团队 Hook、其他 Skill、业务配置、历史任务、队列和运行证据保留。已消失的路径仅报告跳过，不重建目录。Git 配置差异留在工作区供审阅。

旧版链接到源码的共享 `.env` 会复制到用户配置目录，相对数据路径转换为原位置的绝对路径；原文件保留，已有用户配置不覆盖。`config-migrations.json` 只记录已确认等价的旧配置路径，待投递声明和 legacy 队列仍可解析旧路径，不改历史快照或重跑任务。配置不同则不建立等价映射；核对后明确选择共享配置。

Hook 只调用 PATH 中的 `jth -- ...`，不携带工作区、配置或安装目录的绝对路径。CLI 入口为 Bun TypeScript `bin/jth.ts`；手动调用使用 `bun --no-env-file -- bin/jth.ts ...`，让 JTH 解析自身参数。可用 `command -v jth` 确认实际入口。

`jth uninstall` 移除用户级入口，保留数据库、凭据、目录映射和队列；带 `--workspace` 时清理指定旧仓库接入。诊断与实际触发的区别见[接入和更新](local-delivery-monitoring.md#用户级接入和更新)。
