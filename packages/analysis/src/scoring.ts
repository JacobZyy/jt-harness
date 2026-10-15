import { validateAnalysisInputs } from './contracts.ts'
import type { Dimension, Domain, EvidenceBundle, JudgmentItem, JudgmentSet } from './contracts.ts'

export const rubric = {
  workflow: [
    { id: 'goal_preservation', label: '目标保持', weight: 40 },
    { id: 'deliverable_completion', label: '需求完成', weight: 30 },
    { id: 'scope_constraints', label: '范围与约束', weight: 20 },
    { id: 'completion_evidence', label: '完成证据', weight: 10 },
  ],
  memo: [
    { id: 'memory_capture', label: '应记内容覆盖', weight: 30 },
    { id: 'memory_fidelity', label: '记忆忠实度', weight: 30 },
    { id: 'scope_confirmation', label: '范围与确认程度', weight: 20 },
    { id: 'retrieval_application', label: '检索与采用', weight: 20 },
  ],
} as const satisfies Record<Domain, readonly { id: Dimension, label: string, weight: number }[]>

export interface DimensionScore {
  id: Dimension
  label: string
  weight: number
  score: number | null
  status: 'assessed' | 'unknown' | 'not_applicable'
  assessedItems: number
  applicableItems: number
}

export interface DomainScore {
  score: number | null
  scoreKind: 'final' | 'stage' | 'unavailable' | 'not_applicable'
  coverage: {
    assessedItems: number, applicableItems: number, itemPercentage: number | null,
    assessedDimensions: number, requiredDimensions: number,
    assessedRequirements: number, totalRequirements: number, requirementPercentage: number | null,
    inventoryStatus: JudgmentSet['tasks'][number]['coverageReview']['status'],
  }
  dimensions: DimensionScore[]
  seriousIssues: string[]
  criticalIssues: string[]
  withheldReasons: string[]
}

export interface TaskAnalysis {
  id: string
  title: string
  sessionIds: string[]
  state: JudgmentSet['tasks'][number]['state']
  requirements: JudgmentSet['tasks'][number]['requirements']
  coverageReview: JudgmentSet['tasks'][number]['coverageReview']
  workflow: DomainScore
  memo: DomainScore
  items: JudgmentItem[]
  contributions: JudgmentSet['contributions']
}

export interface BatchScore {
  score: number | null
  assessedTasks: number
  selectedTasks: number
  notApplicableTasks: number
  stageTasks: number
  unknownTasks: number
  coveragePercentage: number | null
}

export interface AnalysisReport {
  schemaVersion: 1
  analysisId: string
  bundleHash: string
  cutoff: string
  selection: EvidenceBundle['selection']
  judge: JudgmentSet['judge']
  usage: EvidenceBundle['usage']
  chainFacts: EvidenceBundle['chainFacts']
  evidence: EvidenceBundle['evidence']
  sources: EvidenceBundle['sources']
  tasks: TaskAnalysis[]
  batch: Record<Domain, BatchScore>
}

const points = { satisfied: 1, partial: 0.5, violated: 0 } as const
const round = (value: number) => Math.round(value * 10) / 10

function scoreDimension(items: JudgmentItem[], dimension: typeof rubric[Domain][number]): DimensionScore {
  const selected = items.filter(item => item.dimension === dimension.id)
  const applicable = selected.filter(item => item.status !== 'not_applicable')
  const assessed = applicable.filter((item): item is JudgmentItem & { status: keyof typeof points } => item.status !== 'unknown')
  const base = { ...dimension, assessedItems: assessed.length, applicableItems: applicable.length }
  if (!selected.length || assessed.length < applicable.length) return { ...base, score: null, status: 'unknown' }
  if (!applicable.length) return { ...base, score: null, status: 'not_applicable' }
  return { ...base, score: round(100 * assessed.reduce((total, item) => total + points[item.status], 0) / assessed.length), status: 'assessed' }
}

function scoreDomain(items: JudgmentItem[], domain: Domain, task: JudgmentSet['tasks'][number]): DomainScore {
  const selected = items.filter(item => item.domain === domain)
  const dimensions = rubric[domain].map(dimension => scoreDimension(selected, dimension))
  const applicable = selected.filter(item => item.status !== 'not_applicable')
  const assessed = applicable.filter(item => item.status !== 'unknown')
  const unknown = dimensions.filter(dimension => dimension.status === 'unknown')
  const weighted = dimensions.filter(dimension => dimension.status === 'assessed')
  const totalWeight = weighted.reduce((total, dimension) => total + dimension.weight, 0)
  const requirements = task.requirements.filter(requirement => requirement.domain === domain)
  const assessedRequirementIds = new Set(selected.filter(item => item.status !== 'unknown').flatMap(item => item.requirementIds))
  const assessedRequirements = requirements.filter(requirement => assessedRequirementIds.has(requirement.id)).length
  const withheldReasons = unknown.map(dimension => `${dimension.label}缺少完整判定或关键证据`)
  if (task.coverageReview.status !== 'complete') withheldReasons.push(`当前有效要求清单完整性${task.coverageReview.status === 'unknown' ? '未确认' : '核对未通过'}`)
  if (!requirements.length) withheldReasons.push('没有可追溯的当前有效要求清单')
  if (assessedRequirements < requirements.length) withheldReasons.push(`${requirements.length - assessedRequirements} 条当前有效要求没有明确判定`)
  if (task.state === 'unknown') withheldReasons.push('任务边界或完成状态尚未确认')
  const score = withheldReasons.length || !totalWeight ? null : round(weighted.reduce((total, dimension) => total + dimension.score! * dimension.weight, 0) / totalWeight)
  const scoreKind = score !== null ? task.state === 'completed' ? 'final' : 'stage'
    : !withheldReasons.length && !totalWeight ? 'not_applicable' : 'unavailable'
  return {
    score,
    scoreKind,
    coverage: {
      assessedItems: assessed.length,
      applicableItems: applicable.length,
      itemPercentage: applicable.length ? round(100 * assessed.length / applicable.length) : null,
      assessedDimensions: dimensions.filter(dimension => dimension.status !== 'unknown').length,
      requiredDimensions: dimensions.length,
      assessedRequirements,
      totalRequirements: requirements.length,
      requirementPercentage: requirements.length ? round(100 * assessedRequirements / requirements.length) : null,
      inventoryStatus: task.coverageReview.status,
    },
    dimensions,
    seriousIssues: selected.filter(item => item.severity === 'serious').map(item => item.id),
    criticalIssues: selected.filter(item => item.severity === 'critical').map(item => item.id),
    withheldReasons,
  }
}

function batchScore(tasks: TaskAnalysis[], domain: Domain): BatchScore {
  const assessed = tasks.filter(task => task[domain].scoreKind === 'final')
  const notApplicableTasks = tasks.filter(task => task[domain].scoreKind === 'not_applicable').length
  const applicableTasks = tasks.length - notApplicableTasks
  return {
    score: assessed.length ? round(assessed.reduce((total, task) => total + task[domain].score!, 0) / assessed.length) : null,
    assessedTasks: assessed.length,
    selectedTasks: tasks.length,
    notApplicableTasks,
    stageTasks: tasks.filter(task => task[domain].scoreKind === 'stage').length,
    unknownTasks: tasks.filter(task => task[domain].scoreKind === 'unavailable').length,
    coveragePercentage: applicableTasks ? round(100 * assessed.length / applicableTasks) : null,
  }
}

/** This module assesses saved evidence only; it neither executes tasks nor calls a model. */
export function analyzeBundle(bundleInput: unknown, judgmentInput: unknown): AnalysisReport {
  const { bundle, judgments } = validateAnalysisInputs(bundleInput, judgmentInput)
  const tasks = judgments.tasks.map(task => {
    const items = judgments.items.filter(item => item.taskId === task.id)
    return {
      ...task,
      workflow: scoreDomain(items, 'workflow', task),
      memo: scoreDomain(items, 'memo', task),
      items,
      contributions: judgments.contributions.filter(contribution => contribution.taskId === task.id),
    }
  })
  return {
    schemaVersion: 1,
    analysisId: bundle.analysisId,
    bundleHash: judgments.bundleHash,
    cutoff: bundle.cutoff,
    selection: bundle.selection,
    judge: judgments.judge,
    usage: bundle.usage,
    chainFacts: bundle.chainFacts,
    evidence: bundle.evidence,
    sources: bundle.sources,
    tasks,
    batch: { workflow: batchScore(tasks, 'workflow'), memo: batchScore(tasks, 'memo') },
  }
}
