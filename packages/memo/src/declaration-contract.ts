import { z } from 'zod'
import { extractionSchema } from './contracts.ts'
import { recordId } from './record-contract.ts'
import type { RecordDraft } from './record-contract.ts'

export const declarationMarker = '<!-- jth-memory'
export const declarationId = (draft: RecordDraft) => recordId(draft).replace(/^record-/, 'declaration-')
const fact = extractionSchema.shape.memories.element.shape
export const declarationSchema = z.strictObject({
  items: z.array(z.strictObject({
    text: z.string().trim().min(1), scope: fact.scope,
    basis: z.enum(['user_statement', 'user_confirmed', 'tool_observation', 'assistant_proposal', 'agent_inference']),
    quote: z.string().trim().min(1).max(240),
    confirmation_quote: z.string().trim().min(1).max(240).optional(),
    change: z.strictObject({ kind: z.enum(['correction', 'supplement', 'conflict']), target: z.uuid() }).optional(),
  })).max(3),
  used: z.array(z.uuid()).max(10).optional(),
}).superRefine((value, context) => {
  if (!value.items.length && !value.used?.length) context.addIssue({ code: 'custom', message: '声明需要新事实或实际采用的记忆 ID' })
  if (value.used && new Set(value.used).size !== value.used.length) context.addIssue({ code: 'custom', message: '采用的记忆 ID 不得重复' })
  if (value.items.reduce((count, item) => count + Array.from(item.text).length, 0) > 500) {
    context.addIssue({ code: 'custom', message: '记忆正文合计超过 500 字符；保留原声明，不自动重写' })
  }
  if (value.items.some(item => item.change && ['assistant_proposal', 'agent_inference'].includes(item.basis))) {
    context.addIssue({ code: 'custom', message: '候选建议不能更正、补充或冲突已发布事实' })
  }
  if (value.items.some(item => item.confirmation_quote && item.basis !== 'user_confirmed')) {
    context.addIssue({ code: 'custom', message: 'confirmation_quote 仅用于 user_confirmed 声明' })
  }
})
export type MemoryDeclaration = z.infer<typeof declarationSchema>

/** Only a trailing declaration outside a code fence is executable; examples remain ordinary text. */
export function parseDeclaration(text: string): MemoryDeclaration | null {
  const start = text.lastIndexOf(declarationMarker)
  if (start < 0) return null
  let fence: { character: string, length: number } | undefined
  for (const line of text.slice(0, start).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!marker) continue
    if (!fence) fence = { character: marker[1][0], length: marker[1].length }
    else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
  }
  if (fence) return null
  if (text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim()) return null
  const block = text.slice(start).trimEnd()
  if (!block.endsWith('-->')) throw new Error('记忆声明未完整结束；原文保留，正常回复不受影响')
  if (Buffer.byteLength(block) > 8192) throw new Error('记忆声明超过 8192 字节')
  return declarationSchema.parse(JSON.parse(block.slice(declarationMarker.length, -3).trim()))
}
