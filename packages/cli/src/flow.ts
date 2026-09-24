import { realpath, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { findFlowWorkspace, flowPath, locatorSchema } from '@jacob-z/jt-harness/flow'
import { captureSettingsSchema, configureFlowHooks, configureHooks, flowEntryHook, flowEntryMarker, flowEntryReceiptPath, installationPath, readJson, writeJson, type CaptureSettings } from '@jacob-z/jt-harness/codex-hooks'
import { loadConfig, safeError } from '@jacob-z/jt-harness/memo/config'
import { configurationScope, loadWorkspaceConfig } from './configuration.ts'
import { resolveWorkflowPolicy } from './workflow-settings.ts'

const help = `jth flow install --project <id> [--business <id>] [--env-file <path>]
jth flow policy <file.json|->     评估显式意图，准备原生 Goal 与计划参数；不保存任务
jth flow config                  查看或覆盖 adaptive/strict；运行 jth flow config --help
jth flow status                  查看入口安装、最近输出记录与 Memo 范围，不连接任务数据库
jth flow context                 查看原生执行职责，不读取旧任务或缓存记忆
jth flow prompt                  Hook 入口，读取 UserPromptSubmit JSON stdin，输出短流程提示
jth flow uninstall               移除项目 Flow Skill 和入口 Hook；Memo 安装和历史数据保留
jth flow legacy <command>        显式访问旧任务，例如 status --all、context、migrate
通用：--workspace <项目目录>
目标、任务列表、续跑与恢复由 Codex 原生能力管理；项目测试直接使用原有命令。
`

export async function installFlow(root: string, workspace: string, config: { dataDir: string, envFile: string, envAliases?: readonly string[] }, scope: CaptureSettings['scope']) {
  const workflowPolicy = await resolveWorkflowPolicy(workspace)
  const memo = await configureHooks(root, config, workspace, scope, resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex')))
  await writeJson(flowPath(workspace), { version: 2, workspace, envFile: config.envFile })
  return { ...await configureFlowHooks(root, workspace), memo, workflow_policy: workflowPolicy, task_owner: 'Codex', locator: flowPath(workspace) }
}

/** Native mode configures guidance and memory only. It owns no task state or execution loop. */
export async function flowMain(root: string, args: string[]) {
  if (args[0] === 'policy' || args[0] === 'config') return (await import('./flow-policy.ts')).flowPolicyMain(args)
  if (args[0] === 'legacy') return (await import('./flow-legacy.ts')).flowLegacyMain(root, args.slice(1))
  // Old hosts and already-started workers may retain these commands until a session reload.
  // Consume their input without opening PG, replaying old events, or refreshing old-task memory.
  if (args[0] === 'hook') {
    for await (const _ of process.stdin) { /* Retired lifecycle input. */ }
    process.stdout.write('{}\n')
    return
  }
  if (args[0] === 'sync' || (args[0] === 'recall' && args.includes('--request'))) {
    process.stdout.write(JSON.stringify({ mode: 'native', skipped: 'legacy-background-work', history_preserved: true }) + '\n')
    return
  }
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      workspace: { type: 'string' }, 'env-file': { type: 'string' }, project: { type: 'string', multiple: true },
      business: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
    } })
    const [command] = positionals
    if (values.help || !command) { process.stdout.write(help); return }
    if (!['install', 'uninstall', 'status', 'context', 'prompt'].includes(command)) throw new Error('默认 Flow 已改用 Codex 原生目标和任务列表；旧任务用 jth flow legacy，记忆查询用 jth memo search')
    if (positionals.length !== 1) throw new Error('命令参数数量不符；运行 jth flow --help')
    if (command !== 'install' && (values.project || values.business || values['env-file'])) throw new Error('项目范围和配置文件只在 install 时指定')
    const workspace = command === 'install' ? await realpath(resolve(values.workspace ?? process.cwd())) : findFlowWorkspace(values.workspace ?? process.cwd())
    const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
    if (command === 'prompt') {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of process.stdin) {
        bytes += chunk.length
        if (bytes > 512_000) throw new Error('Hook 输入超过 512000 字节')
        chunks.push(Buffer.from(chunk))
      }
      let input: unknown
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new Error('Hook 输入不是有效 JSON') }
      output(await flowEntryHook(input, workspace))
      return
    }
    if (command === 'install') {
      const config = await loadWorkspaceConfig(root, values['env-file'], workspace)
      output(await installFlow(root, workspace, config, { project_ids: values.project ?? [], business_ids: values.business ?? [] }))
      return
    }
    if (command === 'uninstall') { output(await configureFlowHooks(root, workspace, false)); return }
    const locator = locatorSchema.parse(await readJson(flowPath(workspace)))
    if (locator.workspace !== workspace) throw new Error('流程连接配置的工作区不一致')
    const config = await loadConfig(root, locator.envFile)
    const installation = await readJson(installationPath(config, workspace)) as { settings?: unknown, disabled?: boolean } | undefined
    const memoScope = installation?.settings ? captureSettingsSchema.parse(installation.settings).scope : null
    const skillPath = resolve(workspace, '.agents/skills/jth-flow')
    const skillTarget = await readlink(skillPath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    const hooks = await readJson(resolve(workspace, '.codex/hooks.json')) as { hooks?: Record<string, { hooks: { statusMessage?: string }[] }[]> } | undefined
    const handlers = Object.values(hooks?.hooks ?? {}).flatMap(groups => groups.flatMap(group => group.hooks))
    const legacyHooks = handlers.filter(handler => handler.statusMessage === 'jth flow context').length
    output({ mode: 'native', workspace, workflow_policy: await resolveWorkflowPolicy(workspace), configuration: await configurationScope(config), skill: { path: skillPath, installed: skillTarget !== null }, memo_scope: memoScope,
      memo_enabled: Boolean(installation && !installation.disabled), legacy_flow_hooks: legacyHooks,
      entry_hook: { installed: handlers.some(handler => handler.statusMessage === flowEntryMarker), event: 'UserPromptSubmit',
        receipt_path: flowEntryReceiptPath(workspace), last_emission: await readJson(flowEntryReceiptPath(workspace)) ?? null },
      ...(legacyHooks ? { action: '重新运行 flow install，移除旧任务注入 Hook' } : {}),
      native: { goal: 'planned 入口要求主 Agent 调用 get_goal/create_goal；状态以宿主回执为准，此 CLI 不读取或启动 Goal', task_list: '由宿主实际暴露的原生计划工具管理；此 CLI 不读写或冒充原生列表',
        resume: '使用 Codex 会话恢复', verification: '直接运行项目测试并保留实际结果' },
      history: 'jth flow legacy status --all',
    })
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: safeError(error) }) + '\n')
    // Entry failure must not block the user's prompt; diagnostics stay on stderr.
    if (args[0] === 'prompt') { process.stdout.write('{}\n'); return }
    process.exitCode = 1
  }
}
