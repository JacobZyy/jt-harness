import { z } from 'zod'
import { scopeFilterSchema, vectorSchema } from './storage/contract.ts'
import { timestampSchema } from './contracts.ts'

export const retrievalInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(2000), scope: scopeFilterSchema,
  mode: z.enum(['hybrid', 'keyword', 'semantic']).default('hybrid'),
  space_id: z.string().min(1).optional(), vector: vectorSchema.optional(),
  min_similarity: z.number().min(0).max(1).default(0.6),
  limit: z.number().int().min(1).max(50).default(3),
  include_candidates: z.boolean().default(false), include_history: z.boolean().default(false),
  include_archived: z.boolean().default(false), as_of: timestampSchema.optional(),
}).refine(input => input.mode === 'keyword' || Boolean(input.space_id && input.vector), '语义及混合检索需要查询向量与向量空间')
export type RetrievalInput = z.input<typeof retrievalInputSchema>

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
export function queryTerms(query: string) {
  return [...new Set([
    ...(query.match(/[a-z_$][\w$]*(?:[./:-][\w$-]+)+/gi) ?? []),
    ...[...segmenter.segment(query)].filter(part => part.isWordLike && [...part.segment].length >= 2).map(part => part.segment),
  ].map(term => term.toLowerCase()))]
}

type RetrievalMetadata = {
  claim_status?: 'candidate' | 'asserted' | 'observed' | 'verified' | 'rejected'
  scope?: string
  project_ids?: string[]
  business_ids?: string[]
  source_session_id?: string
  submission_id?: string
  source_occurred_at?: Date | string | null
  valid_from?: Date | string | null
  valid_until?: Date | string | null
}

type RetrievalRow = { id: string, content: string, entities: string[], distance: number | null } & RetrievalMetadata

const qualificationRank: Record<NonNullable<RetrievalMetadata['claim_status']>, number> = {
  verified: 3, asserted: 2, observed: 1, candidate: 0, rejected: -1,
}

function timestamp(value: Date | string | null | undefined) {
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function normalizedTime(value: Date | string | null | undefined) {
  const parsed = timestamp(value)
  return parsed === null ? String(value ?? '') : new Date(parsed).toISOString()
}

function duplicateKey(entry: RetrievalRow) {
  const scope = entry.scope === 'project'
    ? [entry.scope, [...(entry.project_ids ?? [])].sort()]
    : entry.scope === 'business'
      ? [entry.scope, [...(entry.business_ids ?? [])].sort()]
      : entry.scope === 'current_task'
        ? [entry.scope, entry.source_session_id ?? '']
        : entry.scope === 'unspecified'
          ? [entry.scope, entry.submission_id ?? '']
          : [entry.scope ?? '']
  return JSON.stringify([
    entry.content, scope,
    normalizedTime(entry.valid_from), normalizedTime(entry.valid_until),
  ])
}

function compareSourceDate(a: RetrievalRow, b: RetrievalRow) {
  const left = timestamp(a.source_occurred_at), right = timestamp(b.source_occurred_at)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}

function compareQualification(a: RetrievalRow, b: RetrievalRow) {
  return (qualificationRank[b.claim_status ?? 'candidate'] ?? 0) - (qualificationRank[a.claim_status ?? 'candidate'] ?? 0)
}

function compareLexical(a: RetrievalRow & { match: { phrase_match: boolean, keyword_coverage: number } }, b: RetrievalRow & { match: { phrase_match: boolean, keyword_coverage: number } }) {
  return Number(b.match.phrase_match) - Number(a.match.phrase_match)
    || b.match.keyword_coverage - a.match.keyword_coverage
    || compareQualification(a, b)
    || compareSourceDate(a, b)
    || a.id.localeCompare(b.id)
}

export function rankMemories<T extends RetrievalRow>(rows: T[], input: z.infer<typeof retrievalInputSchema>) {
  const terms = queryTerms(input.query), phrase = input.query.toLowerCase()
  const candidates = rows.map(entry => {
    const text = `${entry.content}\n${entry.entities.join(' ')}`.toLowerCase()
    const matched = terms.filter(term => text.includes(term))
    const phraseMatch = entry.content.toLowerCase().includes(phrase)
    const coverage = terms.length ? matched.length / terms.length : 0
    const similarity = entry.distance === null ? null : 1 - entry.distance
    return { ...entry, match: { matched_terms: matched, phrase_match: phraseMatch, keyword_coverage: coverage, similarity, rank_score: 0, duplicate_ids: [] as string[] } }
  })
  const keyword = input.mode === 'semantic' ? [] : candidates.filter(entry => entry.match.keyword_coverage >= 0.5)
    .sort(compareLexical)
  const semantic = input.mode === 'keyword' ? [] : candidates.filter(entry => entry.match.similarity !== null && entry.match.similarity >= input.min_similarity)
    .sort((a, b) => b.match.similarity! - a.match.similarity! || compareLexical(a, b))
  // Reciprocal rank fusion combines ranks, not incomparable lexical and vector scores.
  for (const ranking of [keyword, semantic]) ranking.forEach((entry, index) => { entry.match.rank_score += 1 / (60 + index + 1) })
  const ranked = candidates.filter(entry => entry.match.rank_score > 0)
    .sort((a, b) => b.match.rank_score - a.match.rank_score || compareLexical(a, b))
  const groups = new Map<string, typeof ranked>()
  for (const entry of ranked) groups.set(duplicateKey(entry), [...(groups.get(duplicateKey(entry)) ?? []), entry])
  return [...groups.values()].map(group => {
    const primary = [...group].sort((a, b) => compareQualification(a, b) || b.match.rank_score - a.match.rank_score || compareLexical(a, b))[0]
    primary.match.duplicate_ids = group.filter(entry => entry.id !== primary.id).map(entry => entry.id).sort()
    return primary
  }).sort((a, b) => b.match.rank_score - a.match.rank_score || compareLexical(a, b)).slice(0, input.limit)
}
