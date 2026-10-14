import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { configureUserHooks, flowEntryHook, flowEntryMarker, flowEntryReceiptPath, userInstallationPath, readJson, type CaptureSettings } from '@jacob-z/jt-harness/codex-hooks'
import { safeError } from '@jacob-z/jt-harness/memo/config'
import { automaticWorkspaceScope, configurationScope, importLegacyBindings, loadWorkspaceConfig, saveUserConfigBinding, workspaceBinding } from './configuration.ts'
import { resolveWorkflowPolicy } from './workflow-settings.ts'
import { readHookInput } from './index.ts'

const help = `jth flow install [--env-file <path>]  安装用户级 Flow/Memo Hook 与 Skill
jth flow policy <file.json|->     评估显式意图，准备原生 Goal 与计划参数；不保存任务
jth flow config                  查看或覆盖 adaptive/strict；运行 jth flow config --help
jth flow status                  查看用户入口安装、目录分组和 Memo 范围
jth flow context                 查看原生执行职责，不读取旧任务或缓存记忆
jth flow prompt                  Hook 入口，读取 UserPromptSubmit JSON stdin，输出短流程提示
jth flow uninstall               移除用户级 JTH Hook/Skill；历史数据保留
jth flow legacy <command>        显式访问旧任务，例如 status --all、context、migrate
通用：--workspace <目录>、--codex-home <目录>
目标、任务列表、续跑与恢复由 Codex 原生能力管理；项目测试直接使用原有命令。
`

export async function installFlow(root: string, workspace: string, config: { dataDir: string, envFile: string, envAliases?: readonly string[] }, scope?: CaptureSettings['scope'], home = resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'))) {
  await importLegacyBindings(config)
  if (scope && (scope.project_ids.length || scope.business_ids.length)) await workspaceBinding(workspace, process.env,
    { projectIds: scope.project_ids, businessIds: scope.business_ids })
  const installed = await configureUserHooks(root, config, home)
  return { ...installed, mode: 'native', memo: installed, workflow_policy: await resolveWorkflowPolicy(workspace), task_owner: 'Codex' }
}

export async function flowMain(root: string, args: string[], hookInput?: unknown) {
  if (args[0] === 'policy' || args[0] === 'config') return (await import('./flow-policy.ts')).flowPolicyMain(args)
  if (args[0] === 'legacy') return (await import('./flow-legacy.ts')).flowLegacyMain(root, args.slice(1))
  if (args[0] === 'hook') {
    for await (const _ of process.stdin) { /* Retired lifecycle input. */ }
    process.stdout.write('{}\n'); return
  }
  if (args[0] === 'sync' || (args[0] === 'recall' && args.includes('--request'))) {
    process.stdout.write(JSON.stringify({ mode: 'native', skipped: 'legacy-background-work', history_preserved: true }) + '\n'); return
  }
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      workspace: { type: 'string' }, 'codex-home': { type: 'string' }, 'env-file': { type: 'string' }, project: { type: 'string', multiple: true },
      business: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
    } })
    const [command] = positionals
    if (values.help || !command) { process.stdout.write(help); return }
    if (!['install', 'uninstall', 'status', 'context', 'prompt'].includes(command)) throw new Error('默认 Flow 已改用 Codex 原生目标和任务列表；旧任务用 jth flow legacy，记忆查询用 jth memo search')
    if (positionals.length !== 1) throw new Error('命令参数数量不符；运行 jth flow --help')
    if (command !== 'install' && (values.project || values.business)) throw new Error('项目别名只在 install 时指定')
    const input = command === 'prompt' ? hookInput ?? await readHookInput() : { cwd: resolve(values.workspace ?? process.cwd()), session_id: process.env.CODEX_THREAD_ID }
    const home = resolve(values['codex-home'] ?? process.env.CODEX_HOME ?? resolve(homedir(), '.codex'))
    const config = await loadWorkspaceConfig(root, values['env-file'])
    const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
    if (command === 'install') {
      const installed = await installFlow(root, resolve(values.workspace ?? process.cwd()), config,
        { project_ids: values.project ?? [], business_ids: values.business ?? [] }, home)
      if (values['env-file'] || process.env.JTH_ENV_FILE) await saveUserConfigBinding(config.envFile)
      output(installed); return
    }
    if (command === 'uninstall') { output(await configureUserHooks(root, config, home, false)); return }
    const context = await automaticWorkspaceScope(input, home)
    const workspace = context.primary ?? context.cwd
    if (command === 'prompt') { output(await flowEntryHook(input, workspace, { dataDir: config.dataDir, userHome: homedir() })); return }
    const installation = await readJson(userInstallationPath(config, home)) as { disabled?: boolean, settings?: unknown } | undefined
    const skillPath = resolve(homedir(), '.agents/skills/jth-flow')
    const skillInstalled = await stat(resolve(skillPath, 'SKILL.md')).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error })
    const hooksPath = resolve(home, 'hooks.json')
    const hooks = await readJson(hooksPath) as { hooks?: Record<string, { hooks: { statusMessage?: string, command?: string }[] }[]> } | undefined
    const handlers = Object.values(hooks?.hooks ?? {}).flatMap(groups => groups.flatMap(group => group.hooks))
    output({ mode: 'native', cwd: context.cwd, workspace, workspaces: context.workspaces, workspace_source: context.source,
      workflow_policy: await resolveWorkflowPolicy(workspace), configuration: await configurationScope(config), skill: { path: skillPath, installed: skillInstalled },
      memo_scope: context.scope, memo_enabled: Boolean(!installation?.disabled && installation?.settings), user_installation: installation ?? null,
      entry_hook: { installed: handlers.some(handler => handler.statusMessage === flowEntryMarker), source: 'user', hooks_path: hooksPath,
        event: 'UserPromptSubmit', receipt_path: flowEntryReceiptPath(workspace, config), last_emission: await readJson(flowEntryReceiptPath(workspace, config)) ?? null },
      native: { goal: 'planned 入口要求主 Agent 调用 get_goal/create_goal；状态以宿主回执为准，此 CLI 不读取或启动 Goal',
        task_list: '由宿主实际暴露的原生计划工具管理；此 CLI 不读写或冒充原生列表', resume: '使用 Codex 会话恢复', verification: '直接运行项目测试并保留实际结果' }, history: 'jth flow legacy status --all' })
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: safeError(error) }) + '\n')
    if (args[0] === 'prompt') { process.stdout.write('{}\n'); return }
    process.exitCode = 1
  }
}
