// Harness domain — Capability IDs, mirrors rex-harness domain/capability-ids.mjs

export const CAPABILITY = Object.freeze({
  REQUIREMENTS_CLARIFY: 'software.requirements.clarify',
  DESIGN_RESOLVE: 'software.design.resolve',
  PLANNING_SEQUENCE: 'software.planning.sequence',
  TESTING_DESIGN: 'software.testing.design',
  TESTING_TDD: 'software.testing.tdd',
  TESTING_STRICT_TDD: 'software.testing.strict-tdd',
  TESTING_HARDENING: 'software.testing.hardening',
  DEBUG_ROOT_CAUSE: 'software.debug.root-cause',
  IMPLEMENTATION_MINIMIZE: 'software.implementation.minimize',
  IMPLEMENTATION_EXECUTE: 'software.implementation.execute',
  REVIEW_STANDARDS_SPEC: 'software.review.standards-spec',
  REVIEW_SPECIALIST: 'software.review.specialist',
  NAVIGATION_WAYFIND: 'software.navigation.wayfind',
} as const)

export type CapabilityId = typeof CAPABILITY[keyof typeof CAPABILITY]

export const DISCOVERY_CAPABILITIES = new Set<CapabilityId>([
  CAPABILITY.REQUIREMENTS_CLARIFY,
  CAPABILITY.DESIGN_RESOLVE,
  CAPABILITY.PLANNING_SEQUENCE,
  CAPABILITY.IMPLEMENTATION_MINIMIZE,
  CAPABILITY.NAVIGATION_WAYFIND,
])

export const ASSURANCE_CAPABILITIES = new Set<CapabilityId>([
  CAPABILITY.REVIEW_STANDARDS_SPEC,
  CAPABILITY.REVIEW_SPECIALIST,
])

export const PLANNED_BY_DEFAULT = new Set<CapabilityId>([
  CAPABILITY.REQUIREMENTS_CLARIFY,
  CAPABILITY.DESIGN_RESOLVE,
  CAPABILITY.PLANNING_SEQUENCE,
  CAPABILITY.TESTING_DESIGN,
  CAPABILITY.TESTING_STRICT_TDD,
  CAPABILITY.NAVIGATION_WAYFIND,
])

export const MUTATING_CAPABILITIES = new Set<CapabilityId>([
  CAPABILITY.TESTING_DESIGN,
  CAPABILITY.TESTING_TDD,
  CAPABILITY.TESTING_STRICT_TDD,
  CAPABILITY.TESTING_HARDENING,
  CAPABILITY.DEBUG_ROOT_CAUSE,
  CAPABILITY.IMPLEMENTATION_EXECUTE,
])

export type WorkflowDisposition = 'noop' | 'direct' | 'guarded' | 'planned'
export type PolicyMode = 'adaptive' | 'strict'
