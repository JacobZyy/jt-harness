// Workflow policy — mirrors AIOS evaluateWorkflowPolicy
// Disposition: noop | direct | guarded | planned
// Program evaluates from declared intent, not free-text heuristics.

import { CAPABILITY, PLANNED_BY_DEFAULT, MUTATING_CAPABILITIES, type CapabilityId, type WorkflowDisposition, type PolicyMode } from '../domain/capability-ids.ts'

export interface PolicyRequest {
  intent: 'noop' | 'question' | 'implement' | 'debug' | 'design' | 'verify' | 'ops' | 'review'
  relationship: 'new' | 'continue' | 'amend' | 'approve'
  contextAvailable?: boolean
  activePlan?: boolean
  planningReasons?: Array<'requested' | 'dependent-work' | 'uncertain-approach' | 'significant-impact'>
}

export interface PolicyDecision {
  mode: PolicyMode
  intent: PolicyRequest['intent']
  relationship: PolicyRequest['relationship']
  disposition: WorkflowDisposition
  planAction: 'none' | 'create' | 'reuse' | 'recover-context'
  verification: 'none' | 'focused' | 'deliverables'
  reason: string
}

export function evaluatePolicy(request: PolicyRequest, mode: PolicyMode = 'adaptive'): PolicyDecision {
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

  const reasons = request.planningReasons ?? []
  const planned = mode === 'strict' || request.intent === 'design' || reasons.length > 0

  return {
    ...base,
    disposition: planned ? 'planned' : 'guarded',
    planAction: planned ? 'create' : 'none',
    verification: planned ? 'deliverables' : 'focused',
    reason: mode === 'strict' ? 'strict-work-request'
      : request.intent === 'design' ? 'design-work'
        : reasons.join(',') || 'bounded-work',
  }
}

// ── Fact-driven Capability selection (mirrors rex-harness decideNextCapability) ──

export interface SoftwareFacts {
  hasRequirements: boolean
  hasDesign: boolean
  hasPlan: boolean
  hasTestDesign: boolean
  hasTdd: boolean
  hasImplementation: boolean
  hasReview: boolean
  hasDebugging: boolean
  explicitIntent?: string
  completedCapabilities?: CapabilityId[]
}

export interface CapabilityDecision {
  capabilityId: CapabilityId
  blocked: false
  requiredEvidence: string[]
  provider: string
}

export interface BlockedDecision {
  blocked: true
  blockedReason: string
  capabilityId: ''
}

export type NextCapabilityDecision = CapabilityDecision | BlockedDecision

const CAPABILITY_SEQUENCE: CapabilityId[] = [
  CAPABILITY.REQUIREMENTS_CLARIFY,
  CAPABILITY.DESIGN_RESOLVE,
  CAPABILITY.PLANNING_SEQUENCE,
  CAPABILITY.TESTING_DESIGN,
  CAPABILITY.TESTING_TDD,
  CAPABILITY.IMPLEMENTATION_EXECUTE,
  CAPABILITY.REVIEW_STANDARDS_SPEC,
]

export function decideNextCapability(facts: SoftwareFacts): NextCapabilityDecision {
  const completed = new Set(facts.completedCapabilities ?? [])
  const explicitMap: Record<string, CapabilityId> = {
    implement: CAPABILITY.IMPLEMENTATION_EXECUTE,
    debug: CAPABILITY.DEBUG_ROOT_CAUSE,
    review: CAPABILITY.REVIEW_STANDARDS_SPEC,
    design: CAPABILITY.DESIGN_RESOLVE,
    test: CAPABILITY.TESTING_TDD,
  }
  if (facts.explicitIntent && explicitMap[facts.explicitIntent]) {
    const cap = explicitMap[facts.explicitIntent]
    return { capabilityId: cap, blocked: false, requiredEvidence: [], provider: defaultProvider(cap) }
  }

  for (const cap of CAPABILITY_SEQUENCE) {
    if (!completed.has(cap)) {
      return { capabilityId: cap, blocked: false, requiredEvidence: [], provider: defaultProvider(cap) }
    }
  }

  return { blocked: true, blockedReason: 'all-capabilities-completed', capabilityId: '' }
}

function defaultProvider(cap: CapabilityId): string {
  const map: Partial<Record<CapabilityId, string>> = {
    [CAPABILITY.REQUIREMENTS_CLARIFY]: 'planner',
    [CAPABILITY.DESIGN_RESOLVE]: 'architect',
    [CAPABILITY.PLANNING_SEQUENCE]: 'planner',
    [CAPABILITY.TESTING_DESIGN]: 'tdd-guide',
    [CAPABILITY.TESTING_TDD]: 'tdd-guide',
    [CAPABILITY.IMPLEMENTATION_EXECUTE]: 'implementer',
    [CAPABILITY.REVIEW_STANDARDS_SPEC]: 'code-reviewer',
    [CAPABILITY.DEBUG_ROOT_CAUSE]: 'build-error-resolver',
  }
  return map[cap] ?? 'implementer'
}
