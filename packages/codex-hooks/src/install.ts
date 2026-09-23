import { appendFile, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CaptureSettings } from './capture.ts'
import { captureSettingsSchema, codexDirectory, hash, hookEvents, installationPath, readJson, writeJson } from './capture.ts'
import { matchesConfigFile } from '@jt-harness/memo/config'
import { cueMarker } from './cues.ts'

const marker = 'jth memo capture'
const declarationHookMarker = 'jth memo declaration'

export async function configureSkill(root: string, workspace: string, kind: 'flow' | 'memo', enabled = true) {
  const name = `jth-${kind}`, source = resolve(root, `packages/${kind}/skills/${name}`)
  const target = resolve(workspace, '.agents/skills', name)
  const prior = await readlink(target).catch(error => { if (error.code === 'ENOENT') return null; throw new Error(`已有 ${name} Skill 不是本工具的链接；保留原文件`) })
  if (prior && resolve(dirname(target), prior) !== source) throw new Error(`已有 ${name} Skill 指向其他安装；保留原链接`)
  if (enabled) {
    await readFile(resolve(source, 'SKILL.md'), 'utf8')
    await mkdir(dirname(target), { recursive: true })
    if (!prior) await symlink(source, target)
    const ignorePath = resolve(workspace, '.gitignore'), line = `/.agents/skills/${name}`
    const ignore = await readFile(ignorePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    if (!ignore.split(/\r?\n/).includes(line)) await appendFile(ignorePath, `${ignore.endsWith('\n') || !ignore ? '' : '\n'}${line}\n`)
  } else if (prior) await unlink(target)
  return target
}

async function removeDeclarationInstructions(workspace: string, backupDirectory: string) {
  const path = resolve(workspace, 'AGENTS.md')
  const original = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const start = '<!-- JTH_MEMORY_START -->', end = '<!-- JTH_MEMORY_END -->'
  if (original.includes(start) !== original.includes(end)) throw new Error('已有 JTH 记忆说明区间不完整；未覆盖 AGENTS.md')
  const next = original.replace(/\n?<!-- JTH_MEMORY_START -->[\s\S]*?<!-- JTH_MEMORY_END -->\n?/u, '')
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

export async function configureHooks(root: string, config: { dataDir: string, envFile: string, envAliases?: readonly string[] }, workspace: string, scope: CaptureSettings['scope'] | undefined, home: string) {
  const hooksPath = resolve(workspace, '.codex/hooks.json')
  const manifestPath = installationPath(config, workspace)
  const prior = await readJson(manifestPath) as { settings?: CaptureSettings, disabled?: boolean, mode?: string } | undefined
  const settings = scope ? captureSettingsSchema.parse({
    workspace, codex_home: home, env_file: config.envFile, enabled_at: prior?.disabled || prior?.mode !== 'declaration' ? new Date().toISOString() : prior.settings?.enabled_at ?? new Date().toISOString(), scope,
  }) : undefined
  if (settings && prior?.settings && !prior.disabled && (JSON.stringify(prior.settings.scope) !== JSON.stringify(settings.scope)
    || prior.settings.workspace !== settings.workspace || !matchesConfigFile(config, prior.settings.env_file) || prior.settings.codex_home !== settings.codex_home)) throw new Error('已有安装的范围不同；请先 uninstall，再重新 install')
  const command = (action: string) => settings ? [process.execPath, '--', resolve(root, 'bin/jth.mjs'), 'memo', 'codex', action,
    '--env-file', config.envFile, '--workspace', settings.workspace, '--codex-home', settings.codex_home,
    '--since', settings.enabled_at, ...settings.scope.project_ids.flatMap(id => ['--project', id]),
    ...settings.scope.business_ids.flatMap(id => ['--business', id]),
  ].map(quote).join(' ') : undefined
  const backups = resolve(codexDirectory(config), 'backups')
  const skill = await configureSkill(root, workspace, 'memo', Boolean(settings))
  await removeDeclarationInstructions(workspace, backups)
  await updateHookConfig(hooksPath, backups, document => mergeHooks(mergeHooks(
    mergeHooks(document), command('declare'), { marker: declarationHookMarker, events: ['Stop'] },
  ), command('cue'), { marker: cueMarker, events: ['SessionStart', 'UserPromptSubmit'], additionalContextLimit: 1600 }))
  if (settings) await writeJson(manifestPath, { hooks_path: hooksPath, settings, disabled: false, mode: 'declaration' })
  else await writeJson(manifestPath, { hooks_path: hooksPath, settings: prior?.settings, disabled: true, mode: prior?.mode })
  return { status: settings ? 'installed' : 'uninstalled', mode: 'declaration', hooks_path: hooksPath, events: settings ? ['Stop', 'SessionStart', 'UserPromptSubmit'] : [],
    skill, settings, ...(settings ? { activation: '在 Codex /hooks 中审阅并信任新增定义；新会话或恢复后生效' } : {}) }
}
