// Codex user-level hook installation for jth-core.
//
// Codex reads { "hooks": { "<Event>": [ { "matcher"?, "hooks": [ handler ] } ] } }. A handler placed
// directly under an event is ignored, so entries are always written as groups. Ownership is decided
// by the command a handler runs, never by its status text.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'Stop'

interface HookHandler { type?: string; command?: string; timeout?: number; statusMessage?: string; [key: string]: unknown }
interface HookGroup { hooks: HookHandler[]; [key: string]: unknown }
interface HooksFile { hooks?: Record<string, unknown>; [key: string]: unknown }

interface OwnedHook { event: HookEvent; args: readonly string[]; timeout: number; statusMessage: string }

const CORE_HOOKS: readonly OwnedHook[] = [
  { event: 'SessionStart', args: ['memo', 'core', 'cue'], timeout: 30, statusMessage: 'jth · 记忆召回' },
  { event: 'UserPromptSubmit', args: ['memo', 'core', 'cue'], timeout: 30, statusMessage: 'jth · 记忆召回' },
  { event: 'UserPromptSubmit', args: ['flow', 'core', 'entry'], timeout: 30, statusMessage: 'jth · 流程提醒' },
  { event: 'Stop', args: ['memo', 'core', 'declare'], timeout: 60, statusMessage: 'jth-core memo declare' },
]

// Memo and Flow entrances of the PostgreSQL-based system that the core hooks replace.
const RETIRED_COMMANDS: readonly (readonly string[])[] = [
  ['memo', 'codex', 'cue'], ['memo', 'codex', 'declare'], ['memo', 'codex', 'capture'],
  ['flow', 'prompt'], ['flow', 'hook'], ['flow', 'legacy', 'hook'],
]

export interface HookInstallOptions {
  /** Codex home; defaults to $CODEX_HOME or ~/.codex. */
  codexHome?: string
  /** Command used to start jth. Defaults to ~/.local/bin/jth when present, otherwise `jth` from PATH. */
  binary?: string
}

const word = (value: string) => `['"]?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?`

function runs(handler: unknown, args: readonly string[]): boolean {
  const command = (handler as HookHandler | null)?.command
  if (typeof command !== 'string') return false
  return new RegExp(`(?:^|/|['"])jth['"]?\\s+(?:${word('--')}\\s+)?${args.map(word).join('\\s+')}\\s*$`).test(command.trim())
}

const isGroup = (entry: unknown): entry is HookGroup =>
  Boolean(entry) && typeof entry === 'object' && Array.isArray((entry as HookGroup).hooks)

const shellWord = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`

function defaultBinary(): string {
  const local = join(homedir(), '.local', 'bin', 'jth')
  return existsSync(local) ? local : 'jth'
}

function handlerFor(hook: OwnedHook, binary: string): HookHandler {
  return { type: 'command', command: `${shellWord(binary)} -- ${hook.args.join(' ')}`, timeout: hook.timeout, statusMessage: hook.statusMessage }
}

/** Returns the next document. Foreign groups, their order and unknown keys are preserved. */
export function mergeCoreHooks(document: HooksFile, binary: string | null): HooksFile {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.hooks !== undefined && (!document.hooks || typeof document.hooks !== 'object' || Array.isArray(document.hooks))) {
    throw new Error('已有 Hook 配置无效；没有覆盖原配置')
  }
  const hooks: Record<string, unknown> = { ...document.hooks }
  const events = new Set([...Object.keys(hooks), ...(binary ? CORE_HOOKS.map(hook => hook.event) : [])])
  for (const event of events) {
    const entries = hooks[event] ?? []
    if (!Array.isArray(entries)) throw new Error(`已有 ${event} Hook 配置无效；没有覆盖原配置`)
    const wanted = binary ? CORE_HOOKS.filter(hook => hook.event === event) : []
    const placed = new Set<OwnedHook>()
    const owned = (handler: unknown) => CORE_HOOKS.some(hook => runs(handler, hook.args)) || RETIRED_COMMANDS.some(args => runs(handler, args))
    const next = entries.flatMap((entry: unknown) => {
      // A bare handler under an event is never executed by Codex; drop ours, leave anything else alone.
      if (!isGroup(entry)) return owned(entry) ? [] : [entry]
      const handlers = entry.hooks.flatMap(handler => {
        if (!owned(handler)) return [handler]
        // Keep an existing entry in its position so Codex hook trust, keyed by position, stays valid.
        const match = wanted.find(hook => !placed.has(hook) && runs(handler, hook.args))
        if (!match) return []
        placed.add(match)
        return [handlerFor(match, binary!)]
      })
      return handlers.length ? [{ ...entry, hooks: handlers }] : []
    })
    for (const hook of wanted) if (!placed.has(hook)) next.push({ hooks: [handlerFor(hook, binary!)] })
    if (next.length) hooks[event] = next
    else delete hooks[event]
  }
  return { ...document, hooks }
}

async function update(options: HookInstallOptions, binary: string | null) {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const hooksPath = join(codexHome, 'hooks.json')
  const original = await readFile(hooksPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  let document: HooksFile
  try { document = original.trim() ? JSON.parse(original) : {} }
  catch { throw new Error(`${hooksPath} 不是有效 JSON；没有覆盖原配置`) }
  const text = JSON.stringify(mergeCoreHooks(document, binary), null, 2) + '\n'
  const changed = JSON.stringify(JSON.parse(text)) !== JSON.stringify(document)
  if (changed) {
    await mkdir(codexHome, { recursive: true })
    if (original) await writeFile(`${hooksPath}.jth-core.bak`, original, 'utf8')
    await writeFile(`${hooksPath}.jth-core.tmp`, text, 'utf8')
    await rename(`${hooksPath}.jth-core.tmp`, hooksPath)
  }
  return { hooks_path: hooksPath, changed }
}

export async function installCoreHooks(options: HookInstallOptions = {}): Promise<{ status: string; hooks_path: string; changed: boolean }> {
  return { status: 'installed', ...await update(options, options.binary ?? defaultBinary()) }
}

export async function uninstallCoreHooks(options: HookInstallOptions = {}): Promise<{ status: string; hooks_path: string; changed: boolean }> {
  return { status: 'uninstalled', ...await update(options, null) }
}
