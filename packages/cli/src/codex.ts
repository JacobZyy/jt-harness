import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { matchesConfigFile, safeError } from '@jacob-z/jt-harness/memo/config'
import { findInstalledWorkspace, loadWorkspaceConfig } from './configuration.ts'
import type { Config } from '@jacob-z/jt-harness/memo/config'
import { captureSettingsSchema, captureDeclaration, captureStatus, configureHooks, installationPath, readJson } from '@jacob-z/jt-harness/codex-hooks'
import { startWorker } from './background.ts'
import { openDatabase, MemoStorage } from '@jacob-z/jt-harness/memo'
import { memoryCues } from '@jacob-z/jt-harness/codex-hooks'

export async function codexMain(root: string, args: string[]) {
  let config: Config | undefined
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      'env-file': { type: 'string' }, workspace: { type: 'string' }, 'codex-home': { type: 'string' }, since: { type: 'string' },
      project: { type: 'string', multiple: true }, business: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
    } })
    if (values.help || !positionals.length) {
      process.stdout.write('jth memo codex install --project <id> [--business <id>] [--workspace <path>]\njth memo codex uninstall [--workspace <path>]\njth memo codex status\njth memo codex declare < Stop JSON stdin\njth memo codex cue < SessionStart/UserPromptSubmit JSON stdin\n通用：--env-file <path>、--codex-home <path>。install 安装 Stop 声明与启动/恢复线索；线索只读本地 PG，不调用模型或 Embedding。\n')
      return
    }
    if (positionals.length !== 1 || !['install', 'uninstall', 'status', 'capture', 'declare', 'cue'].includes(positionals[0])) throw new Error('未知 Codex 采集命令')
    const allowed: Record<string, string[]> = {
      install: ['workspace', 'codex-home', 'project', 'business'], uninstall: ['workspace'], status: [],
      capture: ['workspace', 'codex-home', 'since', 'project', 'business'],
      declare: ['workspace', 'codex-home', 'since', 'project', 'business'],
      cue: ['workspace', 'codex-home', 'since', 'project', 'business'],
    }
    const invalid = Object.keys(values).filter(name => !['env-file', 'help', ...allowed[positionals[0]]].includes(name))
    if (invalid.length) throw new Error(`${positionals[0]} 不支持：${invalid.join(', ')}`)
    const hookAction = ['capture', 'declare', 'cue'].includes(positionals[0])
    const workspace = values.workspace ? await realpath(resolve(values.workspace))
      : hookAction ? findInstalledWorkspace(process.cwd()) : await realpath(process.cwd())
    config = await loadWorkspaceConfig(root, values['env-file'], workspace)
    const home = resolve(values['codex-home'] ?? process.env.CODEX_HOME ?? resolve(homedir(), '.codex'))
    const scope = { project_ids: values.project ?? [], business_ids: values.business ?? [] }
    if (hookAction) {
      const explicit = values.since !== undefined || values.project !== undefined || values.business !== undefined || values['codex-home'] !== undefined
      const installed = explicit ? undefined : await readJson(installationPath(config, workspace)) as { disabled?: boolean, settings?: unknown } | undefined
      if (!explicit && (installed?.disabled || !installed?.settings)) throw new Error('Memo Hook 未安装或已卸载；运行 jth init')
      const settings = captureSettingsSchema.parse(explicit
        ? { workspace, codex_home: home, env_file: config.envFile, enabled_at: values.since, scope }
        : installed!.settings)
      if (settings.workspace !== workspace || !matchesConfigFile(config, settings.env_file)) throw new Error('Memo Hook 安装范围或配置不匹配；运行 jth init')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of process.stdin) {
        bytes += chunk.length
        if (bytes > 512_000) throw new Error('Hook 输入超过 512000 字节')
        chunks.push(Buffer.from(chunk))
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (positionals[0] === 'cue') {
        // Fast, read-only connection; never start PG, migrate, or call Embedding from a cue hook.
        const pool = openDatabase(config, true)
        try { process.stdout.write(JSON.stringify(await memoryCues(input, settings, config, new MemoStorage(pool))) + '\n') }
        finally { await pool.end() }
        return
      }
      const capture = await captureDeclaration(input, settings, config)
      if (capture) await startWorker(root, config)
      // Hook stdout belongs to Codex's control protocol, not the memo CLI receipt.
      return
    }
    const result = positionals[0] === 'status' ? await captureStatus(config)
      : await configureHooks(root, config, workspace, positionals[0] === 'install' ? scope : undefined, home)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: safeError(error, config), recovery: 'jth memo work' })}\n`)
    process.exitCode = args.some(arg => ['capture', 'declare', 'cue'].includes(arg)) ? 0 : 1
  }
}
