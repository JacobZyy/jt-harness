import { createHash } from 'node:crypto'
import { z } from 'zod'
import { extractionSchema, parseExtraction, submissionSchema, timestampSchema } from '../contracts.ts'
import type { Extraction } from '../contracts.ts'
import { relationSchema } from './relations.ts'
import { intakeIssueSchema } from '../intake.ts'
import type { IntakeIssue } from '../intake.ts'

const text = z.string().min(1).max(500).refine(value => value.trim().length > 0)
const ids = z.array(text).min(1).refine(values => new Set(values).size === values.length)

export const usageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(), cache_hit_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(), requests: z.number().int().positive(),
})
export const runSchema = z.strictObject({ session_id: text, provider: text, model: text, reasoningEffort: text.optional(),
  usage: usageSchema.optional(), input_bytes: z.number().int().nonnegative().optional(), system_prompt_bytes: z.number().int().nonnegative().optional(), source_bytes: z.number().int().nonnegative().optional(),
})
export type AgentRun = z.infer<typeof runSchema>
export const storeInputSchema = z.strictObject({
  submission: submissionSchema,
  extraction: extractionSchema,
  run: runSchema,
  intake_issues: z.array(intakeIssueSchema).default([]),
}).transform(input => ({ ...input, extraction: parseExtraction(JSON.stringify(input.extraction), input.submission) }))

export const spaceSchema = z.strictObject({
  id: text,
  provider: text,
  model: text,
  dimensions: z.number().int().min(1).max(16_000),
  input_version: z.literal('content-v1'),
})

// pgvector stores float32. Validate the actual stored values, including
// overflow and vectors that would become all zero after float32 conversion.
export const vectorSchema = z.array(z.number().finite()).min(1).max(16_000)
  .transform(values => values.map(Math.fround))
  .refine(values => values.every(Number.isFinite), '向量超出 float32 范围')
  .refine(values => values.some(value => value !== 0), '余弦检索不能使用零向量')

export const indexInputSchema = z.strictObject({
  submission_id: text,
  space: spaceSchema,
  relations: z.array(relationSchema).max(160).default([]),
  reconciliation_run: runSchema.optional(),
  intake_issues: z.array(intakeIssueSchema).default([]),
  expected_versions: z.record(z.uuid(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  embeddings: z.array(z.strictObject({
    entry_id: z.uuid(),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    vector: vectorSchema,
  })).max(160),
}).superRefine((input, context) => {
  if (new Set(input.embeddings.map(item => item.entry_id)).size !== input.embeddings.length) {
    context.addIssue({ code: 'custom', path: ['embeddings'], message: 'entry_id 不能重复' })
  }
  if (input.embeddings.some(item => item.vector.length !== input.space.dimensions)) {
    context.addIssue({ code: 'custom', path: ['embeddings'], message: '向量维度与空间声明不一致' })
  }
})

export const scopeFilterSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), project_ids: ids }),
  z.strictObject({ kind: z.literal('business'), business_ids: ids }),
  z.strictObject({ kind: z.literal('current_task'), source_session_id: text }),
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('unspecified'), submission_id: text }),
])

export const searchInputSchema = z.strictObject({
  space_id: text,
  vector: vectorSchema,
  scope: scopeFilterSchema,
  include_proposals: z.boolean().default(false),
  include_history: z.boolean().default(false),
  include_candidates: z.boolean().default(false),
  include_archived: z.boolean().default(false),
  as_of: timestampSchema.optional(),
  limit: z.number().int().min(1).max(50).default(10),
})

export type StoreInput = z.input<typeof storeInputSchema>
export type EmbeddingSpace = z.infer<typeof spaceSchema>
export type IndexInput = z.input<typeof indexInputSchema>
export type SearchInput = z.input<typeof searchInputSchema>
export type ScopeFilter = z.infer<typeof scopeFilterSchema>

export interface MemoryEntry {
  id: string
  submission_id: string
  position: number
  collection: 'memories' | 'proposals'
  content: string
  content_sha256: string
  basis: Extraction['memories'][number]['basis'] | Extraction['proposals'][number]['basis']
  scope: Extraction['memories'][number]['scope']
  source_message_ids: string[]
  project_ids: string[]
  business_ids: string[]
  source_session_id: string
  entities: string[]
  source_occurred_at: Date | null
  valid_from: Date | null
  valid_until: Date | null
}

export interface StoreReceipt {
  status: 'stored'
  submission_id: string
  entry_ids: string[]
  revision_evidence_count: number
  stored_at: string
}

export interface IndexReceipt {
  status: 'indexed' | 'noop' | 'review_required' | 'partial'
  id: string
  submission_id: string
  space_id: string
  entry_count: number
  relation_count: number
  indexed_at: string
  publication_notes: PublicationNote[]
  intake_issues: IntakeIssue[]
}

export interface PublicationNote {
  kind: 'review_required'
  reason: string
  previous_entry_id: string
  current_entry_id: string | null
}

export class MemoStorageError extends Error {
  readonly code: 'NOT_FOUND' | 'SUBMISSION_CONFLICT' | 'SPACE_CONFLICT' | 'INDEX_CONFLICT' | 'INVALID_EMBEDDINGS' | 'SCHEMA_NOT_READY' | 'MISSING_CREDENTIAL' | 'EMBEDDING_NOT_CONFIGURED' | 'EMBEDDING_FAILED' | 'VERSION_CONFLICT'

  constructor(code: MemoStorageError['code'], message: string) {
    super(message)
    this.name = 'MemoStorageError'
    this.code = code
  }
}

/** Hash exact UTF-8 input; the embedding input in content-v1 is entry.content. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
