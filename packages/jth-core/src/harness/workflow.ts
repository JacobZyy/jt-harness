// Workflow state machine — ties policy + activation together
// Called by CLI and hooks to run the full planned-work flow

import { evaluatePolicy, decideNextCapability, type PolicyRequest } from './application/policy.ts'
import type { PolicyMode } from './domain/capability-ids.ts'
import { startActivation, nextCommand, advanceActivation, loadWorkflowState, saveWorkflowState, type WorkflowState, type Command } from './application/activation.ts'
import type { EvidenceItem } from './application/evidence.ts'
import { EvidenceValidationError } from './application/evidence.ts'
import { randomUUID } from 'node:crypto'

export type { WorkflowState, Command }
export { EvidenceValidationError }

export interface WorkflowStartOptions {
  workspaceRoot: string
  request: PolicyRequest
  mode?: PolicyMode
  explicitIntent?: string
}

export interface WorkflowSubmitOptions {
  workspaceRoot: string
  evidence: EvidenceItem[]
  resolveReceipt?: (ref: string) => { exitCode: number } | null
}

export interface WorkflowResult {
  status: 'started' | 'advanced' | 'completed' | 'blocked' | 'noop' | 'direct' | 'guarded'
  disposition: string
  command?: Command
  workflow?: WorkflowState
  reason?: string
  error?: string
}

function emptyWorkflow(workspaceRoot: string): WorkflowState {
  return {
    workflowActivationId: randomUUID(),
    currentActivation: null,
    currentCommand: null,
    activationHistory: [],
    completedCapabilities: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export async function evaluateWorkflow(opts: WorkflowStartOptions): Promise<WorkflowResult> {
  const { workspaceRoot, request, mode = 'adaptive', explicitIntent } = opts
  const decision = evaluatePolicy(request, mode)

  if (decision.disposition === 'noop') return { status: 'noop', disposition: 'noop' }
  if (decision.disposition === 'direct') return { status: 'direct', disposition: 'direct', reason: decision.reason }
  if (decision.disposition === 'guarded') return { status: 'guarded', disposition: 'guarded', reason: decision.reason }

  // planned — load or create workflow state
  let state = await loadWorkflowState(workspaceRoot) ?? emptyWorkflow(workspaceRoot)

  // If already has an active activation, return its command
  if (state.currentActivation && state.currentActivation.stageId !== 'completed') {
    const provider = state.currentCommand?.provider ?? 'implementer'
    const command = nextCommand(state.currentActivation, provider)
    return { status: 'started', disposition: 'planned', command, workflow: state }
  }

  // Start a new capability
  const capDecision = decideNextCapability({
    hasRequirements: state.completedCapabilities.includes('software.requirements.clarify' as never),
    hasDesign: state.completedCapabilities.includes('software.design.resolve' as never),
    hasPlan: state.completedCapabilities.includes('software.planning.sequence' as never),
    hasTestDesign: state.completedCapabilities.includes('software.testing.design' as never),
    hasTdd: state.completedCapabilities.includes('software.testing.tdd' as never),
    hasImplementation: state.completedCapabilities.includes('software.implementation.execute' as never),
    hasReview: state.completedCapabilities.includes('software.review.standards-spec' as never),
    hasDebugging: state.completedCapabilities.includes('software.debug.root-cause' as never),
    explicitIntent,
    completedCapabilities: state.completedCapabilities as never[],
  })

  if (capDecision.blocked) {
    return { status: 'blocked', disposition: 'planned', reason: capDecision.blockedReason }
  }

  const activation = startActivation(capDecision)
  const command = nextCommand(activation, capDecision.provider)
  state = {
    ...state,
    currentActivation: activation,
    currentCommand: command,
    updatedAt: new Date().toISOString(),
  }
  await saveWorkflowState(workspaceRoot, state)
  return { status: 'started', disposition: 'planned', command, workflow: state }
}

export async function submitEvidence(opts: WorkflowSubmitOptions): Promise<WorkflowResult> {
  const { workspaceRoot, evidence, resolveReceipt } = opts
  const state = await loadWorkflowState(workspaceRoot)
  if (!state?.currentActivation || !state.currentCommand) {
    return { status: 'blocked', disposition: 'planned', error: 'no active workflow; call evaluateWorkflow first' }
  }

  try {
    const { activation, completed } = advanceActivation(state.currentActivation, evidence, state.currentCommand)
    const updatedState: WorkflowState = {
      ...state,
      currentActivation: activation,
      currentCommand: completed ? null : nextCommand(activation, state.currentCommand.provider),
      completedCapabilities: completed
        ? [...state.completedCapabilities, activation.capabilityId]
        : state.completedCapabilities,
      activationHistory: completed
        ? [...state.activationHistory, activation]
        : state.activationHistory,
      updatedAt: new Date().toISOString(),
    }
    await saveWorkflowState(workspaceRoot, updatedState)
    return {
      status: completed ? 'completed' : 'advanced',
      disposition: 'planned',
      command: updatedState.currentCommand ?? undefined,
      workflow: updatedState,
    }
  } catch (err) {
    if (err instanceof EvidenceValidationError) {
      return { status: 'blocked', disposition: 'planned', error: err.message }
    }
    throw err
  }
}
