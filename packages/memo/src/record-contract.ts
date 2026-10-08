import { z } from 'zod'
import { extractionSchema, submissionSchema } from './contracts.ts'
import { relationSchema } from './storage/relations.ts'
import { runSchema, sha256 } from './storage/contract.ts'

const { current_entry_id, ...relationFields } = relationSchema.shape
export const recordDraftSchema = z.strictObject({
  evidence_id: z.string().regex(/^evidence-[0-9a-f]{64}$/),
  extraction: extractionSchema,
  changes: z.array(z.strictObject({ ...relationFields,
    current_memory_index: z.number().int().nonnegative().nullable(),
    expected_version: z.string().regex(/^[0-9a-f]{64}$/),
  })).max(160).default([]),
  used: z.array(z.strictObject({ entry_id: z.uuid(), read_version: z.string().regex(/^[0-9a-f]{64}$/) })).max(10).optional(),
  derivations: z.array(z.strictObject({
    proposal_index: z.number().int().nonnegative(),
    sources: z.array(z.strictObject({ entry_id: z.uuid(), read_version: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(10),
  })).max(3).optional(),
}).superRefine((value, context) => {
  const indexes = new Set<number>()
  for (const derivation of value.derivations ?? []) {
    if (derivation.proposal_index >= value.extraction.proposals.length || indexes.has(derivation.proposal_index)) {
      context.addIssue({ code: 'custom', message: '派生摘要必须引用唯一且存在的候选建议' })
    }
    indexes.add(derivation.proposal_index)
    if (new Set(derivation.sources.map(source => source.entry_id)).size !== derivation.sources.length) {
      context.addIssue({ code: 'custom', message: '派生来源 ID 不得重复' })
    }
  }
})
export type RecordDraft = z.input<typeof recordDraftSchema>
export const evidenceSchema = z.strictObject({
  id: z.string().regex(/^evidence-[0-9a-f]{64}$/),
  submission: submissionSchema,
  run: runSchema,
})
export type Evidence = z.infer<typeof evidenceSchema>
export const recordId = (draft: RecordDraft) => `record-${sha256(JSON.stringify(recordDraftSchema.parse(draft)))}`
