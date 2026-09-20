import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CaptureSettings } from './capture.ts'
import { captureSettingsSchema, codexDirectory, hash, hookEvents, installationPath, readJson, writeJson } from './capture.ts'
import { declarationInstructions } from './instructions.ts'

const marker = 'jth memo capture'
const declarationHookMarker = 'jth memo declaration'

async function updateDeclarationInstructions(workspace: string, enabled: boolean, backupDirectory: string) {
  const path = resolve(workspace, 'AGENTS.md')
  const original = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const start = '<!-- JTH_MEMORY_START -->', end = '<!-- JTH_MEMORY_END -->'
  if (original.includes(start) !== original.includes(end)) throw new Error('已有 JTH 记忆说明区间不完整；未覆盖 AGENTS.md')
  const cleaned = original.replace(/\n?<!-- JTH_MEMORY_START -->[\s\S]*?<!-- JTH_MEMORY_END -->\n?/u, '')
  const next = enabled ? `${cleaned}${cleaned && !cleaned.endsWith('\n') ? '\n' : ''}\n${start}\n${declarationInstructions}\n${end}\n` : cleaned
  if (original === next) return
  if (original) await writeJson(resolve(backupDirectory, `${hash(path)}-${Date.now()}.json`), { path, content: original })
  const current = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if (current !== original) throw new Error('AGENTS.md 被其他进程更新；保留内容，请重试')
  await writeFile(path, next)
}
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
type HookHandler = { statusMessage?: string, command?: string, [key: string]: unknown }
type HookGroup = { hooks?: HookHandler[], [key: string]: unknown }
type HookConfig = { hooks?: Record<string, HookGroup[]>, [key: string]: unknown }

export function mergeHooks(existing: HookConfig, command?: string, options: { marker?: string, events?: readonly string[], additionalContextLimit?: number } = {}) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)
    || (existing.hooks !== undefined && (!existing.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks)))) {
    throw new Error('已有 Hook 配置无效；没有覆盖原配置')
  }
  const hooks = { ...existing.hooks }
  for (const event of options.events ?? hookEvents) {
    const groups = hooks[event] ?? []
    if (!Array.isArray(groups)) throw new Error(`已有 ${event} Hook 配置无效；没有覆盖原配置`)
    const preserved = groups.flatMap(group => {
      if (!Array.isArray(group.hooks)) throw new Error(`已有 ${event} Hook handler 无效；没有覆盖原配置`)
      const handlers = group.hooks.filter(handler => handler.statusMessage !== (options.marker ?? marker))
      return handlers.length ? [{ ...group, hooks: handlers }] : []
    })
    if (command) preserved.push({ hooks: [{ type: 'command', command, timeout: 3, statusMessage: options.marker ?? marker,
      ...(options.additionalContextLimit ? { additionalContextLimit: options.additionalContextLimit } : {}),
    }] })
    if (preserved.length) hooks[event] = preserved
    else delete hooks[event]
  }
  return { ...existing, hooks }
}

export async function updateHookConfig(hooksPath: string, backupDirectory: string, transform: (document: HookConfig) => HookConfig) {
  const read = () => readFile(hooksPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const original = await read()
  const document: HookConfig = original ? JSON.parse(original) : {}
  const next = transform(document)
  if (JSON.stringify(next) === JSON.stringify(document)) return
  if (original) await writeJson(resolve(backupDirectory, `${hash(hooksPath)}-${Date.now()}.json`), document)
  if (await read() !== original) throw new Error('Hook 配置被其他进程更新；请重试，原配置未覆盖')
  await writeJson(hooksPath, next)
}

export async function configureHooks(root: string, config: { dataDir: string, envFile: string }, workspace: string, scope: CaptureSettings['scope'] | undefined, home: string) {
  const hooksPath = resolve(workspace, '.codex/hooks.json')
  const manifestPath = installationPath(config, workspace)
  const prior = await readJson(manifestPath) as { settings?: CaptureSettings, disabled?: boolean, mode?: string } | undefined
  const settings = scope ? captureSettingsSchema.parse({
    workspace, codex_home: home, env_file: config.envFile, enabled_at: prior?.disabled || prior?.mode !== 'declaration' ? new Date().toISOString() : prior.settings?.enabled_at ?? new Date().toISOString(), scope,
  }) : undefined
  if (settings && prior?.settings && !prior.disabled && (JSON.stringify(prior.settings.scope) !== JSON.stringify(settings.scope)
    || prior.settings.workspace !== settings.workspace || prior.settings.env_file !== settings.env_file || prior.settings.codex_home !== settings.codex_home)) throw new Error('已有安装的范围不同；请先 uninstall，再重新 install')
  const command = settings ? [process.execPath, resolve(root, 'bin/jth.mjs'), 'memo', 'codex', 'declare',
    '--env-file', config.envFile, '--workspace', settings.workspace, '--codex-home', settings.codex_home,
    '--since', settings.enabled_at, ...settings.scope.project_ids.flatMap(id => ['--project', id]),
    ...settings.scope.business_ids.flatMap(id => ['--business', id]),
  ].map(quote).join(' ') : undefined
  const backups = resolve(codexDirectory(config), 'backups')
  await updateDeclarationInstructions(workspace, Boolean(settings), backups)
  await updateHookConfig(hooksPath, backups, document => mergeHooks(
    mergeHooks(mergeHooks(document), undefined, { marker: declarationHookMarker }), command, { marker: declarationHookMarker, events: ['Stop'] },
  ))
  if (settings) await writeJson(manifestPath, { hooks_path: hooksPath, settings, disabled: false, mode: 'declaration' })
  else await writeJson(manifestPath, { hooks_path: hooksPath, settings: prior?.settings, disabled: true, mode: prior?.mode })
  return { status: settings ? 'installed' : 'uninstalled', mode: 'declaration', hooks_path: hooksPath, events: settings ? ['Stop'] : [],
    settings, ...(settings ? { activation: '在 Codex /hooks 中审阅并信任新增定义；新会话或恢复后生效' } : {}) }
}
