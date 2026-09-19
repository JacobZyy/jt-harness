import type { Submission } from '../contracts.ts'
import type { MemoryEntry } from '../storage/contract.ts'
import type { StateEntry } from '../storage/relations.ts'
import { comparisonLimits } from '../storage/relations.ts'
import type { ComparisonInput } from './reconcile.ts'

export const materialLimits = { toolCharacters: 1200, totalToolCharacters: 8000 } as const
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

function toolMetadata(text: string) {
  let value
  try { value = JSON.parse(text) } catch { return {} }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(['tool', 'command', 'status', 'exit_code', 'isError'].flatMap(key => {
    const item = value[key]
    if (typeof item === 'string') return [[key, item.slice(0, 200)]]
    if (typeof item === 'number' || typeof item === 'boolean' || item === null) return [[key, item]]
    return []
  }))
}

/** Only the model view is reduced. IDs, roles and immutable stored source remain unchanged. */
export function projectMessages(messages: Submission['messages']) {
  let remaining: number = materialLimits.totalToolCharacters
  return messages.toReversed().map(message => {
    const { role, text, message_id, occurred_at, context_only } = message
    const metadata = { message_id, ...(occurred_at ? { occurred_at } : {}), ...(context_only ? { context_only } : {}) }
    if (role !== 'tool') return { role, text, ...metadata }
    const characters = Array.from(text)
    const allowed = Math.min(remaining, materialLimits.toolCharacters)
    remaining -= Math.min(allowed, characters.length)
    if (characters.length <= allowed) return { role, text, ...metadata }
    // ponytail: head/tail excerpts bound log cost; facts found only in the middle need targeted evidence retrieval before expanding this budget.
    const head = Math.ceil(allowed / 2), tail = Math.floor(allowed / 2)
    const excerpts = [characters.slice(0, head).join(''), tail ? characters.slice(-tail).join('') : ''].filter(Boolean)
    return { role, excerpts, tool_metadata: toolMetadata(text), omitted_characters: characters.length - allowed, ...metadata }
  }).reverse()
}

export function extractionMaterial(submission: Submission) {
  return {
    scope: submission.scope,
    messages: projectMessages(submission.messages),
    // Volatile transport metadata follows semantic content; log paths/offsets are not model inputs.
    source: { provider: submission.source.provider, session_id: submission.source.session_id,
      codex: { parent_session_id: submission.source.parent_session_id ?? submission.source.codex?.parent_session_id } },
    submission_id: submission.submission_id,
  }
}

function entryMaterial(entry: MemoryEntry | StateEntry) {
  return {
    content: entry.content, scope: entry.scope, entities: entry.entities,
    source_occurred_at: entry.source_occurred_at, valid_from: entry.valid_from, valid_until: entry.valid_until,
    project_ids: entry.project_ids, business_ids: entry.business_ids, source_session_id: entry.source_session_id,
    ...('claim_status' in entry ? { claim_status: entry.claim_status, state: entry.state, received_at: entry.received_at } : {}),
    id: entry.id,
  }
}

export function comparisonMaterial(input: ComparisonInput) {
  let remaining: number = comparisonLimits.maxBytes
  const previous: ReturnType<typeof entryMaterial>[] = []
  // Retrieval supplies relevance order. Do not clip a fact or invent a shortened meaning.
  for (const entry of input.previous_entries) {
    const candidate = entryMaterial(entry), size = jsonBytes(candidate)
    if (previous.length === comparisonLimits.maxEntries) break
    if (size > remaining) continue
    previous.push(candidate)
    remaining -= size
  }
  const selected = new Set(previous.map(entry => entry.id))
  const cited = new Set([
    ...input.current_entries.flatMap(entry => entry.source_message_ids),
    ...input.extraction.revisions.flatMap(revision => revision.source_message_ids),
  ])
  const material = {
    scope: input.submission.scope,
    previous_entries: previous.sort((a, b) => a.id.localeCompare(b.id)),
    previous_conflicts: input.previous_conflicts.filter(conflict => selected.has(conflict.previous_entry_id) || (conflict.current_entry_id && selected.has(conflict.current_entry_id))).toSorted((a, b) => a.id.localeCompare(b.id)),
    current_entries: input.current_entries.map(entry => ({ ...entryMaterial(entry), basis: entry.basis, source_message_ids: entry.source_message_ids })),
    extraction: { revisions: input.extraction.revisions },
    messages: projectMessages(input.submission.messages.filter(message => cited.has(message.message_id))),
    selection: { previous_candidates: input.previous_entries.length, previous_selected: previous.length },
    source_session_id: input.submission.source.session_id,
    submission_id: input.submission.submission_id,
  }
  return material
}
