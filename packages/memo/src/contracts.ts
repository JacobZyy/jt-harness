import { z } from 'zod'

const text = z.string().min(1).refine(value => value.trim().length > 0, '文本不能为空白')
const id = text.max(200)
const ids = z.array(id).refine(values => new Set(values).size === values.length, 'ID 不能重复')
const sources = ids.min(1)
const scope = z.enum(['user', 'project', 'business', 'current_task', 'unspecified'])
export const timestampSchema = z.iso.datetime({ offset: true })
const evidence = {
  content: text.max(4_000),
  scope,
  source_message_ids: sources,
  // Requested in the Agent schema; intake tolerates absent auxiliary metadata and old checkpoints.
  entities: z.array(text.max(200)).max(20).refine(values => new Set(values).size === values.length).optional(),
  valid_from: timestampSchema.nullable().optional(),
  valid_until: timestampSchema.nullable().optional(),
  time_evidence: z.strictObject({ source_message_id: id, quote: text.max(4000) }).nullable().optional(),
}

export const submissionSchema = z.strictObject({
  schema_version: z.literal(1),
  submission_id: id,
  source: z.strictObject({
    provider: z.literal('codex'),
    session_id: id,
    parent_session_id: id.optional(),
    codex: z.strictObject({
      parent_session_id: id.optional(),
      agent_type: id.optional(),
      transcript_path: text.max(4096),
      start_offset: z.number().int().nonnegative(),
      end_offset: z.number().int().positive(),
      parser_version: z.literal(1),
    }).optional(),
  }),
  scope: z.strictObject({ project_ids: ids, business_ids: ids }),
  review_required: z.boolean().optional(),
  messages: z.array(z.strictObject({
    message_id: id,
    role: z.enum(['user', 'assistant', 'tool']),
    text,
    occurred_at: timestampSchema.optional(),
    context_only: z.boolean().optional(),
    location: z.strictObject({ path: text.max(4096), start: z.number().int().nonnegative(), end: z.number().int().positive() }).optional(),
  })).min(1).max(1_000),
}).superRefine((value, context) => {
  const messageIds = value.messages.map(message => message.message_id)
  if (new Set(messageIds).size !== messageIds.length) {
    context.addIssue({ code: 'custom', path: ['messages'], message: 'message_id 不能重复' })
  }
  const dated = value.messages.filter(message => message.occurred_at !== undefined)
  if (dated.some((message, index) => index > 0 && Date.parse(message.occurred_at!) < Date.parse(dated[index - 1].occurred_at!))) {
    context.addIssue({ code: 'custom', path: ['messages'], message: '已声明的消息发生时间必须与原会话顺序一致' })
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256_000) {
    context.addIssue({ code: 'custom', path: ['messages'], message: '单批材料超过 256000 字节；请按消息边界拆分并保留必要上下文' })
  }
})

export const extractionSchema = z.strictObject({
  schema_version: z.literal(1),
  memories: z.array(z.strictObject({
    ...evidence,
    basis: z.enum(['user_statement', 'user_confirmed', 'tool_observation']),
  })).max(80),
  proposals: z.array(z.strictObject({
    ...evidence,
    basis: z.enum(['assistant_proposal', 'agent_inference']),
  })).max(80),
  revisions: z.array(z.strictObject({
    kind: z.enum(['supplement', 'correction', 'scope_difference', 'conflict']),
    earlier_content: text.max(4_000),
    later_content: text.max(4_000),
    explanation: text.max(2_000),
    source_message_ids: sources,
  })).max(80),
})

const requiredMetadata = { entities: true, valid_from: true, valid_until: true, time_evidence: true } as const
export const agentExtractionSchema = extractionSchema.extend({
  memories: z.array(extractionSchema.shape.memories.element.required(requiredMetadata)).max(80),
  proposals: z.array(extractionSchema.shape.proposals.element.required(requiredMetadata)).max(80),
})

export const optionsSchema = z.strictObject({
  provider: id,
  model: id,
  // Decode historical queue snapshots only; the runtime never forwards these controls.
  reasoningEffort: text.optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).default(180_000),
  dshBin: text.optional(),
  dshHome: text.optional(),
})

export type Submission = z.infer<typeof submissionSchema>
export type Extraction = z.infer<typeof extractionSchema>
export type MemoryAgentOptions = z.input<typeof optionsSchema>

/** Validate model JSON and bind every citation to this exact input batch. */
export function parseExtraction(response: string, submission: Submission): Extraction {
  const extraction = extractionSchema.parse(JSON.parse(response))
  const messages = new Map(submission.messages.map(message => [message.message_id, message]))
  for (const item of [...extraction.memories, ...extraction.proposals, ...extraction.revisions]) {
    for (const source of item.source_message_ids) {
      if (!messages.has(source)) throw new Error(`模型引用了不存在的消息：${source}`)
    }
    if ('scope' in item) {
      if (item.scope === 'project' && submission.scope.project_ids.length === 0) {
        throw new Error('模型声明了未提供的项目范围')
      }
      if (item.valid_from && item.valid_until && Date.parse(item.valid_until) <= Date.parse(item.valid_from)) throw new Error('事实失效时间必须晚于生效时间')
      if (item.valid_from || item.valid_until) {
        const evidence = item.time_evidence
        if (!evidence || !item.source_message_ids.includes(evidence.source_message_id)
          || !messages.get(evidence.source_message_id)!.text.includes(evidence.quote)) throw new Error('明确的生效/失效时间必须附带引用消息中的时间原文')
      } else if (item.time_evidence) throw new Error('未声明有效时间时不应附带时间证据')
      if (item.scope === 'business' && submission.scope.business_ids.length === 0) {
        throw new Error('模型声明了未提供的业务范围')
      }
    }
  }
  return extraction
}
