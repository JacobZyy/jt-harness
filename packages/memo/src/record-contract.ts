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
})
export type RecordDraft = z.input<typeof recordDraftSchema>
export const evidenceSchema = z.strictObject({
  id: z.string().regex(/^evidence-[0-9a-f]{64}$/),
  submission: submissionSchema,
  run: runSchema,
})
export type Evidence = z.infer<typeof evidenceSchema>
export const recordId = (draft: RecordDraft) => `record-${sha256(JSON.stringify(recordDraftSchema.parse(draft)))}`
