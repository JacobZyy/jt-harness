import { transcriptLines } from './transcript.ts'
import type { MonitorReceipt, MonitorUsage } from './monitor.ts'
export interface TurnMetrics { model?: string, usageObserved: boolean, input: number, cached: number, output: number, reasoning: number,
  requests: { ended: string, model?: string, input: number, cached: number, output: number, reasoning: number }[],
  tools: { name: string, started: string, ended: string, failed?: boolean }[], truncatedTools: number }
const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'] as const

/** Native JSONL is read locally. Prompts, reasoning text and tool inputs/outputs never enter spans. */
export async function monitorMetrics(receipt: MonitorReceipt): Promise<TurnMetrics> {
  const result: TurnMetrics = { model: receipt.model, usageObserved: false, input: 0, cached: 0, output: 0, reasoning: 0, requests: [], tools: [], truncatedTools: 0 }
  if (!receipt.transcript || receipt.end <= receipt.start) return result
  let total = receipt.baseline
  const usage: Record<typeof fields[number], number> = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }
  const pending = new Map<string, { name: string, started: string }>()
  const nativeTools: TurnMetrics['tools'] = []
  for await (const row of transcriptLines(receipt.transcript, receipt.start, receipt.end)) {
    const { type, payload, timestamp } = row.value
    if (type === 'turn_context' && typeof payload.model === 'string') result.model = payload.model
    if (type === 'event_msg' && payload.type === 'item_completed') {
      const item = payload.item as { type?: string, name?: string, server?: string, tool?: string, status?: string, exit_code?: number } | undefined
      const names: Record<string, string> = { CommandExecution: 'exec_command', FileChange: 'apply_patch', McpToolCall: `${item?.server}/${item?.tool}`, FunctionCallOutput: item?.name ?? 'function_call' }
      if (item?.type && names[item.type] && typeof payload.started_at_ms === 'number' && typeof payload.completed_at_ms === 'number') {
        if (nativeTools.length < 1000) nativeTools.push({ name: names[item.type], started: new Date(payload.started_at_ms).toISOString(), ended: new Date(payload.completed_at_ms).toISOString(),
          failed: item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) })
        else result.truncatedTools++
      }
    }
    if (type === 'event_msg' && payload.type === 'token_count') {
      const info = payload.info as { total_token_usage?: MonitorUsage, last_token_usage?: MonitorUsage } | undefined
      const next = info?.total_token_usage
      if (next) {
        result.usageObserved = true
        const delta = fields.map(field => Math.max(0, total ? (next[field] ?? 0) - (total[field] ?? 0) : info?.last_token_usage?.[field] ?? 0))
        fields.forEach((field, index) => { usage[field] += delta[index] })
        if (delta.some(value => value > 0)) result.requests.push({ ended: timestamp, model: result.model, input: delta[0], cached: delta[1], output: delta[2], reasoning: delta[3] })
        total = next
      }
    }
    if (type !== 'response_item' || typeof payload.call_id !== 'string') continue
    if (['function_call', 'custom_tool_call'].includes(String(payload.type)) && typeof payload.name === 'string') {
      if (pending.size < 1000) pending.set(payload.call_id, { name: payload.name, started: timestamp })
      else result.truncatedTools++
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(String(payload.type))) {
      const call = pending.get(payload.call_id)
      if (call) {
        if (result.tools.length < 1000) result.tools.push({ ...call, ended: timestamp })
        else result.truncatedTools++
        pending.delete(payload.call_id)
      }
    }
  }
  for (const call of pending.values()) if (result.tools.length < 1000) result.tools.push({ ...call, ended: receipt.receivedAt })
  return { ...result, tools: nativeTools.length ? nativeTools : result.tools, input: usage.input_tokens, cached: usage.cached_input_tokens, output: usage.output_tokens, reasoning: usage.reasoning_output_tokens }
}
