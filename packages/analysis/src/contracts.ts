import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const workflowDimensions = ['goal_preservation', 'deliverable_completion', 'scope_constraints', 'completion_evidence'] as const
export const memoDimensions = ['memory_capture', 'memory_fidelity', 'scope_confirmation', 'retrieval_application'] as const
export const domainSchema = z.enum(['workflow', 'memo'])
export const judgmentStatusSchema = z.enum(['satisfied', 'partial', 'violated', 'unknown', 'not_applicable'])
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
const text = z.string().refine(value => value.trim().length > 0, '内容不能为空')
const timestamp = z.iso.datetime({ offset: true })
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const tokens = z.number().int().nonnegative().nullable()

export const observedUsageSchema = z.strictObject({
  inputTokens: tokens,
  outputTokens: tokens,
  cachedInputTokens: tokens,
  totalTokens: tokens,
})

export const evidenceBundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  analysisId: identifier,
  cutoff: timestamp,
  selection: z.strictObject({
    workspacePaths: z.array(z.string().refine(isAbsolute, '工作目录必须是绝对路径')).min(1),
    sessionIds: z.array(identifier).min(1),
  }),
  sources: z.array(z.strictObject({
    id: identifier,
    sessionId: identifier,
    workspacePath: z.string().refine(isAbsolute, '来源工作目录必须是绝对路径'),
    path: text,
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    sha256: sha256.optional(),
  })),
  evidence: z.array(z.strictObject({
    id: identifier,
    kind: text,
    text,
    occurredAt: timestamp,
    sourceId: identifier,
  })),
  chainFacts: z.array(z.strictObject({
    id: identifier,
    domain: domainSchema,
    stage: text,
    status: z.enum(['observed', 'missing', 'failed', 'unknown', 'not_applicable']),
    evidenceIds: z.array(identifier),
    detail: text,
  })),
  usage: observedUsageSchema,
}).superRefine((bundle, context) => {
  const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: 'custom', message, path })
  for (const [key, values] of Object.entries({ workspacePaths: bundle.selection.workspacePaths, sessionIds: bundle.selection.sessionIds })) {
    if (new Set(values).size !== values.length) issue('选定范围不能重复', ['selection', key])
  }
  for (const key of ['sources', 'evidence', 'chainFacts'] as const) {
    if (new Set(bundle[key].map(value => value.id)).size !== bundle[key].length) issue('ID 不能重复', [key])
  }
  const sourceIds = new Set(bundle.sources.map(source => source.id))
  const evidenceIds = new Set(bundle.evidence.map(evidence => evidence.id))
  bundle.sources.forEach((source, index) => {
    if (!bundle.selection.sessionIds.includes(source.sessionId)) issue('来源会话不在选定范围', ['sources', index, 'sessionId'])
    if (!bundle.selection.workspacePaths.includes(source.workspacePath)) issue('来源目录不在选定范围', ['sources', index, 'workspacePath'])
    if ((source.start === undefined) !== (source.end === undefined)) issue('来源位置必须同时提供起点和终点', ['sources', index])
    if (source.start !== undefined && source.end !== undefined && source.end < source.start) issue('来源位置终点不能早于起点', ['sources', index, 'end'])
  })
  bundle.evidence.forEach((evidence, index) => {
    if (!sourceIds.has(evidence.sourceId)) issue('证据来源不存在', ['evidence', index, 'sourceId'])
    if (Date.parse(evidence.occurredAt) > Date.parse(bundle.cutoff)) issue('证据晚于分析截止时间', ['evidence', index, 'occurredAt'])
  })
  bundle.chainFacts.forEach((fact, index) => {
    if (new Set(fact.evidenceIds).size !== fact.evidenceIds.length) issue('链路证据 ID 不能重复', ['chainFacts', index, 'evidenceIds'])
    if (fact.evidenceIds.some(id => !evidenceIds.has(id))) issue('链路引用的证据不存在', ['chainFacts', index, 'evidenceIds'])
  })
})

export const evidenceReferenceSchema = z.strictObject({ evidenceId: identifier, quote: text })
const judgmentFields = {
  id: identifier,
  taskId: identifier,
  criterion: text,
  requirementIds: z.array(identifier).min(1),
  status: judgmentStatusSchema,
  requirementRefs: z.array(evidenceReferenceSchema),
  evidenceRefs: z.array(evidenceReferenceSchema),
  reason: text,
  missing: text.optional(),
  severity: z.enum(['normal', 'serious', 'critical']),
}
export const judgmentItemSchema = z.union([
  z.strictObject({ ...judgmentFields, domain: z.literal('workflow'), dimension: z.enum(workflowDimensions) }),
  z.strictObject({ ...judgmentFields, domain: z.literal('memo'), dimension: z.enum(memoDimensions) }),
]).superRefine((item, context) => {
  if (item.status !== 'unknown' && (!item.requirementRefs.length || !item.evidenceRefs.length)) {
    context.addIssue({ code: 'custom', message: '明确判定必须引用要求与执行证据', path: ['evidenceRefs'] })
  }
  if (item.status === 'partial' && !item.missing) {
    context.addIssue({ code: 'custom', message: '部分满足必须说明具体缺失', path: ['missing'] })
  }
  if (!['partial', 'violated'].includes(item.status) && item.severity !== 'normal') {
    context.addIssue({ code: 'custom', message: '严重错误只能对应已证实的问题', path: ['severity'] })
  }
})

export const judgmentSetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bundleHash: sha256,
  judge: z.strictObject({ model: text.nullable(), sessionId: identifier.nullable(), rubricVersion: z.literal('1'), assessedAt: timestamp }),
  tasks: z.array(z.strictObject({
    id: identifier,
    title: text,
    sessionIds: z.array(identifier).min(1),
    state: z.enum(['completed', 'in_progress', 'unknown']),
    requirements: z.array(z.strictObject({ id: identifier, domain: domainSchema, text, sourceRefs: z.array(evidenceReferenceSchema).min(1) })),
    coverageReview: z.strictObject({
      status: z.enum(['complete', 'incomplete', 'unknown']),
      reason: text,
      evidenceRefs: z.array(evidenceReferenceSchema),
    }),
  })),
  items: z.array(judgmentItemSchema),
  contributions: z.array(z.strictObject({
    id: identifier,
    taskId: identifier,
    domain: domainSchema,
    kind: z.enum(['observed_help', 'observed_burden', 'no_effect_evidence']),
    claim: text,
    evidenceRefs: z.array(evidenceReferenceSchema).min(1),
  })),
}).superRefine((judgments, context) => {
  for (const key of ['tasks', 'items', 'contributions'] as const) {
    if (new Set(judgments[key].map(value => value.id)).size !== judgments[key].length) {
      context.addIssue({ code: 'custom', message: 'ID 不能重复', path: [key] })
    }
  }
  judgments.tasks.forEach((task, index) => {
    if (new Set(task.sessionIds).size !== task.sessionIds.length) context.addIssue({ code: 'custom', message: '任务会话不能重复', path: ['tasks', index, 'sessionIds'] })
    if (new Set(task.requirements.map(requirement => requirement.id)).size !== task.requirements.length) context.addIssue({ code: 'custom', message: '任务要求 ID 不能重复', path: ['tasks', index, 'requirements'] })
    if (task.coverageReview.status === 'complete' && !task.coverageReview.evidenceRefs.length) context.addIssue({ code: 'custom', message: '要求清单完整性核对必须引用原始目标与有效修订', path: ['tasks', index, 'coverageReview', 'evidenceRefs'] })
  })
  judgments.items.forEach((item, index) => {
    if (new Set(item.requirementIds).size !== item.requirementIds.length) context.addIssue({ code: 'custom', message: '评项要求 ID 不能重复', path: ['items', index, 'requirementIds'] })
  })
})

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>
export type JudgmentSet = z.infer<typeof judgmentSetSchema>
export type JudgmentItem = z.infer<typeof judgmentItemSchema>
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>
export type Domain = z.infer<typeof domainSchema>
export type Dimension = JudgmentItem['dimension']

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)]))
  }
  return value
}

/** Hash the validated snapshot, not a mutable path or a judge-generated summary. */
export function bundleDigest(input: unknown) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(evidenceBundleSchema.parse(input)))).digest('hex')
}

export function validateAnalysisInputs(bundleInput: unknown, judgmentInput: unknown) {
  const bundle = evidenceBundleSchema.parse(bundleInput)
  const judgments = judgmentSetSchema.parse(judgmentInput)
  if (judgments.bundleHash !== bundleDigest(bundle)) throw new Error('评审引用的证据快照哈希不一致')
  const tasks = new Map(judgments.tasks.map(task => [task.id, task]))
  const sources = new Map(bundle.sources.map(source => [source.id, source]))
  const evidence = new Map(bundle.evidence.map(item => [item.id, item]))
  for (const task of judgments.tasks) {
    if (task.sessionIds.some(id => !bundle.selection.sessionIds.includes(id))) throw new Error(`任务 ${task.id} 引用了范围外会话`)
  }
  if (judgments.tasks.length) {
    const coveredSessionIds = new Set(judgments.tasks.flatMap(task => task.sessionIds))
    const omitted = bundle.selection.sessionIds.filter(id => !coveredSessionIds.has(id))
    if (omitted.length) throw new Error(`评审未覆盖选定会话：${omitted.join('、')}；不得遗漏失败或未知任务后汇总评分`)
  }
  const checkReference = (reference: EvidenceReference, taskId: string) => {
    const item = evidence.get(reference.evidenceId)
    if (!item) throw new Error(`引用证据不存在：${reference.evidenceId}`)
    if (!item.text.includes(reference.quote)) throw new Error(`引文与原始证据不一致：${reference.evidenceId}`)
    const task = tasks.get(taskId)!
    if (!task.sessionIds.includes(sources.get(item.sourceId)!.sessionId)) throw new Error(`任务 ${taskId} 引用了其他任务会话的证据`)
  }
  for (const item of [...judgments.items, ...judgments.contributions]) {
    if (!tasks.has(item.taskId)) throw new Error(`评审引用的任务不存在：${item.taskId}`)
    for (const reference of item.evidenceRefs) checkReference(reference, item.taskId)
    if ('requirementRefs' in item) {
      for (const reference of item.requirementRefs) checkReference(reference, item.taskId)
      const task = tasks.get(item.taskId)!
      for (const id of item.requirementIds) {
        const requirement = task.requirements.find(requirement => requirement.id === id)
        if (!requirement) throw new Error(`任务 ${item.taskId} 的要求不存在：${id}`)
        if (requirement.domain !== item.domain) throw new Error(`评项 ${item.id} 引用了其他分析领域的要求`)
      }
    }
  }
  for (const task of judgments.tasks) {
    for (const requirement of task.requirements) for (const reference of requirement.sourceRefs) checkReference(reference, task.id)
    for (const reference of task.coverageReview.evidenceRefs) checkReference(reference, task.id)
  }
  return { bundle, judgments }
}
