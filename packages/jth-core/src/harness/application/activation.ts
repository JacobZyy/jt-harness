// Activation store — AIOS-style workflow state machine
// Owns the current capability activation, evidence submission, and advancement.
// Mirrors rex-harness domain/activations.mjs + application/start-activation.mjs

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { readTextIfExists, atomicWrite, ensureStateDir } from '../../storage/base/io.ts'
import { join, dirname } from 'node:path'
import type { CapabilityId } from '../domain/capability-ids.ts'
import type { NextCapabilityDecision } from './policy.ts'
import { validateEvidence, type EvidenceItem } from './evidence.ts'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Stage {
  id: string
  objective: string
  expectedEvidence: (string | { anyOf: string[] })[]
}

export interface Activation {
  activationId: string
  workflowActivationId: string
  capabilityId: CapabilityId
  stageId: string
  startedAt: string
  completedStages: string[]
  evidenceRefs: string[]
  blocked: false
}

export interface Command {
  capabilityId: CapabilityId
  stageId: string
  provider: string
  objective: string
  expectedEvidence: (string | { anyOf: string[] })[]
}

export interface WorkflowState {
  workflowActivationId: string
  currentActivation: Activation | null
  currentCommand: Command | null
  activationHistory: Activation[]
  completedCapabilities: CapabilityId[]
  createdAt: string
  updatedAt: string
}

// ── Storage ───────────────────────────────────────────────────────────────────

function workflowStatePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.jth', 'harness', 'workflow-state.json')
}

export async function loadWorkflowState(workspaceRoot: string): Promise<WorkflowState | null> {
  const path = workflowStatePath(workspaceRoot)
  const text = await readTextIfExists(path)
  if (!text.trim()) return null
  try { return JSON.parse(text) as WorkflowState }
  catch { return null }
}

export async function saveWorkflowState(workspaceRoot: string, state: WorkflowState): Promise<void> {
  const path = workflowStatePath(workspaceRoot)
  await ensureStateDir(dirname(path))
  await atomicWrite(path, JSON.stringify(state, null, 2))
}

export async function clearWorkflowState(workspaceRoot: string): Promise<void> {
  await rm(workflowStatePath(workspaceRoot), { force: true })
}

// ── Stage catalog ─────────────────────────────────────────────────────────────

const STAGE_CATALOG: Record<CapabilityId, Stage[]> = {
  'software.requirements.clarify': [
    { id: 'clarify', objective: '明确需求范围、成功条件和约束', expectedEvidence: ['requirements-decision-recorded'] },
  ],
  'software.design.resolve': [
    { id: 'design', objective: '产出技术设计决策', expectedEvidence: ['design-decision-recorded'] },
  ],
  'software.planning.sequence': [
    { id: 'plan', objective: '制定可执行的实施计划', expectedEvidence: ['implementation-complete'] },
  ],
  'software.testing.design': [
    { id: 'decide-testability', objective: '判断可测试性并产出测试设计', expectedEvidence: ['requirements-decision-recorded'] },
  ],
  'software.testing.tdd': [
    { id: 'write-failing-test', objective: '写一个失败的测试', expectedEvidence: ['failing-test-observed'] },
    { id: 'make-pass', objective: '最小实现让测试通过', expectedEvidence: ['passing-test-observed'] },
    { id: 'refactor', objective: '重构保持绿色', expectedEvidence: [{ anyOf: ['refactor-check-recorded', 'passing-test-observed'] }] },
  ],
  'software.testing.strict-tdd': [
    { id: 'write-failing-test', objective: '写一个失败的测试', expectedEvidence: ['failing-test-observed'] },
    { id: 'make-pass', objective: '最小实现', expectedEvidence: ['passing-test-observed'] },
    { id: 'refactor', objective: '严格重构', expectedEvidence: ['refactor-check-recorded'] },
  ],
  'software.testing.hardening': [
    { id: 'harden', objective: '加固测试覆盖', expectedEvidence: ['passing-test-observed'] },
  ],
  'software.debug.root-cause': [
    { id: 'reproduce', objective: '重现并定位根因', expectedEvidence: ['debug-root-cause-identified'] },
    { id: 'fix', objective: '修复并验证', expectedEvidence: ['passing-test-observed'] },
  ],
  'software.implementation.minimize': [
    { id: 'implement', objective: '最小化实现', expectedEvidence: ['implementation-complete'] },
  ],
  'software.implementation.execute': [
    { id: 'implement', objective: '完整实现', expectedEvidence: ['implementation-complete'] },
    { id: 'verify', objective: '验证实现', expectedEvidence: [{ anyOf: ['passing-test-observed', 'manual-verification'] }] },
  ],
  'software.review.standards-spec': [
    { id: 'review', objective: '标准规范审查', expectedEvidence: ['review-verdict'] },
  ],
  'software.review.specialist': [
    { id: 'review', objective: '专项审查', expectedEvidence: ['review-verdict'] },
  ],
  'software.navigation.wayfind': [
    { id: 'wayfind', objective: '路径探索与方向确认', expectedEvidence: ['requirements-decision-recorded'] },
  ],
}

function getStages(capabilityId: CapabilityId): Stage[] {
  return STAGE_CATALOG[capabilityId] ?? []
}

// ── Activation lifecycle ──────────────────────────────────────────────────────

export function startActivation(decision: NextCapabilityDecision): Activation {
  if (decision.blocked) throw new Error('cannot start activation from a blocked decision')
  const stages = getStages(decision.capabilityId)
  const firstStage = stages[0]
  if (!firstStage) throw new Error(`no stages for capability ${decision.capabilityId}`)
  return {
    activationId: randomUUID(),
    workflowActivationId: randomUUID(),
    capabilityId: decision.capabilityId,
    stageId: firstStage.id,
    startedAt: new Date().toISOString(),
    completedStages: [],
    evidenceRefs: [],
    blocked: false,
  }
}

export function nextCommand(activation: Activation, provider: string): Command {
  const stages = getStages(activation.capabilityId)
  const stage = stages.find(s => s.id === activation.stageId)
  if (!stage) throw new Error(`unknown stage ${activation.stageId}`)
  return {
    capabilityId: activation.capabilityId,
    stageId: stage.id,
    provider,
    objective: stage.objective,
    expectedEvidence: stage.expectedEvidence,
  }
}

export function advanceActivation(
  activation: Activation,
  evidence: EvidenceItem[],
  command: Command,
): { activation: Activation; completed: boolean } {
  validateEvidence(evidence, command.expectedEvidence)
  const stages = getStages(activation.capabilityId)
  const currentIdx = stages.findIndex(s => s.id === activation.stageId)
  const evidenceRefs = [
    ...activation.evidenceRefs,
    ...evidence.flatMap(e => e.refs),
  ]
  const completedStages = [...activation.completedStages, activation.stageId]
  const nextStage = stages[currentIdx + 1]
  if (!nextStage) {
    // All stages done
    return {
      activation: { ...activation, stageId: 'completed', completedStages, evidenceRefs },
      completed: true,
    }
  }
  return {
    activation: { ...activation, stageId: nextStage.id, completedStages, evidenceRefs },
    completed: false,
  }
}
