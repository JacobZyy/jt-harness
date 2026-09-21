import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { hash, readJson, writeJson } from './capture.ts'
import { transcriptIdentity } from './transcript.ts'
import { mergeHooks, quote, updateHookConfig } from './install.ts'

export const monitorEvents = ['UserPromptSubmit', 'Stop', 'Interrupt']
const eventSchema = z.object({ hook_event_name: z.enum(['UserPromptSubmit', 'Stop', 'Interrupt']),
  session_id: z.string().min(1).max(200), turn_id: z.string().max(200).optional(), model: z.string().max(200).optional(), cwd: z.string(), transcript_path: z.string().nullable().optional() })
export type MonitorUsage = { input_tokens?: number, cached_input_tokens?: number, output_tokens?: number, reasoning_output_tokens?: number, total_tokens?: number }
export interface MonitorReceipt { workspace: string, sessionId: string, turnId: string, model?: string, baseline?: MonitorUsage, event: string, receivedAt: string, transcript: string | null, start: number, end: number, startedAt: string }

/** Bounded lookback avoids attributing the previous turn's cumulative usage to this turn. */
async function usageBefore(path: string, end: number): Promise<MonitorUsage | undefined> {
  const file = await open(path, 'r'), start = Math.max(0, end - 1_048_576)
  try {
    const buffer = Buffer.alloc(end - start)
    await file.read(buffer, 0, buffer.length, start)
    const rows = buffer.toString('utf8').split('\n').slice(start ? 1 : 0)
    for (const line of rows.reverse()) {
      try {
        const row = JSON.parse(line)
        if (row.type === 'event_msg' && row.payload?.type === 'token_count') return row.payload.info?.total_token_usage
      } catch { /* Only complete records in the bounded tail are eligible. */ }
    }
  } finally { await file.close() }
}

export async function configureMonitorHooks(root: string, workspace: string, enabled: boolean) {
  const command = enabled ? [process.execPath, '--', resolve(root, 'bin/jth.mjs'), 'monitor', 'capture', '--workspace', workspace].map(quote).join(' ') : undefined
  await updateHookConfig(resolve(workspace, '.codex/hooks.json'), resolve(workspace, '.jth/backups'), document => mergeHooks(document, command, { marker: 'jth monitor', events: monitorEvents }))
}

/** Keep source locations and counters only; the background exporter reads native events locally. */
export async function captureMonitor(input: unknown, workspace: string, codexHome: string) {
  const event = eventSchema.parse(input), cwd = await realpath(event.cwd), root = await realpath(workspace)
  const child = relative(root, cwd)
  if (child === '..' || child.startsWith('../') || isAbsolute(child)) return null
  const settings = await readJson(resolve(root, '.jth/monitor.json')) as { enabled?: boolean } | undefined
  if (!settings?.enabled) return null
  const receivedAt = new Date().toISOString(), session = hash(event.session_id)
  const path = resolve(root, '.jth/monitor', `session-${session}.json`)
  const prior = await readJson(path) as MonitorReceipt | undefined
  let transcript: string | null = null, end = 0
  if (event.transcript_path) {
    transcript = await realpath(event.transcript_path)
    const parent = await realpath(resolve(codexHome, 'sessions')), within = relative(parent, transcript)
    if (within === '..' || within.startsWith('../') || isAbsolute(within)) throw new Error('监控日志必须位于 CODEX_HOME/sessions')
    end = (await stat(transcript)).size
    if ((await transcriptIdentity(transcript, end)).id !== event.session_id) throw new Error('监控日志会话不匹配')
  }
  const turnId = event.turn_id ?? prior?.turnId ?? `turn-${Date.now()}`
  const start = event.hook_event_name === 'UserPromptSubmit' ? end : prior?.turnId === turnId && prior.transcript === transcript ? Math.min(prior.start, end) : end
  const receipt: MonitorReceipt = { workspace: root, sessionId: event.session_id, turnId, event: event.hook_event_name,
    model: event.model ?? (prior?.turnId === turnId ? prior.model : undefined),
    baseline: event.hook_event_name === 'UserPromptSubmit' && transcript ? await usageBefore(transcript, end) : prior?.turnId === turnId ? prior.baseline : undefined,
    receivedAt, transcript, start, end, startedAt: prior?.turnId === turnId ? prior.startedAt : receivedAt }
  await writeJson(path, receipt)
  const file = resolve(root, '.jth/monitor/pending', `${hash(`${event.session_id}:${turnId}:${event.hook_event_name}`)}.json`)
  await writeJson(file, receipt)
  return file
}
