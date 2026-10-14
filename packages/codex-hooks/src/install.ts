import { cp, lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { CaptureSettings } from './capture.ts'
import { captureSettingsSchema, codexDirectory, hash, hookEvents, inside, installationPath, userInstallationPath, readJson, writeJson } from './capture.ts'
import { matchesConfigFile } from '@jacob-z/jt-harness/memo/config'
import { cueMarker } from './cues.ts'

const marker = 'jth memo capture'
const declarationHookMarker = 'jth memo declaration'

export async function configureSkill(root: string, workspace: string, kind: 'flow' | 'memo', enabled = true) {
  const name = `jth-${kind}`, source = resolve(root, `packages/${kind}/skills/${name}`)
  const target = resolve(workspace, '.agents/skills', name)
  const prior = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (enabled) {
    await readFile(resolve(source, 'SKILL.md'), 'utf8')
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await cp(source, temporary, { recursive: true, dereference: true })
      if (prior) await rm(target, { recursive: true, force: true })
      await rename(temporary, target)
    } finally { await rm(temporary, { recursive: true, force: true }) }
    await configureProjectIgnore(workspace)
  } else if (prior) await rm(target, { recursive: true, force: true })
  return target
}

export async function configureProjectIgnore(workspace: string) {
  const path = resolve(workspace, '.gitignore')
  const original = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const retired = new Set(['/.jth/', '/.agents/skills/jth-flow', '/.agents/skills/jth-memo', '/.codex/hooks.json'])
  const lines = (original ? original.replace(/\r?\n$/u, '').split(/\r?\n/) : []).filter(line => !retired.has(line))
  for (const line of ['/.jth/*', '!/.jth/flow.json', '!/.jth/workflow.json']) if (!lines.includes(line)) lines.push(line)
  const next = `${lines.join('\n')}\n`
  if (next !== original) await writeFile(path, next)
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
export const hookCommand = (...args: string[]) => ['jth', '--', ...args].map(quote).join(' ')
export const legacyCleanupMarker = 'jth legacy cleanup'
export const legacyCleanupCommand = hookCommand('migrate', '--session-start')
export const memoHookCommand = (_settings: CaptureSettings, action: 'declare' | 'cue') => hookCommand('memo', 'codex', action)
export const memoLocatorPath = (workspace: string) => resolve(workspace, '.jth/memo.json')
type HookHandler = { statusMessage?: string, command?: string, [key: string]: unknown }
type HookGroup = { hooks?: HookHandler[], [key: string]: unknown }
type HookConfig = { hooks?: Record<string, HookGroup[]>, [key: string]: unknown }

const ownedCommands: Record<string, readonly string[][]> = {
  'jth memo capture': [['memo', 'codex', 'capture']],
  'jth memo declaration': [['memo', 'codex', 'declare']],
  'jth memo cues': [['memo', 'codex', 'cue']],
  'jth flow context': [['flow', 'legacy', 'hook'], ['flow', 'hook']],
  'jth flow entry': [['flow', 'prompt']],
  'jth monitor': [['monitor', 'capture']],
  [legacyCleanupMarker]: [['migrate', '--session-start']],
}
const ownedEvents: Record<string, readonly string[]> = {
  'jth memo capture': hookEvents,
  'jth memo declaration': ['Stop'],
  'jth memo cues': ['SessionStart', 'UserPromptSubmit'],
  'jth flow context': [...hookEvents, 'UserPromptSubmit'],
  'jth flow entry': ['UserPromptSubmit'],
  'jth monitor': ['UserPromptSubmit', 'Stop', 'Interrupt'],
  [legacyCleanupMarker]: ['SessionStart'],
}

/** Ownership requires the JTH command and its marker; status text alone belongs to nobody. */
export function ownsHook(handler: HookHandler, marker = handler.statusMessage, event?: string) {
  if (!marker || handler.statusMessage !== marker || !handler.command || !ownedCommands[marker]) return false
  if (marker === legacyCleanupMarker) return event === 'SessionStart' && handler.command === legacyCleanupCommand
  if (event && !ownedEvents[marker].includes(event)) return false
  return ownedCommands[marker].some(args => handler.command === hookCommand(...args)
    || handler.command === `jth ${args.join(' ')}`
    || new RegExp(`^(?:'[^']*/jth'|[^\\s]+/jth) (?:'--'|--) ${args.map(arg => `(?:'${arg}'|${arg})`).join(' ')}$`).test(handler.command!)
    || ownsLegacyHookCommand(handler.command!, args))
}

function ownsLegacyHookCommand(command: string, args: readonly string[]) {
  const quoted = command.match(/'(?:[^']|'\\'')*'/g)
  if (!quoted || quoted.join(' ') !== command) return false
  const words = quoted.map(word => word.slice(1, -1).replaceAll("'\\''", "'"))
  if (!isAbsolute(words[0]) || basename(words[0]) !== 'node' || words[1] !== '--'
    || !isAbsolute(words[2]) || !words[2].endsWith('/node_modules/@jacob-z/jt-harness/bin/jth.mjs')
    || args.some((arg, index) => words[index + 3] !== arg)) return false
  const options = words.slice(args.length + 3)
  if (options.length % 2) return false
  const values = new Map<string, string[]>()
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index], value = options[index + 1]
    const allowed = args[0] === 'memo' ? ['--env-file', '--workspace', '--codex-home', '--since', '--project', '--business'] : ['--workspace', '--env-file']
    if (!allowed.includes(flag) || !value.trim()) return false
    if (['--env-file', '--workspace', '--codex-home'].includes(flag) && !isAbsolute(value)) return false
    if (flag === '--since' && !Number.isFinite(Date.parse(value))) return false
    const prior = values.get(flag) ?? []
    if (prior.length && !['--project', '--business'].includes(flag)) return false
    values.set(flag, prior.concat(value))
  }
  return args[0] === 'memo'
    ? ['--env-file', '--workspace', '--codex-home', '--since', '--project'].every(flag => values.has(flag))
    : values.has('--workspace')
}

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
      const handlers = group.hooks.filter(handler => !ownsHook(handler, options.marker ?? marker, event))
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

export async function configureUserHooks(root: string, config: { dataDir: string, envFile: string }, codexHome: string, enabled = true, userHome = homedir()) {
  const hooksPath = resolve(codexHome, 'hooks.json'), manifestPath = userInstallationPath(config, codexHome)
  const prior = await readJson(manifestPath) as { disabled?: boolean, settings?: { enabled_at?: string } } | undefined
  const enabled_at = !prior?.disabled && prior?.settings?.enabled_at ? prior.settings.enabled_at : new Date().toISOString()
  const skills = await Promise.all((['flow', 'memo'] as const).map(kind => configureUserSkill(root, userHome, kind, enabled)))
  const backups = resolve(codexDirectory(config), 'backups')
  await updateHookConfig(hooksPath, backups, document => {
    let next = document
    for (const ownedMarker of Object.keys(ownedCommands).filter(ownedMarker => !enabled || ownedMarker !== 'jth monitor')) next = mergeHooks(next, undefined, { marker: ownedMarker, events: [...hookEvents, 'UserPromptSubmit'] })
    if (!enabled) return next
    next = mergeHooks(next, hookCommand('memo', 'codex', 'declare'), { marker: declarationHookMarker, events: ['Stop'] })
    next = mergeHooks(next, hookCommand('memo', 'codex', 'cue'), { marker: cueMarker, events: ['SessionStart', 'UserPromptSubmit'], additionalContextLimit: 2400 })
    next = mergeHooks(next, legacyCleanupCommand, { marker: legacyCleanupMarker, events: ['SessionStart'], additionalContextLimit: 512 })
    return mergeHooks(next, hookCommand('flow', 'prompt'), { marker: 'jth flow entry', events: ['UserPromptSubmit'], additionalContextLimit: 512 })
  })
  const settings = { enabled_at, codex_home: codexHome, env_file: config.envFile }
  await writeJson(manifestPath, { hooks_path: hooksPath, settings, disabled: !enabled, mode: 'user-declaration' })
  return { status: enabled ? 'installed' : 'uninstalled', mode: 'user-declaration', hooks_path: hooksPath, skills, enabled_at, settings }
}

async function configureUserSkill(root: string, userHome: string, kind: 'flow' | 'memo', enabled: boolean) {
  const name = `jth-${kind}`, source = resolve(root, `packages/${kind}/skills/${name}`), target = resolve(userHome, '.agents/skills', name)
  const prior = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!enabled) {
    if (prior && await ownedSkill(target, kind)) await rm(target, { recursive: true, force: true })
    return target
  }
  if (prior && !await ownedSkill(target, kind)) throw new Error(`已有 ${name} Skill 不属于 JTH；没有覆盖`)
  await readFile(resolve(source, 'SKILL.md'), 'utf8')
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await cp(source, temporary, { recursive: true, dereference: true })
    if (prior) await rm(target, { recursive: true, force: true })
    await rename(temporary, target)
  } finally { await rm(temporary, { recursive: true, force: true }) }
  return target
}

async function ownedSkill(path: string, kind: 'flow' | 'memo') {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (info?.isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path))
    if (target.endsWith(`/node_modules/@jacob-z/jt-harness/packages/${kind}/skills/jth-${kind}`)) return true
  }
  const content = await readFile(resolve(path, 'SKILL.md'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
  return new RegExp(`^name: jth-${kind}\\s*$`, 'm').test(content) && content.includes(`jth ${kind}`)
}

type CleanupFile = { path: string, info: Stats | null, content: string }
type CleanupSkill = { path: string, kind: 'flow' | 'memo', info: Stats, content: string, link: string | null }

async function cleanupPathInfo(workspace: string, path: string, allowSymlink = false) {
  let parent = dirname(path)
  while (!await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })) parent = dirname(parent)
  if (!inside(workspace, await realpath(parent))) throw new Error(`清理路径的父目录不在项目内；保留内容：${path}`)
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (info?.isSymbolicLink() && !allowSymlink) throw new Error(`清理配置是符号链接；保留内容：${path}`)
  return info
}

async function cleanupFile(workspace: string, path: string): Promise<CleanupFile> {
  const info = await cleanupPathInfo(workspace, path)
  return { path, info, content: info ? await readFile(path, 'utf8') : '' }
}

function sameCleanupIdentity(original: Stats | null, current: Stats | null) {
  if (!original || !current) return original === current
  return (['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => original[key] === current[key])
}

async function assertCleanupFile(workspace: string, file: CleanupFile) {
  const current = await cleanupFile(workspace, file.path)
  if (!sameCleanupIdentity(file.info, current.info) || file.content !== current.content) throw new Error(`清理配置被其他进程更新；保留内容，请重试：${file.path}`)
}

async function assertCleanupSkill(workspace: string, skill: CleanupSkill) {
  const info = await cleanupPathInfo(workspace, skill.path, true)
  const link = info?.isSymbolicLink() ? await readlink(skill.path) : null
  const content = await readFile(resolve(skill.path, 'SKILL.md'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
  if (!sameCleanupIdentity(skill.info, info) || skill.link !== link || skill.content !== content) throw new Error(`清理 Skill 被其他进程更新；保留内容，请重试：${skill.path}`)
}

/** Remove only installed project entrances; archived queues, tasks and runtime evidence stay intact. */
export async function cleanupProjectInstallation(workspace: string, options: { dataDir: string, dryRun?: boolean, registered?: boolean, existingOnly?: boolean }) {
  const canonicalWorkspace = await realpath(workspace)
  const backups = resolve(codexDirectory(options), 'backups', `project-${hash(workspace)}-${Date.now()}-${randomUUID()}`)
  const removed: string[] = [], handlers: string[] = [], skills: CleanupSkill[] = []
  const changes: { file: CleanupFile, next: string | HookConfig | null }[] = []
  const hooks = await cleanupFile(canonicalWorkspace, resolve(workspace, '.codex/hooks.json'))
  if (hooks.content) {
    const document: HookConfig = JSON.parse(hooks.content)
    for (const [event, groups] of Object.entries(document.hooks ?? {})) for (const group of groups) for (const handler of group.hooks ?? []) if (ownsHook(handler, handler.statusMessage, event)) handlers.push(handler.command!)
    const remaining = Object.keys(ownedCommands).reduce((next, ownedMarker) => mergeHooks(next, undefined, { marker: ownedMarker, events: Object.keys(next.hooks ?? {}) }), document)
    const removeFile = handlers.length > 0 && !Object.keys(remaining.hooks ?? {}).length && Object.keys(remaining).every(key => key === 'hooks')
    if (removeFile) removed.push(hooks.path)
    if (handlers.length) changes.push({ file: hooks, next: removeFile ? null : remaining })
  }
  for (const directory of ['.agents/skills', '.codex/skills', '.claude/skills']) for (const kind of ['flow', 'memo'] as const) {
    const path = resolve(workspace, directory, `jth-${kind}`), info = await cleanupPathInfo(canonicalWorkspace, path, true)
    if (!info || !await ownedSkill(path, kind)) continue
    const content = await readFile(resolve(path, 'SKILL.md'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
    skills.push({ path, kind, info, content, link: info.isSymbolicLink() ? await readlink(path) : null })
    removed.push(path)
  }
  for (const name of ['memo.json', 'flow.json', 'workflow.json', 'monitor.json']) {
    const file = await cleanupFile(canonicalWorkspace, resolve(workspace, '.jth', name))
    if (!file.content) continue
    const document = JSON.parse(file.content)
    const locator = document.version === 2 && Object.keys(document).every(key => ['version', 'workspace', 'envFile'].includes(key)) && typeof document.workspace === 'string' && typeof document.envFile === 'string'
      || document.version === 3 && Object.keys(document).every(key => ['version', 'scope'].includes(key)) && document.scope && Object.keys(document.scope).every(key => ['project_ids', 'business_ids'].includes(key)) && Array.isArray(document.scope.project_ids) && Array.isArray(document.scope.business_ids)
    const owned = name === 'memo.json' ? locator
      : name === 'flow.json' ? locator || document.version === 1 && document.workspace === workspace && typeof document.installedAt === 'string'
      : name === 'workflow.json' ? Object.keys(document).every(key => key === 'mode') && (document.mode === undefined || ['adaptive', 'strict'].includes(document.mode))
      : Object.keys(document).every(key => ['enabled', 'url'].includes(key)) && typeof document.enabled === 'boolean'
    if (!owned || (!options.registered && !locator && name !== 'flow.json')) continue
    removed.push(file.path)
    changes.push({ file, next: null })
  }
  const agents = await cleanupFile(canonicalWorkspace, resolve(workspace, 'AGENTS.md'))
  if (agents.content.includes('<!-- JTH_MEMORY_START -->') !== agents.content.includes('<!-- JTH_MEMORY_END -->')) throw new Error('已有 JTH 记忆说明区间不完整；未覆盖 AGENTS.md')
  if (agents.content.includes('<!-- JTH_MEMORY_START -->')) {
    removed.push(`${agents.path}#JTH_MEMORY`)
    changes.push({ file: agents, next: agents.content.replace(/\n?<!-- JTH_MEMORY_START -->[\s\S]*?<!-- JTH_MEMORY_END -->\n?/u, '') })
  }
  const ignore = await cleanupFile(canonicalWorkspace, resolve(workspace, '.gitignore'))
  if (options.registered) {
    const entrances = new Set(['/.jth/*', '!/.jth/flow.json', '!/.jth/workflow.json', '/.agents/skills/jth-flow', '/.agents/skills/jth-memo', '/.codex/hooks.json'])
    const preserved = ignore.content.split(/(?<=\n)/u).filter(line => !entrances.has(line.replace(/\r?\n$/u, ''))).join('')
    if (!options.existingOnly || removed.length || handlers.length || preserved !== ignore.content) {
      const next = preserved.split(/\r?\n/u).includes('/.jth/') ? preserved : `${preserved}${preserved && !preserved.endsWith('\n') ? '\n' : ''}/.jth/\n`
      if (ignore.content !== next) {
        removed.push(`${ignore.path}#JTH`)
        changes.push({ file: ignore, next })
      }
    }
  }
  if (!options.dryRun) {
    for (const { file } of changes) await assertCleanupFile(canonicalWorkspace, file)
    for (const skill of skills) await assertCleanupSkill(canonicalWorkspace, skill)
    for (const { file, next } of changes) {
      await assertCleanupFile(canonicalWorkspace, file)
      await writeJson(resolve(backups, `${hash(file.path)}.json`), { path: file.path, content: file.content })
      await assertCleanupFile(canonicalWorkspace, file)
      if (next === null) await rm(file.path)
      else if (typeof next === 'string') await writeFile(file.path, next)
      else await writeJson(file.path, next)
    }
    for (const skill of skills) {
      await assertCleanupSkill(canonicalWorkspace, skill)
      await mkdir(backups, { recursive: true })
      await cp(skill.path, resolve(backups, `${hash(skill.path)}-jth-${skill.kind}`), { recursive: true, dereference: false, verbatimSymlinks: true })
      await assertCleanupSkill(canonicalWorkspace, skill)
      await rm(skill.path, { recursive: true, force: true })
    }
  }
  return { workspace, dry_run: Boolean(options.dryRun), removed, handlers, backup_directory: !options.dryRun && (removed.length || handlers.length) ? backups : null }
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
  const command = (action: 'declare' | 'cue') => settings ? memoHookCommand(settings, action) : undefined
  const backups = resolve(codexDirectory(config), 'backups')
  const skill = await configureSkill(root, workspace, 'memo', Boolean(settings))
  await removeDeclarationInstructions(workspace, backups)
  await updateHookConfig(hooksPath, backups, document => mergeHooks(mergeHooks(
    mergeHooks(document), command('declare'), { marker: declarationHookMarker, events: ['Stop'] },
  ), command('cue'), { marker: cueMarker, events: ['SessionStart', 'UserPromptSubmit'], additionalContextLimit: 1600 }))
  if (settings) {
    await writeJson(manifestPath, { hooks_path: hooksPath, settings, disabled: false, mode: 'declaration' })
    await rm(memoLocatorPath(workspace), { force: true })
  } else {
    await writeJson(manifestPath, { hooks_path: hooksPath, settings: prior?.settings, disabled: true, mode: prior?.mode })
    await rm(memoLocatorPath(workspace), { force: true })
  }
  return { status: settings ? 'installed' : 'uninstalled', mode: 'declaration', hooks_path: hooksPath, events: settings ? ['Stop', 'SessionStart', 'UserPromptSubmit'] : [],
    skill, settings, ...(settings ? { activation: '在 Codex /hooks 中审阅并信任新增定义；新会话或恢复后生效' } : {}) }
}
