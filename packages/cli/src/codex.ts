import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { matchesConfigFile, safeError } from '@jacob-z/jt-harness/memo/config'
import type { Config } from '@jacob-z/jt-harness/memo/config'
import { captureSettingsSchema, captureDeclaration, captureStatus, configureUserHooks, userInstallationPath, readJson, memoryCues } from '@jacob-z/jt-harness/codex-hooks'
import { automaticWorkspaceScope, importLegacyBindings, loadWorkspaceConfig, saveUserConfigBinding, workspaceBinding } from './configuration.ts'
import { startWorker } from './background.ts'
import { openDatabase, MemoStorage } from '@jacob-z/jt-harness/memo'
import { readHookInput } from './index.ts'

export async function codexMain(root: string, args: string[], hookInput?: unknown) {
  let config: Config | undefined
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      'env-file': { type: 'string' }, workspace: { type: 'string' }, 'codex-home': { type: 'string' }, since: { type: 'string' },
      project: { type: 'string', multiple: true }, business: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
    } })
    if (values.help || !positionals.length) {
      process.stdout.write('jth memo codex install [--codex-home <path>]\njth memo codex uninstall [--codex-home <path>]\njth memo codex status\njth memo codex declare < Stop JSON stdin\njth memo codex cue < SessionStart/UserPromptSubmit JSON stdin\n通用：--env-file <path>。安装用户级 Hook 与 Skill；目录范围来自本机会话绑定，无绑定使用 default。线索只读本地 PG，不调用模型或 Embedding。\n')
      return
    }
    const [command] = positionals
    if (positionals.length !== 1 || !['install', 'uninstall', 'status', 'capture', 'declare', 'cue'].includes(command)) throw new Error('未知 Codex 采集命令')
    const allowed: Record<string, string[]> = {
      install: ['workspace', 'codex-home', 'project', 'business'], uninstall: ['codex-home'], status: ['workspace', 'codex-home'],
      capture: ['workspace', 'codex-home', 'since', 'project', 'business'],
      declare: ['workspace', 'codex-home', 'since', 'project', 'business'], cue: ['workspace', 'codex-home', 'since', 'project', 'business'],
    }
    const invalid = Object.keys(values).filter(name => !['env-file', 'help', ...allowed[command]].includes(name))
    if (invalid.length) throw new Error(`${command} 不支持：${invalid.join(', ')}`)
    const hookAction = ['capture', 'declare', 'cue'].includes(command)
    const input = hookAction ? hookInput ?? await readHookInput() : { cwd: resolve(values.workspace ?? process.cwd()), session_id: process.env.CODEX_THREAD_ID }
    const home = resolve(values['codex-home'] ?? process.env.CODEX_HOME ?? resolve(homedir(), '.codex'))
    config = await loadWorkspaceConfig(root, values['env-file'])
    if (command === 'install') {
      await importLegacyBindings(config)
      if (values.project || values.business) await workspaceBinding(resolve(values.workspace ?? process.cwd()), process.env,
        { projectIds: values.project, businessIds: values.business })
      const installed = await configureUserHooks(root, config, home)
      if (values['env-file'] || process.env.JTH_ENV_FILE) await saveUserConfigBinding(config.envFile)
      process.stdout.write(JSON.stringify(installed, null, 2) + '\n')
      return
    }
    if (command === 'uninstall') {
      process.stdout.write(JSON.stringify(await configureUserHooks(root, config, home, false), null, 2) + '\n')
      return
    }
    const context = await automaticWorkspaceScope(input, home)
    const workspace = context.primary ?? context.cwd
    const installed = await readJson(userInstallationPath(config, home)) as { disabled?: boolean, settings?: { enabled_at: string, env_file: string } } | undefined
    if (command === 'status') {
      process.stdout.write(JSON.stringify({ ...await captureStatus(config), cwd: context.cwd, workspace, workspaces: context.workspaces,
        memo_scope: context.scope, user_installation: installed ?? null }, null, 2) + '\n')
      return
    }
    const explicit = values.since !== undefined || values.project !== undefined || values.business !== undefined
    if (!explicit && (installed?.disabled || !installed?.settings)) throw new Error('用户级 Memo Hook 未安装或已卸载；运行 jth init')
    if (!explicit && !matchesConfigFile(config, installed!.settings!.env_file)) throw new Error('用户级 Memo Hook 配置不匹配；运行 jth init')
    const settings = captureSettingsSchema.parse({ workspace, codex_home: home, env_file: config.envFile,
      enabled_at: values.since ?? installed?.settings?.enabled_at, workspaces: explicit && values.project
        ? [{ path: context.cwd, project_ids: values.project, business_ids: values.business ?? [] }] : context.workspaces,
      scope: explicit && values.project ? { project_ids: values.project, business_ids: values.business ?? [] } : context.scope })
    if (command === 'cue') {
      const pool = openDatabase(config, true)
      try { process.stdout.write(JSON.stringify(await memoryCues(input, settings, config, new MemoStorage(pool))) + '\n') }
      finally { await pool.end() }
      return
    }
    const capture = await captureDeclaration(input, settings, config)
    if (capture) await startWorker(root, config)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: safeError(error, config), recovery: 'jth memo work' })}\n`)
    process.exitCode = args.some(arg => ['capture', 'declare', 'cue'].includes(arg)) ? 0 : 1
  }
}
