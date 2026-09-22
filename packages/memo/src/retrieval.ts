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

export function rankMemories<T extends { id: string, content: string, entities: string[], distance: number | null }>(rows: T[], input: z.infer<typeof retrievalInputSchema>) {
  const terms = queryTerms(input.query), phrase = input.query.toLowerCase()
  const candidates = rows.map(entry => {
    const text = `${entry.content}\n${entry.entities.join(' ')}`.toLowerCase()
    const matched = terms.filter(term => text.includes(term))
    const coverage = terms.length ? (text.includes(phrase) ? 1 : matched.length / terms.length) : 0
    const similarity = entry.distance === null ? null : 1 - entry.distance
    return { ...entry, match: { matched_terms: matched, keyword_coverage: coverage, similarity, rank_score: 0 } }
  })
  const keyword = input.mode === 'semantic' ? [] : candidates.filter(entry => entry.match.keyword_coverage >= 0.5)
    .sort((a, b) => b.match.keyword_coverage - a.match.keyword_coverage || a.id.localeCompare(b.id))
  const semantic = input.mode === 'keyword' ? [] : candidates.filter(entry => entry.match.similarity !== null && entry.match.similarity >= input.min_similarity)
    .sort((a, b) => b.match.similarity! - a.match.similarity! || a.id.localeCompare(b.id))
  // Reciprocal rank fusion combines ranks, not incomparable lexical and vector scores.
  for (const ranking of [keyword, semantic]) ranking.forEach((entry, index) => { entry.match.rank_score += 1 / (60 + index + 1) })
  return candidates.filter(entry => entry.match.rank_score > 0)
    .sort((a, b) => b.match.rank_score - a.match.rank_score || b.match.keyword_coverage - a.match.keyword_coverage || a.id.localeCompare(b.id))
    .slice(0, input.limit)
}
