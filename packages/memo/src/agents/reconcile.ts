import type { Extraction, MemoryAgentOptions, Submission } from '../contracts.ts'
import { runMemoryAgent } from './runtime.ts'
import type { AgentContext } from './runtime.ts'
import type { MemoryEntry } from '../storage/contract.ts'
import { reconciliationSchema, validateRelations } from '../storage/relations.ts'
import type { StateEntry } from '../storage/relations.ts'

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

export async function reconcileMemories(input: ComparisonInput, runtime: MemoryAgentOptions, context: AgentContext = {}) {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 384_000) throw new Error('记忆比较上下文超过 384000 字节；请拆分材料，不会截断证据')
  const result = await runMemoryAgent(input, runtime, new URL('./reconcile.md', import.meta.url), reconciliationSchema, context)
  const decision = reconciliationSchema.parse(JSON.parse(result.response))
  validateRelations(decision.relations, input.previous_entries, input.current_entries, input.submission, input.extraction)
  for (const relation of decision.relations) {
    if (relation.resolved_revision_conflict_ids.some(id => !input.previous_conflicts.some(conflict => conflict.id === id
      && conflict.current_entry_id === null && conflict.previous_entry_id === relation.previous_entry_id))) throw new Error('模型裁决了未提供的冲突')
  }
  return { ...decision, run: result.run }
}
