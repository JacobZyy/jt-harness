import { z } from 'zod'

export const policyModeSchema = z.enum(['adaptive', 'strict'])
export const policyRequestSchema = z.strictObject({
  intent: z.enum(['noop', 'question', 'implement', 'debug', 'design', 'verify', 'ops']),
  relationship: z.enum(['new', 'continue', 'amend', 'approve']).default('new'),
  contextAvailable: z.boolean().default(false),
  activePlan: z.boolean().default(false),
  planningReasons: z.array(z.enum(['requested', 'dependent-work', 'uncertain-approach', 'significant-impact'])).max(4).default([]),
})

export type PolicyMode = z.infer<typeof policyModeSchema>
export type PolicyRequest = z.infer<typeof policyRequestSchema>
export interface PolicyDecision {
  mode: PolicyMode
  intent: PolicyRequest['intent']
  relationship: PolicyRequest['relationship']
  disposition: 'noop' | 'direct' | 'guarded' | 'planned'
  planAction: 'none' | 'create' | 'reuse' | 'recover-context'
  verification: 'none' | 'focused' | 'deliverables'
  reason: string
}

/** The caller declares semantics. This layer does not read prompts, select a host, or mutate progress. */
export function evaluatePolicy(request: PolicyRequest, mode: PolicyMode): PolicyDecision {
  const base = { mode, intent: request.intent, relationship: request.relationship }
  if (request.intent === 'noop' || request.intent === 'question') {
    return { ...base, disposition: request.intent === 'noop' ? 'noop' : 'direct', planAction: 'none', verification: 'none', reason: 'no-work-requested' }
  }
  if (request.relationship !== 'new' && !request.contextAvailable) {
    return { ...base, disposition: 'direct', planAction: 'recover-context', verification: 'none', reason: 'referenced-context-missing' }
  }
  if (request.relationship !== 'new' && request.activePlan) {
    return { ...base, disposition: 'planned', planAction: 'reuse', verification: 'deliverables', reason: 'continue-existing-plan' }
  }
  const planned = mode === 'strict' || request.intent === 'design' || request.planningReasons.length > 0
  return {
    ...base,
    disposition: planned ? 'planned' : 'guarded',
    planAction: planned ? 'create' : 'none',
    verification: planned ? 'deliverables' : 'focused',
    reason: mode === 'strict' ? 'strict-work-request'
      : request.intent === 'design' ? 'design-work'
        : request.planningReasons.join(',') || 'bounded-work',
  }
}
