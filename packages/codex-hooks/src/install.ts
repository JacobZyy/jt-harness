import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CaptureSettings } from './capture.ts'
import { captureSettingsSchema, codexDirectory, hash, hookEvents, installationPath, readJson, writeJson } from './capture.ts'

const marker = 'jth memo capture'
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
type HookHandler = { statusMessage?: string, command?: string, [key: string]: unknown }
type HookGroup = { hooks?: HookHandler[], [key: string]: unknown }
type HookConfig = { hooks?: Record<string, HookGroup[]>, [key: string]: unknown }

export function mergeHooks(existing: HookConfig, command?: string) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)
    || (existing.hooks !== undefined && (!existing.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks)))) {
    throw new Error('已有 Hook 配置无效；没有覆盖原配置')
  }
  const hooks = { ...existing.hooks }
  for (const event of hookEvents) {
    const groups = hooks[event] ?? []
    if (!Array.isArray(groups)) throw new Error(`已有 ${event} Hook 配置无效；没有覆盖原配置`)
    const preserved = groups.flatMap(group => {
      if (!Array.isArray(group.hooks)) throw new Error(`已有 ${event} Hook handler 无效；没有覆盖原配置`)
      const handlers = group.hooks.filter(handler => handler.statusMessage !== marker)
      return handlers.length ? [{ ...group, hooks: handlers }] : []
    })
    if (command) preserved.push({ hooks: [{ type: 'command', command, timeout: 3, statusMessage: marker }] })
    if (preserved.length) hooks[event] = preserved
    else delete hooks[event]
  }
  return { ...existing, hooks }
}

export async function configureHooks(root: string, config: { dataDir: string, envFile: string }, workspace: string, scope: CaptureSettings['scope'] | undefined, home: string) {
  const hooksPath = resolve(workspace, '.codex/hooks.json')
  const manifestPath = installationPath(config, workspace)
  const prior = await readJson(manifestPath) as { settings?: CaptureSettings, disabled?: boolean } | undefined
  const settings = scope ? captureSettingsSchema.parse({
    workspace, codex_home: home, env_file: config.envFile, enabled_at: prior?.disabled ? new Date().toISOString() : prior?.settings?.enabled_at ?? new Date().toISOString(), scope,
  }) : undefined
  if (settings && prior && !prior.disabled && JSON.stringify(prior.settings) !== JSON.stringify(settings)) throw new Error('已有安装的范围不同；请先 uninstall，再重新 install')
  let original = ''
  try { original = await readFile(hooksPath, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const document: HookConfig = original ? JSON.parse(original) : {}
  const command = settings ? [process.execPath, resolve(root, 'bin/jth.mjs'), 'memo', 'codex', 'capture',
    '--env-file', config.envFile, '--workspace', settings.workspace, '--codex-home', settings.codex_home,
    '--since', settings.enabled_at, ...settings.scope.project_ids.flatMap(id => ['--project', id]),
    ...settings.scope.business_ids.flatMap(id => ['--business', id]),
  ].map(quote).join(' ') : undefined
  const next = mergeHooks(document, command)
  if (JSON.stringify(next) !== JSON.stringify(document)) {
    if (original) await writeJson(resolve(codexDirectory(config), 'backups', `${hash(hooksPath)}-${Date.now()}.json`), document)
    let latest = ''
    try { latest = await readFile(hooksPath, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (latest !== original) throw new Error('Hook 配置被其他进程更新；请重试，原配置未覆盖')
    await writeJson(hooksPath, next)
  }
  if (settings) await writeJson(manifestPath, { hooks_path: hooksPath, settings, disabled: false })
  else await writeJson(manifestPath, { hooks_path: hooksPath, settings: prior?.settings, disabled: true })
  return { status: settings ? 'installed' : 'uninstalled', hooks_path: hooksPath, events: settings ? [...hookEvents] : [],
    settings, ...(settings ? { activation: '在 Codex /hooks 中审阅并信任新增定义；新会话或恢复后生效' } : {}) }
}

