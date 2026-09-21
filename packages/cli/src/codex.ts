import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { safeError } from '@jt-harness/memo/config'
import { loadWorkspaceConfig } from './configuration.ts'
import type { Config } from '@jt-harness/memo/config'
import { captureSettingsSchema, captureDeclaration, captureStatus, configureHooks } from '@jt-harness/codex-hooks'
import { startWorker } from './background.ts'

export async function codexMain(root: string, args: string[]) {
  let config: Config | undefined
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      'env-file': { type: 'string' }, workspace: { type: 'string' }, 'codex-home': { type: 'string' }, since: { type: 'string' },
      project: { type: 'string', multiple: true }, business: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
    } })
    if (values.help || !positionals.length) {
      process.stdout.write('jth memo codex install --project <id> [--business <id>] [--workspace <path>]\njth memo codex uninstall [--workspace <path>]\njth memo codex status\njth memo codex declare < Stop JSON stdin\n通用：--env-file <path>、--codex-home <path>。install 只安装 Stop 声明入口和一份简短项目说明，后台仅生成向量。\n')
      return
    }
    if (positionals.length !== 1 || !['install', 'uninstall', 'status', 'capture', 'declare'].includes(positionals[0])) throw new Error('未知 Codex 采集命令')
    const allowed: Record<string, string[]> = {
      install: ['workspace', 'codex-home', 'project', 'business'], uninstall: ['workspace'], status: [],
      capture: ['workspace', 'codex-home', 'since', 'project', 'business'],
      declare: ['workspace', 'codex-home', 'since', 'project', 'business'],
    }
    const invalid = Object.keys(values).filter(name => !['env-file', 'help', ...allowed[positionals[0]]].includes(name))
    if (invalid.length) throw new Error(`${positionals[0]} 不支持：${invalid.join(', ')}`)
    const workspace = await realpath(resolve(values.workspace ?? process.cwd()))
    config = await loadWorkspaceConfig(root, values['env-file'], workspace)
    const home = resolve(values['codex-home'] ?? process.env.CODEX_HOME ?? resolve(homedir(), '.codex'))
    const scope = { project_ids: values.project ?? [], business_ids: values.business ?? [] }
    if (['capture', 'declare'].includes(positionals[0])) {
      const settings = captureSettingsSchema.parse({ workspace, codex_home: home, env_file: config.envFile, enabled_at: values.since, scope })
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of process.stdin) {
        bytes += chunk.length
        if (bytes > 512_000) throw new Error('Hook 输入超过 512000 字节')
        chunks.push(Buffer.from(chunk))
      }
      const capture = await captureDeclaration(JSON.parse(Buffer.concat(chunks).toString('utf8')), settings, config)
      if (capture) await startWorker(root, config)
      // Hook stdout belongs to Codex's control protocol, not the memo CLI receipt.
      return
    }
    const result = positionals[0] === 'status' ? await captureStatus(config)
      : await configureHooks(root, config, workspace, positionals[0] === 'install' ? scope : undefined, home)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: safeError(error, config), recovery: 'jth memo work' })}\n`)
    process.exitCode = args.some(arg => arg === 'capture' || arg === 'declare') ? 0 : 1
  }
}
