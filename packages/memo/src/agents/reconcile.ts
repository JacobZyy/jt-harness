import type { Extraction, MemoryAgentOptions, Submission } from '../contracts.ts'
import { runValidatedMemoryAgent } from './runtime.ts'
import type { AgentContext } from './runtime.ts'
import type { MemoryEntry } from '../storage/contract.ts'
import { reconciliationSchema, validateRelations } from '../storage/relations.ts'
import type { StateEntry } from '../storage/relations.ts'
import type { Relation } from '../storage/relations.ts'
import type { AgentOutput } from './runtime.ts'
import { z } from 'zod'
import { collectItems } from '../intake.ts'
import type { IntakeIssue } from '../intake.ts'
import { relationSchema } from '../storage/relations.ts'
import { comparisonMaterial, jsonBytes } from './material.ts'

export interface ComparisonInput {
  submission: Submission
  extraction: Extraction
  current_entries: MemoryEntry[]
  previous_entries: StateEntry[]
  previous_conflicts: {
    id: string, previous_entry_id: string, current_entry_id: string | null,
    previous_content: string, current_content: string | null, revision: Extraction['revisions'][number] | null,
  }[]
}

export function inspectRelations(response: string, input: ComparisonInput) {
  const raw = z.object({ relations: z.array(z.unknown()) }).parse(JSON.parse(response))
  const result = collectItems<Relation>(raw.relations, 'relations', (value, accepted) => {
    if (accepted.length >= 160) throw new Error('本批已接收 160 条关系，额外关系保留待处理')
    const relation = relationSchema.strip().parse(value)
    validateRelations([...accepted, relation], input.previous_entries, input.current_entries, input.submission, input.extraction)
    if (relation.resolved_revision_conflict_ids.some(id => !input.previous_conflicts.some(conflict => conflict.id === id
      && conflict.current_entry_id === null && conflict.previous_entry_id === relation.previous_entry_id))) throw new Error('模型裁决了未提供的冲突')
    return relation
  })
  return { relations: result.accepted, issues: result.issues }
}

export async function reconcileMemories(input: ComparisonInput, runtime: MemoryAgentOptions, context: AgentContext = {}): Promise<{ relations: Relation[], issues?: IntakeIssue[], run: AgentOutput['run'] }> {
  const material = comparisonMaterial(input)
  if (jsonBytes(material) > 384_000) throw new Error('精简后的记忆比较上下文仍超过 384000 字节；请拆分材料，不会截断事实')
  const selected = new Set(material.previous_entries.map(entry => entry.id))
  const validation = { ...input, previous_entries: input.previous_entries.filter(entry => selected.has(entry.id)), previous_conflicts: material.previous_conflicts }
  const result = await runValidatedMemoryAgent(material, runtime, new URL('./reconcile.md', import.meta.url), reconciliationSchema,
    response => inspectRelations(response, validation), { ...context, sourceBytes: jsonBytes(input) })
  return { ...result.value, run: result.run }
}
