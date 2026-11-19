import { realpath } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import { boundedMemoryContext, compareMatchedSubjects, sanitizeMemoryText, truncateUnicode, type MemoStorage, type ScopeFilter } from '@jacob-z/jt-harness/memo'
import { codexDirectory, hash, inside, installationPath, userInstallationPath, readJson, writeJson, type CaptureSettings } from './capture.ts'
import { memoEntryContext } from './instructions.ts'

export const cueMarker = 'jth memo cues'
const eventSchema = z.object({
  hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit']), cwd: z.string().refine(isAbsolute),
  session_id: z.string().min(1).max(200), turn_id: z.string().max(200).optional(),
  agent_id: z.string().optional(), prompt: z.string().optional(),
})
const cueStateSchema = z.object({ pending: z.boolean(), status: z.string(), query_hash: z.string().optional() })
type CueOutput = { hookSpecificOutput?: { hookEventName: 'UserPromptSubmit', additionalContext: string } }

/** An explicit work item or document title can identify the subject even in a long question. */
function requirementReference(prompt: string) {
  const ids = new Set(prompt.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])
  const numbered = /(?:需求|工单|故事|\bissue|\bticket|\bstory)\s*(?:编号|号码|号|ID)?\s*[:：#]?\s*(\d+)\b/gi
  const linked = /\/(?:stories|story|issues?|workitems?|requirements?)\/(?:detail\/)?(\d+)\b/gi
  for (const pattern of [numbered, linked]) {
    for (const match of prompt.matchAll(pattern)) ids.add(match[1])
  }
  if (ids.size) return ids.size === 1 ? [...ids][0] : undefined
  const titles = new Set([...prompt.matchAll(/《([^《》\n]+)》/g)].map(match => match[1].trim()).filter(Boolean))
  return titles.size === 1 ? [...titles][0] : undefined
}

/** A session cue latch is delivery metadata, never task or Goal state. */
export async function memoryCues(input: unknown, settings: CaptureSettings, config: { dataDir: string }, storage: MemoStorage): Promise<CueOutput> {
  const event = eventSchema.parse(input)
  if (event.agent_id || (!settings.workspaces && !inside(await realpath(settings.workspace), await realpath(event.cwd)))) return {}
  const installation = await readJson(settings.workspaces ? userInstallationPath(config, settings.codex_home) : installationPath(config, settings.workspace)) as { disabled?: boolean } | undefined
  if (installation?.disabled) return {}
  const path = resolve(codexDirectory(config), 'cues', `${hash(`${settings.workspace}:${event.session_id}`)}.json`)
  if (event.hook_event_name === 'SessionStart') {
    await writeJson(path, { pending: true, status: 'ready', session_id: event.session_id, workspace: settings.workspace })
    return {}
  }
  const saved = await readJson(path)
  const prior = saved ? cueStateSchema.parse(saved) : undefined
  const output = (entries: Array<{ id: string, preview: string }> = []): CueOutput => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: boundedMemoryContext({ instructions: memoEntryContext,
      ...(settings.workspaces ? { workspace_routing: { primary: settings.workspaces[0].path, workspaces: settings.workspaces,
        instruction: 'project 声明不写 workspaces 时归主目录；其他目录须明确填写绑定根目录绝对路径。共同结论在同一条 items 中选择多个目录。不要从工具路径猜目录。' } } : {}),
      cues: entries.map(entry => ({
      ...entry, preview: truncateUnicode(sanitizeMemoryText(entry.preview), 140), next: `jth memo read ${entry.id} --level evidence`,
    })) }, settings.workspaces ? 2400 : 1600),
  } })
  const prompt = [...(event.prompt ?? '').trim()].slice(0, 2000).join('')
  if (!prompt) return output()
  const reference = requirementReference(prompt)
  const query = reference ?? prompt
  const queryHash = hash(query)
  const followup = prior?.pending === false
  const subjectOnly = followup && !reference
  if (subjectOnly && !/上次|之前|继续|接着|待办|缺口|还缺|进展|交付|接入情况|\b(?:continue|resume|backlog|status|gaps?|pending)\b/i.test(prompt)) return output()
  if (followup && prior.query_hash === queryHash && prior.status !== 'unavailable') return output()
  const receipt = { pending: false, session_id: event.session_id, turn_id: event.turn_id, workspace: settings.workspace,
    query_hash: queryHash, emitted_at: new Date().toISOString() }
  const scopes: ScopeFilter[] = [
    { kind: 'project', project_ids: settings.scope.project_ids },
    ...(settings.scope.business_ids.length ? [{ kind: 'business' as const, business_ids: settings.scope.business_ids }] : []),
    { kind: 'user' },
  ]
  try {
    const lookup = (text: string) => Promise.all(scopes.map(scope => storage.retrieve({ query: text, scope, mode: 'keyword', limit: 3 })))
    let results = await lookup(query)
    if (!followup && query !== prompt && results.every(result => !result.entries.length)) {
      // Earlier memories can describe the feature without including its work item number.
      results = await lookup(prompt)
    }
    const entries = [...new Map(results.flatMap(result => result.entries).map(entry => [entry.id, entry])).values()]
      .filter(entry => !subjectOnly || entry.match.matched_subject)
      .sort((a, b) => compareMatchedSubjects(a.match, b.match)
        || b.match.rank_score - a.match.rank_score || a.id.localeCompare(b.id)).slice(0, 3)
    const shown = [], cues: Array<{ id: string, preview: string }> = []
    for (const entry of entries) {
      const cue = { id: entry.id, preview: truncateUnicode(sanitizeMemoryText(entry.content), 140) }
      if (JSON.stringify(cues.concat(cue)).length > 1200) break
      shown.push(entry); cues.push(cue)
    }
    const cueOutput = output(cues)
    const emittedCues = JSON.parse(cueOutput.hookSpecificOutput!.additionalContext).cues as Array<{ id: string }>
    const emittedIds = new Set(emittedCues.map(cue => cue.id))
    await writeJson(path, { ...receipt, status: emittedIds.size ? 'shown' : 'no-match', entries: shown.filter(entry => emittedIds.has(entry.id)).map(entry => ({ id: entry.id, state: entry.state, match: entry.match })) })
    return cueOutput
  } catch (error) {
    await writeJson(path, { ...receipt, status: 'unavailable', error: error instanceof Error ? error.name : 'Error' })
    return output()
  }
}
