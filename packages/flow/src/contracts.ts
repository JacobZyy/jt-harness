import { z } from 'zod'
import { posix } from 'node:path'

const text = z.string().trim().min(1).max(2000)
const identifier = z.string().trim().min(1).max(200)
export const projectScopeSchema = z.strictObject({ project_ids: z.array(identifier).min(1), business_ids: z.array(identifier).default([]) })
export const locatorSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(2), workspace: text, envFile: text }),
  z.strictObject({ version: z.literal(3), scope: projectScopeSchema }),
])
export const phaseSchema = z.enum(['discussion', 'execution', 'verification', 'completed'])
export const relativePathSchema = z.string().trim().min(1).max(1000).refine(path => (
  !path.startsWith('/') && !path.split(/[\\/]/).includes('..') && !path.includes('\0')
), '路径必须在项目内；使用相对目录或文件路径').transform(path => posix.normalize(path))
export const settingsSchema = z.strictObject({
  version: z.literal(1), workspace: text, envFile: text, projectIds: z.array(text).min(1), businessIds: z.array(text).default([]), installedAt: text,
})
export const createTaskSchema = z.strictObject({
  goal: text, phase: z.enum(['discussion', 'execution']).default('discussion'),
  acceptance: z.array(text).min(1).max(16), scope: z.array(relativePathSchema).min(1).max(20).default(['.']),
  contextFiles: z.array(relativePathSchema).max(16).default([]), checks: z.array(text).max(16).default([]),
  constraints: z.array(text).max(24).default([]),
  steps: z.array(text).max(12).default([]),
})
export const focusSchema = z.strictObject({
  action: text, acceptance: z.array(z.number().int().positive()).min(1).max(16),
  readScope: z.array(relativePathSchema).min(1).max(16), expected: text, hypothesis: text.nullable().default(null),
})
const workSchema = focusSchema.extend({ id: z.uuid(), step: z.number().int().positive().nullable(), contractVersion: z.number().int().positive(), startedAt: text })
export const outcomeSchema = z.enum(['progress', 'failed', 'no-progress', 'blocked'])
export const checkpointSchema = z.strictObject({
  constraint: z.array(text).default([]), decision: z.array(text).default([]), question: z.array(text).default([]),
  done: z.array(text).default([]), resolve: z.array(z.uuid()).default([]),
  next: z.string().trim().max(2000).optional(), phase: z.enum(['discussion', 'execution']).optional(), reason: text.optional(),
  blocked: z.string().trim().max(2000).optional(), check: z.array(text).default([]), context: z.array(relativePathSchema).default([]),
  step: z.array(text).default([]), completeStep: z.number().int().min(1).optional(),
  workId: z.uuid().optional(), outcome: outcomeSchema.optional(), evidence: z.array(text).max(16).default([]),
})
const attemptSchema = z.strictObject({
  work: workSchema, outcome: outcomeSchema, done: z.array(text).min(1).max(16), evidence: z.array(text).max(16),
  next: z.string().max(2000), blocked: z.string().max(2000).nullable(), at: text,
})
const noteSchema = z.strictObject({ id: z.uuid(), text, at: text })
const resultSchema = z.strictObject({ command: text, exitCode: z.number().int().nullable(), signal: z.string().nullable(), timedOut: z.boolean(), elapsedMs: z.number().nonnegative(), log: text })
export const taskSchema = createTaskSchema.extend({
  steps: z.array(z.strictObject({ title: text, completedAt: text.nullable(), evidence: z.array(text) })).max(12).default([]),
  id: z.uuid(), initialGoal: text, phase: phaseSchema, contractVersion: z.number().int().positive(), createdAt: text, updatedAt: text,
  decisions: z.array(noteSchema).max(64), questions: z.array(noteSchema).max(64), progress: z.array(noteSchema).max(256),
  next: z.string().max(2000), blocked: z.string().max(2000).nullable(), summary: z.string().max(4000).nullable(),
  baseline: z.record(z.string(), z.string()),
  work: workSchema.nullable().default(null), attempts: z.array(attemptSchema).max(8).default([]),
  verification: z.strictObject({ id: z.uuid(), contractVersion: z.number().int(), at: text, passed: z.boolean(), snapshot: z.record(z.string(), z.string()), results: z.array(resultSchema) }).nullable(),
  memory: z.strictObject({ key: text, requestedAt: text, refreshedAt: text.nullable(), status: z.enum(['refreshing', 'ready', 'failed']), error: z.string().nullable(),
    entries: z.array(z.strictObject({ id: z.uuid(), content: text, state: text, claimStatus: text, sourceSession: text })).max(5),
  }).nullable(),
}).superRefine((task, context) => {
  const required = JSON.stringify({ goal: task.goal, acceptance: task.acceptance, scope: task.scope, constraints: task.constraints, steps: task.steps.map(step => step.title), ...(task.work ? { work: task.work } : {}) })
  if (Buffer.byteLength(required) > 8000) context.addIssue({ code: 'custom', message: '目标与边界超过 8000 字节；请把独立目标拆成任务，不能截断关键约束' })
})
export type FlowTask = z.infer<typeof taskSchema>
export type FlowSettings = z.infer<typeof settingsSchema>
export type Verification = NonNullable<FlowTask['verification']>
export interface Binding { sessionId: string, taskId: string | null, role: 'owner' | 'observer', parentSessionId: string | null, lastEvent: string, lastSeenAt: string }
