# 本地安装、升级和 Phoenix 观测

本版提供可搬离源码目录的 Node.js 发行包。运行需要 Node.js 24.21 或以上；普通 Flow/Memo 不依赖旁边的 DSH 源码。开发目录中的显式 legacy 路径保留，发行包不捆绑可选的 DSH SDK。现有记忆、旧队列和凭据不会因安装升级而删除。

## 安装工具本体

npm 安装和更新使用同一个包名：

```sh
npm install --global @jacob-z/jt-harness
jth --version
```

使用其他包管理器时，由该包管理器负责全局包的安装和版本更新。更新工具后，在已接入的项目执行 `jth upgrade --trust` 同步 Hook 和 Skill；裸 `jth upgrade` 不下载 npm 新版本。

开发者也可运行 `pnpm bundle`，得到当前版本的 `artifacts/distribution/jt-harness-<版本>.tar.gz` 及 SHA-256 文件。构建复用 pnpm deploy，包含生产依赖、编译结果和 Skill；排除 `.env`、数据库、运行日志及开发者目录外的链接。

发布 npm 时从 `artifacts/distribution/jt-harness` 目录发布构建产物；仓库根目录包含 `workspace:*` 开发依赖，不可直接发布。根包设为 private，防止误发源码包。

解压后安装：

```sh
tar -xzf jt-harness-0.3.7.tar.gz
node -- jt-harness/bin/jth.mjs install --cli --env-file /absolute/path/to/.env
jth --version
```

通过 `install --cli` 安装时，默认命令链接为 `~/.local/bin/jth`，不可替换的构建目录位于 `~/.local/share/jth/releases/`。确保 `~/.local/bin` 在 PATH 中。可用 `--prefix <目录>` 修改安装位置。npm 等包管理器安装的命令由对应包管理器定位，用 `command -v jth` 确认实际入口。

用户配置保存在 `~/.jt-harness/.env`。首次安装指定 `--env-file` 时导入其内容，不继续依赖原文件；已有用户配置不会被覆盖。旧版指向源码的共享配置会迁移，并保留旧路径兼容。没有配置时准备模板，由 `jth init` 交互补全缺失项。发行包不含密钥，配置和运行数据不随发行目录替换。分层、覆盖和迁移规则见[配置说明](configuration.md)。

## 项目接入和升级

```sh
jth init
jth upgrade --from /absolute/path/to/new-release/jt-harness --trust
jth uninstall
```

`init` 面向人使用：默认项目名来自当前文件夹，已有项目复用原范围；全局连接和 Embedding 配置完整时直接复用，只有缺项才弹出问答。API Key 和数据库连接隐藏输入，保存到用户级 `.env`，项目只记录引用。问卷还会确认是否信任当前 Codex 项目并启用 JTH 自动入口，默认是。

回答完成后，命令自动连接数据库、初始化或升级 Memo 表、安装 Flow 与 Memo Skill 和 Hooks，并执行接入检查。数据库错误可以在同一问卷内修改连接重试。成功输出简短摘要，不需要再执行 `memo init` 或 `doctor`；只有新回合的实际触发仍需重新打开 Codex 任务后验证。

`init` 默认向项目 `.codex/config.toml` 写入：

```toml
[memories]
use_memories = false
generate_memories = false

[tools.update_plan]
enabled = true
```

这两个 [Codex 原生配置项](https://learn.chatgpt.com/docs/customization/memories) 关闭本项目的原生记忆读取和生成，由 JTH 管理跨会话记忆。只修改项目文件，保留其他配置和注释；不修改全局记忆、模型、Goal 或上下文压缩配置。[项目配置需要受信任](https://learn.chatgpt.com/docs/config-file/config-basic)，新会话读取；当前会话可通过 `/memories` 调整。

`update_plan` 在 [Codex CLI 0.152.0](https://learn.chatgpt.com/docs/changelog) 起默认关闭，`init` 显式开启当前项目的原生计划工具。只修改这一配置项，保留其他工具配置；重新加载后需核验宿主确实提供了计划工具，写入配置本身不等于已有任务已拆步。

`jth init --codex-memory inherit` 仅移除两个记忆覆盖项，恢复跟随上层配置，仍开启原生计划工具；它不强制开启全局记忆。已有项目可以省略 `--project` 复用原范围。`install` 同样支持 `--codex-memory off|inherit`，但不传该选项时保留原配置。`install`、`upgrade` 和 `uninstall` 均保留用户已有的计划工具开关；再次执行 `init` 会将其设为开启。

交互 `init` 的问卷会明确确认项目目录和 JTH Hook 信任。AI 或脚本使用非交互 JSON 模式时，仍可显式传入 `--project`、`--env-file`、`--trust`；其中 `--trust` 只信任本次安装的 JTH Hooks，项目配置层需要已受信任。`install`、`upgrade` 的信任语义保持不变。

Codex 将信任绑定到 Hook 定义的哈希；更换 CLI 路径或更新定义后可能出现 `trustStatus: modified`，这些 Hook 会被跳过。按 [OpenAI 官方 Hook 说明](https://learn.chatgpt.com/docs/hooks)重新审阅，或在确认本次 JTH 更新后运行：

```sh
jth upgrade --trust --summary
jth doctor
```

确认 JTH Hook 均为 `enabled: true`、`trustStatus: trusted`，然后重新加载已有 Codex 会话。`flow_entry` 的旧回执不能证明本次更新已经触发；后续输入和回复结束后，应检查 `jth flow status` 的新回执、`jth memo codex status` 及 `jth monitor status`。没有新记忆声明的回复不产生 Memo 入库回执。

包管理器升级可能移除旧安装目录。`upgrade` 可根据同一项目中匹配旧安装路径的 JTH Hook 确认归属，修复失效的 Skill 链接并更新 Hook；缺少归属证据时保留链接并报错。`doctor` 同时检查 `skill_available`，避免把已受信任但安装文件缺失的状态报为正常。

`upgrade --from` 安装指定已解压发行目录，验证可执行后切换命令链接，并同步当前已接入项目；其他项目随后运行 `jth upgrade` 同步。无 `--from` 时只同步当前项目。项目/业务范围和原 `.env` 引用继续使用已有安装配置。

`uninstall` 移除当前项目的 JTH Skill 和 Hooks，保留其他工具配置、凭据、数据库、历史队列及观测数据，不卸载共享 Phoenix 服务。Codex 项目记忆偏好作为用户配置保留；希望恢复跟随全局时，先运行 `jth install --codex-memory inherit`，再卸载。

`doctor` 输出 CLI/Node、配置完整性、数据库队列、原生 Hook 信任状态、入口最近触发和 Phoenix 状态。它不调用模型，不触发 Embedding，也不将“已安装”当成“已执行”。完整记忆一致性检查仍使用 `jth memo doctor`。

## 本机 Phoenix

本次使用官方原生运行方式，不使用 Docker 或 Compose：

```sh
uv tool install --python 3.12 --with asyncpg arize-phoenix==20.14.0
jth monitor start
jth install --trust
jth monitor status
jth monitor open
```

浏览器地址为 `http://127.0.0.1:6006`。服务仅监听本机，复用配置里的 PostgreSQL，在独立 `phoenix` schema 中存储观测数据。JTH 记忆继续使用 `jt_memo`；不新增 SQLite 运行库。

```sh
jth monitor stop    # 停止本项目采集和受管 Phoenix 服务，保留数据
jth monitor start   # 再次启动
jth monitor flush   # 重投本项目保留的待上报事件
```

Phoenix 使用受管后台进程，启动/停止检查进程身份；不注册开机服务。日志位于 `~/.jth/monitor/`。服务和导出程序均不调用模型，未启用 LLM 自动评估；官方遥测及外部界面资源被关闭。

20.14.0 的官方 CLI 会额外把 gRPC 绑定到所有网卡。JTH 使用一个小型 Python 启动适配器调用该 Python 服务已有的 `disabled` 参数，关闭未使用的 gRPC；HTTP/OTLP 与 UI 都只绑定 `127.0.0.1:6006`。不修改 Phoenix 安装文件或前端。

## 采集范围与含义

仅接入并启用了 monitor 的项目安装三个轻量 Hook：`UserPromptSubmit`、`Stop`、`Interrupt`。Hook 保存来源位置和计数基线，再唤醒后台导出程序；故障不阻塞会话。原有 Memo Stop 独立保留。

后台读取该会话新增的原生日志，提取时间、会话/回合 ID、可获得的模型、输入/缓存/输出 Token，以及工具名称、时长和失败状态。可以读取原生 Goal 状态时附带该状态。未采集到用量明确标为不可用，不伪报为零。

输入 Token 已包含缓存命中部分，缓存单独记录，不重复相加。回合停止或工具返回不等于目标验收通过。当前提供运行事实；不自动判断目标偏移、Skill 执行质量或记忆是否被正确采用。

模型用量使用标准 LLM 子 Span，界面可汇总 Token；计量事件的时间点不冒充模型请求耗时。Phoenix 的费用列是估算，不是服务商账单或 Codex 订阅额度。

原始用户提示、助手正文、思考文本、工具参数和输出不发送给 Phoenix。项目内 `.jth/monitor/` 保存短回执、游标和待投递事件；Phoenix 离线时保留事件，后续 Hook 或 `monitor flush` 可继续。事件使用稳定 trace/span ID，重复投递不会凭空产生新的执行身份。

新安装的 Hook 需要当前 Codex 会话重新加载。`doctor` 的“尚无触发记录”是待验证状态，不会伪装成成功。

## 中文化

核对 Phoenix 20.14.0 界面及官方前端源码后，未找到可直接启用的完整中文 UI 或官方中文插件；`locale.ts` 只定义文字方向。保留英文界面，JTH CLI 提示、诊断和 `Flow 入口`、`Codex 回合` 等 trace 名称使用中文，不维护一份 Phoenix 前端分叉。

## 验证

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:postgres
node scripts/verify-monitor.ts
```

最后一条需要本机 Codex 和运行中的 Phoenix。它在独立 CODEX_HOME 中使用本地 Responses 模拟服务，验证真实 Codex Hook、后台导出和 PostgreSQL 持久化；不调用付费模型。测试 Token 是明确的协议样例，不代表用户真实账单。原始验证报告位于忽略目录 `artifacts/delivery/`。

参考：[Phoenix 原生运行](https://arize.com/docs/phoenix/self-hosting/deployment-options/terminal)、[PostgreSQL/schema 配置](https://arize.com/docs/phoenix/self-hosting/configuration)、[官方前端源码](https://github.com/Arize-ai/phoenix/tree/arize-phoenix-v20.14.0/js/app)。
