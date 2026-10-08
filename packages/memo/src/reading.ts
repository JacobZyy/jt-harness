import type { MemoStorage } from './storage/storage.ts'
import { z } from 'zod'
import { queryTerms } from './retrieval.ts'
import { sanitizeMemoryValue, unicodeLength, truncateUnicode, withMemoryContext } from './memory-context.ts'

export const readLevelSchema = z.enum(['summary', 'evidence', 'full'])

const excerpt = (text: string, limit: number, focus = '') => {
  const characters = [...text]
  const match = focus ? text.indexOf(focus) : -1
  let anchor = match
  if (match < 0 && focus) {
    const terms = queryTerms(focus).slice(0, 32), lower = text.toLowerCase()
    let best = 0
    for (const term of terms) {
      let position = lower.indexOf(term)
      while (position >= 0) {
        const window = lower.slice(Math.max(0, position - 120), position + limit - 120)
        const score = terms.filter(candidate => window.includes(candidate)).length
        if (score > best) { best = score; anchor = position }
        position = lower.indexOf(term, position + term.length)
      }
    }
  }
  const start = anchor < 0 ? 0 : Math.max(0, [...text.slice(0, anchor)].length - 120)
  return { preview: characters.slice(start, start + limit).join(''), start, characters: characters.length, truncated: start > 0 || characters.length > start + limit }
}

const evidenceBudget = 12_000
const encode = (value: unknown) => JSON.stringify(value, null, 2)
type ReadEntry = Awaited<ReturnType<MemoStorage['getEntry']>>
type EvidenceMessage = { message_id: string, role: ReadEntry['messages'][number]['role'], occurred_at?: string, preview: string, start: number, characters: number, truncated: boolean }
type EvidenceResult = Record<string, unknown> & { messages: EvidenceMessage[], messages_truncated: boolean }

function compactSource(entry: ReadEntry) {
  const source = entry.source
  return {
    provider: source.provider,
    session_id: source.session_id,
    parent_session_id: source.parent_session_id,
    codex: source.codex,
    message_ids: entry.source_message_ids,
  }
}

function budgetEvidence<T extends Record<string, unknown>>(value: T, next: string) {
  let output = withMemoryContext({ ...sanitizeMemoryValue(value), truncated: false, dropped_messages: 0, dropped_relations: 0 }, 'cli') as T & Record<string, unknown>
  const size = () => unicodeLength(encode(output))
  const originalMessageIds = Array.isArray(output.messages) ? output.messages.flatMap(message => message && typeof message === 'object' && typeof (message as Record<string, unknown>).message_id === 'string' ? [(message as Record<string, unknown>).message_id] : []) : []
  while (size() > evidenceBudget) {
    const relations = Array.isArray(output.relations) ? output.relations : []
    if (relations.length) { relations.pop(); output = { ...output, relations, relations_truncated: true, dropped_relations: Number(output.dropped_relations) + 1, truncated: true }; continue }
    const messages = Array.isArray(output.messages) ? output.messages : []
    if (messages.length > 1) { messages.pop(); output = { ...output, messages, messages_truncated: true, dropped_messages: Number(output.dropped_messages) + 1, truncated: true }; continue }
    const content = typeof output.content === 'string' ? output.content : ''
    if (content.length) {
      output = { ...output, content_truncated: true, truncated: true }
      output = { ...output, content: truncateUnicode(content, Math.max(0, unicodeLength(content) - (size() - evidenceBudget))) }
      continue
    }
    const source = output.source && typeof output.source === 'object' ? output.source as Record<string, unknown> : {}
    const keptMessages = Array.isArray(output.messages) ? output.messages.slice(0, 1) : []
    const messageIds = originalMessageIds.slice(0, 6)
    output = {
      id: output.id, version: output.version, level: output.level, next,
      memory_context: output.memory_context, notice: '证据输出已压缩；按 next 查看完整来源。', derivation: output.derivation,
      source: { provider: source.provider, session_id: source.session_id, message_ids: messageIds }, messages: keptMessages,
      messages_truncated: true, relations: [], relations_truncated: true, content: '', content_truncated: true,
      truncated: true, metadata_truncated: true, dropped_messages: output.dropped_messages, dropped_relations: output.dropped_relations,
    } as unknown as T & Record<string, unknown>
    if (size() > evidenceBudget) throw new RangeError(`memory evidence exceeds output budget: ${evidenceBudget}`)
    break
  }
  return output as T & { memory_context: unknown, notice: string, next: string, truncated?: boolean }
}

/** Canonical source text is untouched; previews are explicitly labelled and expandable. */
export function readMemory(entry: ReadEntry, input: 'full'): ReadEntry
export function readMemory(entry: ReadEntry, input: 'summary'): Record<string, unknown>
export function readMemory(entry: ReadEntry, input: 'evidence'): EvidenceResult
export function readMemory(entry: ReadEntry, input?: string): ReadEntry | Record<string, unknown> | EvidenceResult
export function readMemory(entry: ReadEntry, input = 'full'): ReadEntry | Record<string, unknown> | EvidenceResult {
  const level = readLevelSchema.parse(input)
  if (level === 'full') return entry
  const { id, content, basis, scope, project_ids, business_ids, state, claim_status, archived, version, source_occurred_at, valid_from, valid_until } = entry
  const next = `jth memo read ${id} --level ${level === 'summary' ? 'evidence' : 'full'}`
  const summary = { id, content, basis, scope, project_ids, business_ids, state, claim_status, archived, version, source_occurred_at, valid_from, valid_until,
    level, next,
    ...(entry.derivation ? {
      derivation: {
        stale: entry.derivation.stale,
        sources: entry.derivation.sources.map(source => ({ ...source, next: `jth memo read ${source.entry_id} --level full` })),
      },
    } : {}) }
  if (level === 'summary') return summary
  return budgetEvidence({ ...summary,
    messages: entry.messages.slice(0, 6).map(({ message_id, role, text, occurred_at }) => ({ message_id, role, occurred_at, ...excerpt(text, 600, content) })),
    messages_truncated: entry.messages.length > 6,
    relations: entry.relations.slice(0, 6).map(relation => ({ id: relation.id, kind: relation.kind,
      previous_entry_id: relation.previous_entry_id, current_entry_id: relation.current_entry_id,
      unresolved: relation.unresolved, needs_review: relation.needs_review,
      evidence: excerpt(relation.evidence_quote, 400) })),
    relations_truncated: entry.relations_truncated || entry.relations.length > 6,
    source: compactSource(entry),
    notice: 'preview 是来源片段，不是完整证据；更正、冲突裁决或条件不全时按 next 查看完整来源。',
  }, next) as EvidenceResult
}
