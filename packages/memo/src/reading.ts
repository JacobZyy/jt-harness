import type { MemoStorage } from './storage/storage.ts'
import { z } from 'zod'
import { queryTerms } from './retrieval.ts'

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

/** Canonical source text is untouched; previews are explicitly labelled and expandable. */
export function readMemory(entry: Awaited<ReturnType<MemoStorage['getEntry']>>, input = 'full') {
  const level = readLevelSchema.parse(input)
  if (level === 'full') return entry
  const { id, content, basis, scope, project_ids, business_ids, state, claim_status, archived, version, source_occurred_at, valid_from, valid_until } = entry
  const summary = { id, content, basis, scope, project_ids, business_ids, state, claim_status, archived, version, source_occurred_at, valid_from, valid_until,
    level, next: `jth memo read ${id} --level ${level === 'summary' ? 'evidence' : 'full'}` }
  if (level === 'summary') return summary
  return { ...summary,
    messages: entry.messages.slice(0, 6).map(({ message_id, role, text, occurred_at }) => ({ message_id, role, occurred_at, ...excerpt(text, 600, content) })),
    messages_truncated: entry.messages.length > 6,
    relations: entry.relations.slice(0, 6).map(relation => ({ id: relation.id, kind: relation.kind,
      previous_entry_id: relation.previous_entry_id, current_entry_id: relation.current_entry_id,
      unresolved: relation.unresolved, needs_review: relation.needs_review,
      evidence: excerpt(relation.evidence_quote, 400) })),
    relations_truncated: entry.relations_truncated || entry.relations.length > 6,
    source: entry.source,
    notice: 'preview 是来源片段，不是完整证据；更正、冲突裁决或条件不全时按 next 查看完整来源。',
  }
}
