import { z } from 'zod'
import { extractionSchema, parseExtraction } from './contracts.ts'
import type { Extraction, Submission } from './contracts.ts'

export const intakeIssueSchema = z.strictObject({ path: z.string().min(1), error: z.string().min(1), value: z.unknown() })
export type IntakeIssue = z.infer<typeof intakeIssueSchema>

/** Preserve the original value in diagnostics; only independent, usable items enter the checkpoint. */
export function collectItems<T>(items: unknown[], collection: string, accept: (value: unknown, accepted: T[]) => T) {
  const accepted: T[] = [], issues: IntakeIssue[] = []
  for (const [index, value] of items.entries()) {
    try { accepted.push(accept(value, accepted)) } catch (error) {
      issues.push({ path: `${collection}[${index}]`, value,
        error: error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
          : error instanceof Error ? error.message : '条目格式无效',
      })
    }
  }
  return { accepted, issues }
}

const extractionEnvelope = z.object({ schema_version: z.literal(1), memories: z.unknown().optional(), proposals: z.unknown().optional(), revisions: z.unknown().optional() })

export function inspectExtraction(response: string, submission: Submission): { extraction: Extraction, issues: IntakeIssue[] } {
  const raw = extractionEnvelope.parse(JSON.parse(response))
  if (!['memories', 'proposals', 'revisions'].some(key => Object.hasOwn(raw, key))) throw new Error('JSON 缺少提炼集合，不能当成正常空结果')
  const extraction: Extraction = { schema_version: 1, memories: [], proposals: [], revisions: [] }
  const issues: IntakeIssue[] = []
  for (const collection of ['memories', 'proposals', 'revisions'] as const) {
    const items = Object.hasOwn(raw, collection) ? raw[collection] : []
    if (!Array.isArray(items)) {
      issues.push({ path: collection, error: '集合必须为数组', value: items })
      continue
    }
    const result = collectItems<Extraction>(items, collection, (value, accepted) => {
      if (accepted.length >= 80) throw new Error('本批集合已接收 80 条，额外条目保留待处理')
      // Extra model metadata stays in the saved raw response; supported fields retain their contract.
      const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } as Record<string, unknown> : value
      if (input && typeof input === 'object' && 'entities' in input && Array.isArray(input.entities) && input.entities.every(entity => typeof entity === 'string')) {
        input.entities = [...new Set(input.entities.map(entity => entity.trim()).filter(Boolean))]
      }
      if (input && typeof input === 'object' && 'source_message_ids' in input && Array.isArray(input.source_message_ids)) {
        input.source_message_ids = [...new Set(input.source_message_ids)]
      }
      const item = extractionSchema.shape[collection].element.strip().parse(input)
      const single: Extraction = { schema_version: 1, memories: [], proposals: [], revisions: [] }
      // Each branch keeps its collection's type and the original evidence validation.
      if (collection === 'memories') single.memories = [extractionSchema.shape.memories.element.parse(item)]
      else if (collection === 'proposals') single.proposals = [extractionSchema.shape.proposals.element.parse(item)]
      else single.revisions = [extractionSchema.shape.revisions.element.parse(item)]
      return parseExtraction(JSON.stringify(single), submission)
    })
    for (const item of result.accepted) {
      extraction.memories.push(...item.memories)
      extraction.proposals.push(...item.proposals)
      extraction.revisions.push(...item.revisions)
    }
    issues.push(...result.issues)
  }
  return { extraction, issues }
}
