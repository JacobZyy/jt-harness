import { mkdir, readFile, readlink, symlink, unlink, realpath, appendFile } from 'node:fs/promises'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import { FlowStore, renderFlowContext } from '@jt-harness/flow'
import { mergeHooks, quote, updateHookConfig } from './install.ts'

export const flowEvents = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStop'] as const
const contextEvents: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'SubagentStart']
const inputSchema = z.object({ hook_event_name: z.enum(flowEvents), session_id: z.string().min(1), cwd: z.string().min(1), agent_id: z.string().min(1).optional() })

/** Native events are liveness signals. Only the main agent can change semantic task state. */
export async function flowHook(input: unknown, store: FlowStore) {
  const event = inputSchema.parse(input)
  const cwd = await realpath(event.cwd)
  const path = relative(store.workspace, cwd)
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) return { output: {}, taskId: undefined }
  const childEvent = event.hook_event_name === 'SubagentStart' || event.hook_event_name === 'SubagentStop'
  if (childEvent && !event.agent_id) throw new Error('子 Agent Hook 缺少 agent_id')
  const sessionId = childEvent ? event.agent_id! : event.session_id
  const task = store.observe(sessionId, event.hook_event_name, childEvent ? event.session_id : undefined)
  if (!contextEvents.includes(event.hook_event_name)) return { output: {}, taskId: undefined }
  const pending = task ? [] : store.tasks().filter(task => task.phase !== 'completed')
  const context = renderFlowContext(store.workspace, sessionId, task, store.binding(sessionId), pending)
  return { output: { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: context } }, taskId: task?.id }
}

export async function configureFlowHooks(root: string, workspace: string, enabled = true) {
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
  const command = enabled ? [process.execPath, resolve(root, 'bin/jth.mjs'), 'flow', 'hook', '--workspace', workspace].map(quote).join(' ') : undefined
  const hooksPath = resolve(workspace, '.codex/hooks.json')
  await updateHookConfig(hooksPath, resolve(workspace, '.jth/backups'), document => mergeHooks(document, command, {
    marker: 'jth flow context', events: flowEvents, additionalContextLimit: 6000,
  }))
  if (!enabled && prior) await unlink(target)
  return { status: enabled ? 'installed' : 'uninstalled', hooksPath, skill: target, events: enabled ? flowEvents : [],
    activation: enabled ? '在 Codex /hooks 审阅并信任新增定义；恢复会话后检查 flow status 的绑定与 lastEvent' : '任务数据和 Memo Hooks 均保留',
  }
}
