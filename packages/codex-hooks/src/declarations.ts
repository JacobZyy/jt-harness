import { readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { declarationMarker, parseDeclaration, evidenceSchema, recordDraftSchema } from '@jt-harness/memo/contracts'
import type { Submission } from '@jt-harness/memo/contracts'
import { captureEvent, captureSchema, codexDirectory, hash, hookEventSchema, readJson, writeJson } from './capture.ts'
import type { Capture, CaptureSettings } from './capture.ts'
import { readTranscript, transcriptIdentity } from './transcript.ts'
import { stageRecord } from './evidence.ts'
import type { CapturePaths } from './evidence.ts'

async function jsonFiles(directory: string) {
  try { return (await readdir(directory)).filter(file => file.endsWith('.json')).map(file => resolve(directory, file)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

/** Stop persists source pointers only. Parsing and database/network work belong to the detached worker. */
export async function captureDeclaration(input: unknown, settings: CaptureSettings, config: CapturePaths) {
  const event = hookEventSchema.parse(input)
  if (event.hook_event_name !== 'Stop' || event.agent_id) return null
  if (event.last_assistant_message !== undefined && !event.last_assistant_message.includes(declarationMarker)) return null
  if (event.last_assistant_message !== undefined) {
    try { if (!parseDeclaration(event.last_assistant_message)) return null } catch { /* Keep malformed declarations for background diagnostics. */ }
  }
  return captureEvent(event, settings, config, 'declaration-inbox')
}

const readReceiptSchema = z.strictObject({ session_id: z.string().min(1), entry_id: z.uuid(), version: z.string().regex(/^[0-9a-f]{64}$/), read_at: z.iso.datetime() })
export async function rememberEntryRead(config: CapturePaths, sessionId: string, entryId: string, version: string) {
  const receipt = readReceiptSchema.parse({ session_id: sessionId, entry_id: entryId, version, read_at: new Date().toISOString() })
  await writeJson(resolve(codexDirectory(config), 'reads', hash(sessionId), `${entryId}-${randomUUID()}.json`), receipt)
}

async function readVersion(config: CapturePaths, sessionId: string, target: string, before: string) {
  const receipts = []
  for (const file of await jsonFiles(resolve(codexDirectory(config), 'reads', hash(sessionId)))) {
    const receipt = readReceiptSchema.parse(await readJson(file))
    if (receipt.session_id === sessionId && receipt.entry_id === target && receipt.read_at <= before) receipts.push(receipt)
  }
  const latest = receipts.sort((a, b) => a.read_at.localeCompare(b.read_at)).at(-1)
  if (!latest) throw new Error('更正目标尚无本会话的读取回执；原声明保留，先 read 旧记忆并在后续回复重新声明')
  return latest.version
}

async function prepareDeclaration(capture: Capture, config: CapturePaths) {
  const { snapshot, event, settings } = capture
  if (!snapshot) throw new Error('声明缺少已保留的来源文件；等待有效的 Stop 来源')
  const identity = await transcriptIdentity(snapshot.path, snapshot.end)
  if (identity.id !== event.session_id || identity.parent) throw new Error('声明来源不是当前主会话')
  const options = { path: snapshot.path, start: 0, end: snapshot.end, sessionId: event.session_id, child: false, since: settings.enabled_at }
  let last: { start: number, end: number, messages: Submission['messages'], text: string } | undefined
  for await (const row of readTranscript(options)) {
    if (row.messages[0]?.role === 'assistant') last = { ...row, text: row.messages.map(message => message.text).join('') }
  }
  if (!last) return null
  if (event.last_assistant_message !== undefined && event.last_assistant_message !== last.text) throw new Error('Stop 回复与已落盘日志尚不一致；保留事件等待恢复')
  const declaration = parseDeclaration(last.text)
  if (!declaration) return null
  const matches = new Map<string, Submission['messages'][number]>()
  for await (const row of readTranscript({ ...options, end: last.start })) {
    for (const message of row.messages) for (const item of declaration.items) {
      if (message.text.includes(item.quote)) matches.set(item.quote, { ...message, location: { path: snapshot.original_path, start: row.start, end: row.end } })
    }
  }
  if (declaration.items.some(item => !matches.has(item.quote))) throw new Error('声明引文未出现在本次回复之前的真实来源中；不会用声明自身充当证据')
  const final = { ...last.messages.at(-1)!, location: { path: snapshot.original_path, start: last.start, end: last.end } }
  const messages = [...new Map([...matches.values(), final].map(message => [message.message_id, message])).values()]
    .sort((a, b) => a.location!.start - b.location!.start)
  const source = { provider: 'codex' as const, session_id: event.session_id }
  const run = { session_id: event.session_id, provider: 'codex', model: event.model ?? 'unknown' }
  const id = `evidence-${hash(JSON.stringify({ source, scope: settings.scope, messages, run }))}`
  const evidence = evidenceSchema.parse({ id, submission: { schema_version: 1, submission_id: id, source, scope: settings.scope, messages }, run })
  await writeJson(resolve(codexDirectory(config), 'evidence', `${id}.json`), { ...evidence, snapshots: [{ path: snapshot.path, original_path: snapshot.original_path }] })
  const draft = recordDraftSchema.parse({ evidence_id: id, extraction: { schema_version: 1, memories: [], proposals: [], revisions: [] }, changes: [] })
  for (const item of declaration.items) {
    const message = matches.get(item.quote)!
    const fact = { content: item.text, scope: item.scope, source_message_ids: [message.message_id] }
    if (item.basis === 'assistant_proposal' || item.basis === 'agent_inference') draft.extraction.proposals.push({ ...fact, basis: item.basis })
    else {
      const index = draft.extraction.memories.length
      draft.extraction.memories.push({ ...fact, basis: item.basis })
      if (item.change) draft.changes.push({ kind: item.change.kind, previous_entry_id: item.change.target,
        expected_version: await readVersion(config, event.session_id, item.change.target, capture.received_at), current_memory_index: index,
        revision_index: null, explanation: `主会话声明 ${item.change.kind}：${item.text}`, source_message_ids: [message.message_id],
        evidence_quote: item.quote, resolved_revision_conflict_ids: [],
      })
    }
  }
  return stageRecord(config, draft, true)
}

/** Invalid declarations remain local diagnostics; this path never asks a model to repair them. */
export async function collectDeclarations(config: CapturePaths) {
  let received = 0, skipped = 0
  const errors: { event_id: string, error: string }[] = []
  for (const file of await jsonFiles(resolve(codexDirectory(config), 'declaration-inbox'))) {
    const capture = captureSchema.parse(await readJson(file))
    if (capture.settings.env_file !== config.envFile) continue
    try {
      const staged = await prepareDeclaration(capture, config)
      await writeJson(resolve(codexDirectory(config), 'declaration-events', `${capture.id}.json`), { capture, result: staged ?? { status: 'skipped' } })
      await unlink(file)
      await unlink(resolve(codexDirectory(config), 'declaration-errors', `${capture.id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (staged) received++; else skipped++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await writeJson(resolve(codexDirectory(config), 'declaration-errors', `${capture.id}.json`), { capture, error: message })
      await unlink(file)
      errors.push({ event_id: capture.id, error: message })
    }
  }
  return { received, skipped, errors }
}
