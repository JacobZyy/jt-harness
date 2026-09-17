import { createReadStream } from 'node:fs'
import { z } from 'zod'
import { timestampSchema } from '@jt-harness/memo/contracts'
import type { Submission } from '@jt-harness/memo/contracts'
import { hash } from './capture.ts'

export type Message = Submission['messages'][number]
const rowSchema = z.object({ type: z.string(), timestamp: timestampSchema, ordinal: z.number().optional(), payload: z.record(z.string(), z.unknown()) })
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const contentText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap(value => {
    const part = object(value)
    return ['text', 'Text', 'input_text', 'output_text'].includes(String(part.type)) && typeof part.text === 'string' ? [part.text] : []
  }).join('\n')
}
const toolText = (value: unknown) => JSON.stringify(value, (_key, item) => {
  if (typeof item === 'string' && /^data:(image|audio|video)\//.test(item)) return '[media omitted]'
  if (item && typeof item === 'object' && ['image', 'audio', 'video'].includes(item.type)) return { type: item.type, media_omitted: true }
  return item
})

/** Consume complete UTF-8 JSONL records only. Incomplete trailing writes stay for the next hook. */
export async function* transcriptLines(path: string, start: number, end: number) {
  if (end <= start) return
  const stream = createReadStream(path, { start, end: end - 1, highWaterMark: 64 * 1024 })
  let pending = Buffer.alloc(0)
  let offset = start
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, Buffer.from(chunk)])
      let newline: number
      while ((newline = pending.indexOf(10)) >= 0) {
        const length = newline + 1
        const line = pending.subarray(0, newline).toString('utf8')
        const next = offset + length
        if (line.trim()) yield { start: offset, end: next, value: rowSchema.parse(JSON.parse(line)) }
        offset = next
        pending = pending.subarray(length)
      }
      if (pending.length > 16 * 1024 * 1024) throw new Error('Codex 单条日志超过 16 MiB；保留游标，需检查来源格式')
    }
  } finally { stream.destroy() }
}

export async function transcriptIdentity(path: string, end: number) {
  for await (const row of transcriptLines(path, 0, end)) {
    if (row.value.type !== 'session_meta') throw new Error('Codex 日志缺少首行 session_meta')
    const meta = row.value.payload
    if (typeof meta.id !== 'string') throw new Error('Codex session_meta 缺少线程 id')
    const spawn = object(object(object(meta.source).subagent).thread_spawn)
    return { id: meta.id, parent: meta.parent_thread_id ?? spawn.parent_thread_id, timestamp: row.value.timestamp }
  }
  throw new Error('Codex 日志尚未写入完整元数据')
}

function splitText(text: string) {
  const parts: string[] = []
  let part = ''
  let bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > 32_000) { parts.push(part); part = ''; bytes = 0 }
    part += character
    bytes += size
  }
  if (part) parts.push(part)
  return parts
}

function itemMessage(item: Record<string, unknown>, child: boolean): { role: Message['role'], text: string } | undefined {
  switch (item.type) {
    case 'UserMessage': return { role: child ? 'assistant' : 'user', text: contentText(item.content) }
    case 'AgentMessage': return { role: 'assistant', text: contentText(item.content) }
    case 'CommandExecution': return { role: 'tool', text: toolText({ tool: 'Bash', command: item.command, status: item.status, exit_code: item.exit_code, output: item.aggregated_output ?? item.formatted_output ?? item.stdout, stderr: item.stderr }) }
    case 'FunctionCallOutput': return { role: 'tool', text: toolText({ tool: item.name, namespace: item.namespace, output: item.output }) }
    case 'FileChange': return { role: 'tool', text: toolText({ tool: 'apply_patch', status: item.status, changes: item.changes, stdout: item.stdout, stderr: item.stderr }) }
    case 'McpToolCall': {
      const result = object(item.result)
      return { role: 'tool', text: toolText({ tool: `${item.server}/${item.tool}`, status: item.status, isError: result.isError,
        text: contentText(result.content), structuredContent: result.structuredContent }) }
    }
    case 'Extension': return { role: 'tool', text: toolText({ tool: item.kind, action: item.action, query: item.query, results: item.results }) }
    case 'Reasoning':
    case 'SubAgentActivity':
    case 'ImageView':
    case 'ContextCompaction': return undefined
    default: throw new Error(`尚未适配 Codex completed item 类型：${String(item.type)}`)
  }
}

/** Use model-visible completed items, never reasoning, injected instructions or compaction summaries. */
export async function* readTranscript(options: { path: string, start: number, end: number, sessionId: string, child: boolean, since: string }) {
  let format: 'items' | 'legacy' | undefined
  for await (const row of transcriptLines(options.path, 0, options.end)) {
    if (row.value.type !== 'event_msg') continue
    if (row.value.payload.type === 'item_completed') { format = 'items'; break }
    if (['user_message', 'agent_message'].includes(String(row.value.payload.type))) { format = 'legacy'; break }
  }
  let recognized = false
  let responseMessages = false
  for await (const row of transcriptLines(options.path, options.start, options.end)) {
    const { payload, type, timestamp, ordinal } = row.value
    if (Date.parse(timestamp) < Date.parse(options.since)) {
      yield { start: row.start, end: row.end, messages: [] as Message[] }
      continue
    }
    let message: { role: Message['role'], text: string } | undefined
    let id: unknown
    if (type === 'event_msg' && payload.type === 'item_completed') {
      recognized = true
      const item = object(payload.item)
      if (!payload.thread_id || payload.thread_id === options.sessionId) message = itemMessage(item, options.child)
      id = item.id
    } else if (type === 'response_item' && payload.type === 'agent_message') {
      recognized = true
      message = { role: 'assistant', text: contentText(payload.content) }
      id = payload.id
    } else if (format === 'legacy' && type === 'event_msg' && ['user_message', 'agent_message'].includes(String(payload.type))) {
      // Legacy Codex event logs have no completed-item envelope.
      recognized = true
      message = { role: payload.type === 'user_message' && !options.child ? 'user' : 'assistant', text: String(payload.message ?? '') }
      id = payload.id
    } else if (format === 'legacy' && type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(String(payload.type))) {
      recognized = true
      message = { role: 'tool', text: toolText({ tool_call_id: payload.call_id, output: payload.output }) }
      id = payload.call_id
    } else if (type === 'response_item' && payload.type === 'message') responseMessages = true
    if (!message?.text.trim()) {
      yield { start: row.start, end: row.end, messages: [] as Message[] }
      continue
    }
    const key = hash(`${options.sessionId}:${typeof id === 'string' ? id : ordinal ?? hash(JSON.stringify(row.value))}`)
    const parts = splitText(message.text)
    yield { start: row.start, end: row.end, messages: parts.map((text, index) => ({
      message_id: `codex-${key}:${index + 1}/${parts.length}`, role: message.role, text, occurred_at: timestamp,
    })) }
  }
  if (options.start === 0 && responseMessages && !recognized) throw new Error('日志尚无可识别的 completed item；保留游标，等待下一次采集或检查 Codex 格式')
}
