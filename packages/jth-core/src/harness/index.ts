// Public API for jth-core harness system
export { CAPABILITY, DISCOVERY_CAPABILITIES, ASSURANCE_CAPABILITIES, PLANNED_BY_DEFAULT, MUTATING_CAPABILITIES, type CapabilityId, type WorkflowDisposition, type PolicyMode } from './domain/capability-ids.ts'
export { evaluatePolicy, decideNextCapability, type PolicyRequest, type PolicyDecision, type SoftwareFacts, type NextCapabilityDecision, type CapabilityDecision, type BlockedDecision } from './application/policy.ts'
export { validateEvidence, EvidenceValidationError, type EvidenceItem } from './application/evidence.ts'
export { startActivation, nextCommand, advanceActivation, loadWorkflowState, saveWorkflowState, type WorkflowState, type Activation, type Command, type Stage } from './application/activation.ts'
export { evaluateWorkflow, submitEvidence, type WorkflowStartOptions, type WorkflowSubmitOptions, type WorkflowResult } from './workflow.ts'
