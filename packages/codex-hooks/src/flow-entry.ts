import { access, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { homedir } from 'node:os'
import { flowEntryContext } from '@jacob-z/jt-harness/flow'
import { codexDirectory, hash, writeJson } from './capture.ts'

export const flowEntryMarker = 'jth flow entry'
export const flowEntryReceiptPath = (workspace: string, config?: { dataDir: string }) => config
  ? resolve(codexDirectory(config), 'flow-entry', `${hash(workspace)}.json`)
  : resolve(workspace, '.jth/flow-entry.json')
const inputSchema = z.object({
  hook_event_name: z.string(), cwd: z.string().refine(isAbsolute),
  session_id: z.string().min(1).max(200), turn_id: z.string().max(200).optional(),
})

/** Only emit the entry reminder. Never read the prompt, transcript, Memo, or historical task state. */
export async function flowEntryHook(input: unknown, workspace: string, options?: { dataDir: string, userHome?: string }) {
  const event = inputSchema.parse(input)
  if (event.hook_event_name !== 'UserPromptSubmit') return {}
  const root = await realpath(workspace), cwd = await realpath(event.cwd)
  const path = relative(root, cwd)
  if (!options && (path === '..' || path.startsWith('../') || isAbsolute(path))) return {}
  const skill = resolve(options ? options.userHome ?? homedir() : root, '.agents/skills/jth-flow/SKILL.md')
  await access(skill)
  const context = flowEntryContext()
  // Keep only the latest emission metadata. A receipt proves hook output, not model compliance.
  await writeJson(flowEntryReceiptPath(root, options), {
    event: event.hook_event_name, session_id: event.session_id, turn_id: event.turn_id,
    cwd, emitted_at: new Date().toISOString(), context_chars: [...context].length,
  }).catch((error: NodeJS.ErrnoException) => {
    process.stderr.write(`JTH Flow 触发记录写入失败：${error.code ?? 'unknown'}\n`)
  })
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }
}
