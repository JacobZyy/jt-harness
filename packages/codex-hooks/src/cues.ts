import { realpath } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import { boundedMemoryContext, sanitizeMemoryText, truncateUnicode, type MemoStorage, type ScopeFilter } from '@jacob-z/jt-harness/memo'
import { codexDirectory, hash, inside, installationPath, readJson, writeJson, type CaptureSettings } from './capture.ts'
import { memoEntryContext } from './instructions.ts'

export const cueMarker = 'jth memo cues'
const eventSchema = z.object({
  hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit']), cwd: z.string().refine(isAbsolute),
  session_id: z.string().min(1).max(200), turn_id: z.string().max(200).optional(),
  agent_id: z.string().optional(), prompt: z.string().optional(),
})
const cueStateSchema = z.object({ pending: z.boolean(), status: z.string() })
type CueOutput = { hookSpecificOutput?: { hookEventName: 'UserPromptSubmit', additionalContext: string } }

/** A session cue latch is delivery metadata, never task or Goal state. */
export async function memoryCues(input: unknown, settings: CaptureSettings, config: { dataDir: string }, storage: MemoStorage): Promise<CueOutput> {
  const event = eventSchema.parse(input)
  if (event.agent_id || !inside(await realpath(settings.workspace), await realpath(event.cwd))) return {}
  const installation = await readJson(installationPath(config, settings.workspace)) as { disabled?: boolean } | undefined
  if (installation?.disabled) return {}
  const path = resolve(codexDirectory(config), 'cues', `${hash(`${settings.workspace}:${event.session_id}`)}.json`)
  if (event.hook_event_name === 'SessionStart') {
    await writeJson(path, { pending: true, status: 'ready', session_id: event.session_id, workspace: settings.workspace })
    return {}
  }
  const prior = await readJson(path)
  const output = (entries: Array<{ id: string, preview: string }> = []): CueOutput => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: boundedMemoryContext({ instructions: memoEntryContext, cues: entries.map(entry => ({
      ...entry, preview: truncateUnicode(sanitizeMemoryText(entry.preview), 140), next: `jth memo read ${entry.id} --level evidence`,
    })) }, 1600),
  } })
  if (prior && !cueStateSchema.parse(prior).pending) return output()
  const query = [...(event.prompt ?? '').trim()].slice(0, 2000).join('')
  if (!query) return output()
  const receipt = { pending: false, session_id: event.session_id, turn_id: event.turn_id, workspace: settings.workspace,
    query_hash: hash(query), emitted_at: new Date().toISOString() }
  const scopes: ScopeFilter[] = [
    { kind: 'project', project_ids: settings.scope.project_ids },
    ...(settings.scope.business_ids.length ? [{ kind: 'business' as const, business_ids: settings.scope.business_ids }] : []),
    { kind: 'user' },
  ]
  try {
    const results = await Promise.all(scopes.map(scope => storage.retrieve({ query, scope, mode: 'keyword', limit: 3 })))
    const entries = [...new Map(results.flatMap(result => result.entries).map(entry => [entry.id, entry])).values()]
      .sort((a, b) => b.match.rank_score - a.match.rank_score || a.id.localeCompare(b.id)).slice(0, 3)
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
