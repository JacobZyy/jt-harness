import { transcriptLines } from './transcript.ts'
import type { Capture } from './capture.ts'
import type { MemoryDeclaration } from '@jacob-z/jt-harness/memo/contracts'

const tokenFields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'] as const
type Usage = Record<typeof tokenFields[number], number | null>
export interface DeclarationObservation {
  version: 1
  processed_at: string | null
  rule_snapshot_id: string | null
  declaration: 'present' | 'missing' | 'invalid' | 'unknown'
  decision: MemoryDeclaration['decision'] | null
  stage: 'staged' | 'skipped' | 'failed'
  error: string | null
  final_message: { message_ids: string[], start: number, end: number } | null
  turn_usage: { attribution: 'turn_context' } & Usage
  write_usage: { background_extraction_model_calls: 0, background_extraction_input_tokens: 0, background_extraction_output_tokens: 0, declaration_tokens: null }
  submission_ids: string[]
}

export function declarationObservation(capture: Capture): DeclarationObservation {
  return { version: 1, processed_at: null, rule_snapshot_id: capture.settings.rule_snapshot_id ?? null, declaration: 'unknown', decision: null, stage: 'skipped', error: null, final_message: null,
    turn_usage: { attribution: 'turn_context', ...unknownUsage() },
    write_usage: { background_extraction_model_calls: 0, background_extraction_input_tokens: 0, background_extraction_output_tokens: 0, declaration_tokens: null }, submission_ids: [] }
}

const unknownUsage = (): Usage => ({ input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null, total_tokens: null })
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const tokenNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Counters describe the surrounding turn, never the marginal cost of generating a declaration. */
export async function declarationTurnUsage(capture: Capture, turnStart: number | undefined): Promise<DeclarationObservation['turn_usage']> {
  const usage = unknownUsage()
  if (!capture.snapshot || turnStart === undefined) return { attribution: 'turn_context', ...usage }
  let previous: Record<string, unknown> | undefined
  const incomplete = new Set<typeof tokenFields[number]>()
  for await (const row of transcriptLines(capture.snapshot.path, 0, capture.snapshot.end)) {
    if (row.value.type !== 'event_msg' || row.value.payload.type !== 'token_count') continue
    const info = object(row.value.payload.info)
    const total = object(info.total_token_usage)
    const last = object(info.last_token_usage)
    if (row.start < turnStart) { previous = total; continue }
    for (const field of tokenFields) {
      const current = tokenNumber(total[field]), before = tokenNumber(previous?.[field])
      const delta = current !== null && before !== null && current >= before ? current - before : tokenNumber(last[field])
      if (delta === null) { incomplete.add(field); usage[field] = null }
      else if (!incomplete.has(field)) usage[field] = (usage[field] ?? 0) + delta
    }
    previous = total
  }
  return { attribution: 'turn_context', ...usage }
}
