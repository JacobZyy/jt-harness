import { mkdir, readFile, readlink, symlink, unlink, realpath, appendFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import { FlowStore, renderFlowContext } from '@jt-harness/flow'
import { mergeHooks, quote, updateHookConfig } from './install.ts'
import { writeJson, readJson } from './capture.ts'
import { flowEntryMarker } from './flow-entry.ts'

export const flowEvents = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStop'] as const
const contextEvents: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'SubagentStart']
const inputSchema = z.object({ hook_event_name: z.enum(flowEvents), session_id: z.string().min(1), cwd: z.string().min(1), agent_id: z.string().min(1).optional(), observed_at: z.iso.datetime().optional() })

export async function stageFlowEvent(input: unknown, workspace: string) {
  const event = { ...inputSchema.parse(input), observed_at: new Date().toISOString() }
  const path = relative(workspace, await realpath(event.cwd))
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) return null
  const file = resolve(workspace, '.jth/flow-events', `${Date.now()}-${randomUUID()}.json`)
  await writeJson(file, event)
  return { file, event }
}

export async function drainFlowEvents(store: FlowStore) {
  const directory = resolve(store.workspace, '.jth/flow-events')
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const taskIds = new Set<string>()
  let processed = 0
  for (const name of files.filter(name => name.endsWith('.json')).sort()) {
    const file = resolve(directory, name), input = await readJson(file)
    if (!input) continue
    const result = await flowHook(input, store)
    if (result.taskId) taskIds.add(result.taskId)
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
    processed++
  }
  return { processed, taskIds: [...taskIds] }
}

/** Native events are liveness signals. Only the main agent can change semantic task state. */
export async function flowHook(input: unknown, store: FlowStore) {
  const event = inputSchema.parse(input)
  const cwd = await realpath(event.cwd)
  const path = relative(store.workspace, cwd)
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) return { output: {}, taskId: undefined }
  const childEvent = event.hook_event_name === 'SubagentStart' || event.hook_event_name === 'SubagentStop'
  if (childEvent && !event.agent_id) throw new Error('子 Agent Hook 缺少 agent_id')
  const sessionId = childEvent ? event.agent_id! : event.session_id
  const task = await store.observe(sessionId, event.hook_event_name, childEvent ? event.session_id : undefined, event.observed_at)
  if (!contextEvents.includes(event.hook_event_name)) return { output: {}, taskId: undefined }
  const pending = task ? [] : (await store.tasks()).filter(task => task.phase !== 'completed')
  const context = renderFlowContext(store.workspace, sessionId, task, await store.binding(sessionId), pending)
  return { output: { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: context } }, taskId: task?.id }
}

export async function configureFlowHooks(root: string, workspace: string, enabled = true, mode: 'native' | 'legacy' = 'native') {
  const source = resolve(root, 'packages/flow/skills/jth-flow')
  const target = resolve(workspace, '.agents/skills/jth-flow')
  const prior = await readlink(target).catch(error => { if (error.code === 'ENOENT') return null; throw new Error('已有 jth-flow Skill 不是本工具的链接；保留原文件') })
  if (prior && resolve(dirname(target), prior) !== source) throw new Error('已有 jth-flow Skill 指向其他安装；保留原链接')
  if (enabled) {
    await readFile(resolve(source, 'SKILL.md'), 'utf8')
    await mkdir(dirname(target), { recursive: true })
    if (!prior) await symlink(source, target)
    const ignorePath = resolve(workspace, '.gitignore')
    const ignore = await readFile(ignorePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    const missing = ['/.jth/', '/.agents/skills/jth-flow', '/.codex/hooks.json'].filter(line => !ignore.split(/\r?\n/).includes(line))
    if (missing.length) await appendFile(ignorePath, `${ignore.endsWith('\n') || !ignore ? '' : '\n'}${missing.join('\n')}\n`)
  }
  const command = enabled && mode === 'legacy' ? [process.execPath, '--', resolve(root, 'bin/jth.mjs'), 'flow', 'legacy', 'hook', '--workspace', workspace].map(quote).join(' ') : undefined
  const entry = enabled && mode === 'native' ? [process.execPath, '--', resolve(root, 'bin/jth.mjs'), 'flow', 'prompt', '--workspace', workspace].map(quote).join(' ') : undefined
  const hooksPath = resolve(workspace, '.codex/hooks.json')
  await updateHookConfig(hooksPath, resolve(workspace, '.jth/backups'), document => mergeHooks(mergeHooks(document, command, {
    marker: 'jth flow context', events: flowEvents, additionalContextLimit: 6000,
  }), entry, { marker: flowEntryMarker, events: ['UserPromptSubmit'], additionalContextLimit: 512 }))
  if (!enabled && prior) await unlink(target)
  const activation = !enabled ? '任务数据和 Memo Hooks 均保留'
    : mode === 'native' ? '在 Codex /hooks 审阅并信任入口定义；恢复会话后，UserPromptSubmit 注入短 Flow 提示，原生目标与任务列表仍由 Codex 管理'
      : '在 Codex /hooks 审阅并信任历史 Flow 定义'
  return { status: enabled ? 'installed' : 'uninstalled', mode, hooksPath, skill: target, events: command ? flowEvents : entry ? ['UserPromptSubmit'] : [],
    activation,
  }
}
