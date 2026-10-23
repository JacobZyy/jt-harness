import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { parseDocument } from 'yaml'
import { extractionSchema } from './contracts.ts'
import { recordId } from './record-contract.ts'
import type { RecordDraft } from './record-contract.ts'

export const declarationMarker = '<!-- jth-memory'
export const declarationId = (draft: RecordDraft) => recordId(draft).replace(/^record-/, 'declaration-')
const fact = extractionSchema.shape.memories.element.shape
export const declarationSchema = z.strictObject({
  items: z.array(z.strictObject({
    text: z.string().trim().min(1), scope: fact.scope,
    workspaces: z.array(z.string().refine(isAbsolute, '工作目录必须使用绝对路径')).min(1).optional(),
    basis: z.enum(['user_statement', 'user_confirmed', 'tool_observation', 'assistant_proposal', 'agent_inference']),
    quote: z.string().trim().min(1).max(240),
    confirmation_quote: z.string().trim().min(1).max(240).optional(),
    derived_from: z.array(z.uuid()).min(1).max(10).optional(),
    change: z.strictObject({ kind: z.enum(['correction', 'supplement', 'conflict']), target: z.uuid() }).optional(),
  })).max(3),
  used: z.array(z.uuid()).max(10).optional(),
  decision: z.strictObject({ action: z.enum(['record', 'skip']), reason: z.string().trim().min(1).max(240) }).optional(),
}).superRefine((value, context) => {
  if (!value.items.length && !value.used?.length && value.decision?.action !== 'skip') context.addIssue({ code: 'custom', message: '声明需要新事实或实际采用的记忆 ID' })
  if (value.decision?.action === 'skip' && value.items.length) context.addIssue({ code: 'custom', message: 'skip 决定不能包含新事实；实际采用的记忆可保留 used' })
  if (value.decision?.action === 'record' && !value.items.length) context.addIssue({ code: 'custom', message: 'record 决定必须包含新事实' })
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
  for (const item of value.items) {
    if (item.workspaces && item.scope !== 'project') {
      context.addIssue({ code: 'custom', message: 'workspaces 仅用于 project 声明' })
    }
    if (item.workspaces && new Set(item.workspaces).size !== item.workspaces.length) {
      context.addIssue({ code: 'custom', message: '工作目录不得重复' })
    }
    if (item.derived_from && !['assistant_proposal', 'agent_inference'].includes(item.basis)) {
      context.addIssue({ code: 'custom', message: 'derived_from 仅用于候选建议或推断；不能替代用户或工具证据' })
    }
    if (item.derived_from && new Set(item.derived_from).size !== item.derived_from.length) {
      context.addIssue({ code: 'custom', message: '派生来源 ID 不得重复' })
    }
  }
})
export type MemoryDeclaration = z.infer<typeof declarationSchema>

export interface DeclarationBlock {
  start: number
  format: 'yaml' | 'json' | 'legacy-json'
  content: string
}

interface LocatedDeclaration extends DeclarationBlock { complete: boolean }

function locateDeclarationBlock(text: string): LocatedDeclaration | null {
  let fence: { character: string, length: number, start: number, contentStart: number, format?: 'yaml' | 'json' } | undefined
  let legacy: LocatedDeclaration | null = null
  let offset = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) {
        if (fence.format && !text.slice(offset + rawLine.length).trim()) {
          return { start: fence.start, format: fence.format, content: text.slice(fence.contentStart, offset), complete: true }
        }
        fence = undefined
      }
    } else if (marker) {
      const declaration = /^(`{3,}|~{3,})(yaml|json)[ \t]+jth-memory[ \t]*$/.exec(line)
      fence = {
        character: marker[1][0], length: marker[1].length, start: offset, contentStart: offset + rawLine.length + 1,
        ...(declaration ? { format: declaration[2] as 'yaml' | 'json' } : {}),
      }
    } else if (line.trimStart().startsWith(declarationMarker)) {
      const start = offset + line.length - line.trimStart().length
      const block = text.slice(start).trimEnd()
      const complete = block.endsWith('-->')
      if (complete || !block.includes('-->')) {
        legacy = { start, format: 'legacy-json', content: block.slice(declarationMarker.length, complete ? -3 : undefined).trim(), complete }
      }
    }
    offset += rawLine.length + 1
  }
  return fence?.format
    ? { start: fence.start, format: fence.format, content: text.slice(fence.contentStart), complete: false }
    : legacy
}

/** Locate declaration boundaries without trusting their syntax, so invalid declarations never become evidence. */
export function findDeclarationBlock(text: string): DeclarationBlock | null {
  const block = locateDeclarationBlock(text)
  if (!block) return null
  const { complete: _complete, ...declaration } = block
  return declaration
}

/** Only trailing marked code fences or legacy declarations outside a code fence are executable; examples remain ordinary text. */
export function parseDeclaration(text: string): MemoryDeclaration | null {
  const block = locateDeclarationBlock(text)
  if (!block) return null
  if (!block.complete) throw new Error('记忆声明未完整结束；原文保留，正常回复不受影响')
  if (Buffer.byteLength(text.slice(block.start).trimEnd()) > 8192) throw new Error('记忆声明超过 8192 字节')
  if (block.format === 'legacy-json') return declarationSchema.parse(JSON.parse(block.content))
  // JSON.parse keeps the JSON fence strict; the YAML document check also rejects duplicate JSON keys.
  if (block.format === 'json') JSON.parse(block.content)
  const document = parseDocument(block.content, { strict: true, uniqueKeys: true, stringKeys: true })
  if (document.errors.length) throw document.errors[0]
  if (document.warnings.length) throw document.warnings[0]
  return declarationSchema.parse(document.toJS({ maxAliasCount: 0 }))
}
