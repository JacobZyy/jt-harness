import { readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { declarationMarker, parseDeclaration, evidenceSchema, recordDraftSchema, isRecalledMemory } from '@jacob-z/jt-harness/memo/contracts'
import type { Submission } from '@jacob-z/jt-harness/memo/contracts'
import { matchesConfigFile } from '@jacob-z/jt-harness/memo/config'
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

const readReceiptSchema = z.strictObject({ session_id: z.string().min(1), entry_id: z.uuid(), version: z.string().regex(/^[0-9a-f]{64}$/), read_at: z.iso.datetime(), level: z.enum(['summary', 'evidence', 'full']).optional() })
export async function rememberEntryRead(config: CapturePaths, sessionId: string, entryId: string, version: string, level = 'full') {
  const receipt = readReceiptSchema.parse({ session_id: sessionId, entry_id: entryId, version, read_at: new Date().toISOString(), level })
  await writeJson(resolve(codexDirectory(config), 'reads', hash(sessionId), `${entryId}-${randomUUID()}.json`), receipt)
}

async function readVersion(config: CapturePaths, sessionId: string, target: string, before: string, minimum: 'summary' | 'evidence' | 'full' = 'full') {
  const receipts = []
  for (const file of await jsonFiles(resolve(codexDirectory(config), 'reads', hash(sessionId)))) {
    const receipt = readReceiptSchema.parse(await readJson(file))
    if (receipt.session_id === sessionId && receipt.entry_id === target && receipt.read_at <= before
      && (minimum === 'summary' || !receipt.level || receipt.level === 'full' || (minimum === 'evidence' && receipt.level === 'evidence'))) receipts.push(receipt)
  }
  const latest = receipts.sort((a, b) => a.read_at.localeCompare(b.read_at)).at(-1)
  if (!latest) throw new Error(`记忆尚无本会话所需的读取回执；先 read，当前要求 --level ${minimum}`)
  return latest.version
}

/** Tool envelopes may contain serialized CLI JSON; recalled text cannot become fresh evidence. */
function recalledOutput(value: unknown): boolean {
  if (isRecalledMemory(value)) return true
  if (typeof value === 'string') {
    try { return recalledOutput(JSON.parse(value)) }
    catch { return /"memory_context"\s*:\s*\{[^}]*"kind"\s*:\s*"jth_memory_context"/.test(value.replace(/\\"/g, '"')) }
  }
  return Boolean(value && typeof value === 'object' && Object.values(value).some(recalledOutput))
}

function sourceText(message: Submission['messages'][number]) {
  if (message.role !== 'assistant') return message.text
  try { if (!parseDeclaration(message.text)) return message.text }
  catch { /* A previous malformed declaration is not evidence either. */ }
  const marker = message.text.lastIndexOf(declarationMarker)
  return marker < 0 ? message.text : message.text.slice(0, marker)
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
  const quotes = new Set(declaration.items.flatMap(item => item.confirmation_quote ? [item.quote, item.confirmation_quote] : [item.quote]))
  const matches = new Map<string, Submission['messages']>()
  const recalledIds = new Set<string>()
  for await (const row of readTranscript({ ...options, end: last.start })) {
    if (row.messages[0]?.role === 'tool' && recalledOutput(row.messages.map(message => message.text).join(''))) {
      for (const message of row.messages) recalledIds.add(message.message_id)
    }
    for (const message of row.messages) for (const quote of quotes) {
      if (!sourceText(message).includes(quote)) continue
      const sources = matches.get(quote) ?? []
      sources.push({ ...message, location: { path: snapshot.original_path, start: row.start, end: row.end } })
      matches.set(quote, sources)
    }
  }
  const itemSources = declaration.items.map(item => {
    const sources = matches.get(item.quote)?.filter(message => !message.context_only && (!recalledIds.has(message.message_id) || item.derived_from?.length))
    if (!sources?.length) throw new Error('声明引文未出现在本次回复之前的真实来源中；不会用声明自身充当证据')
    if (!item.confirmation_quote) return [sources.at(-1)!]
    const confirmation = matches.get(item.confirmation_quote)?.findLast(message => message.role === 'user')
    if (!confirmation) throw new Error('确认引文未出现在此前的真实用户消息中')
    const proposal = sources.findLast(message => message.role === 'assistant' && message.location!.end <= confirmation.location!.start)
    if (!proposal) throw new Error('方案引文必须来自用户确认之前的助手消息')
    return [proposal, confirmation]
  })
  const final = { ...last.messages.at(-1)!, location: { path: snapshot.original_path, start: last.start, end: last.end } }
  const source = { provider: 'codex' as const, session_id: event.session_id }
  const run = { session_id: event.session_id, provider: 'codex', model: event.model ?? 'unknown' }
  const primaryScope = settings.workspaces ? workspaceScope([settings.workspaces[0]]) : settings.scope
  const groups = new Map<string, { scope: CaptureSettings['scope'], itemIndexes: number[], used: boolean }>()
  for (const [index, item] of declaration.items.entries()) {
    if (item.workspaces && !settings.workspaces) throw new Error('声明目录缺少本轮可信工作目录快照')
    if (item.workspaces?.some(path => !settings.workspaces!.some(workspace => workspace.path === path))) throw new Error('声明目录不属于本会话绑定工作目录')
    const selected = item.workspaces ? settings.workspaces!.filter(workspace => item.workspaces!.includes(workspace.path)) : undefined
    const scope = selected ? workspaceScope(selected) : primaryScope
    const key = JSON.stringify(scope), group = groups.get(key) ?? { scope, itemIndexes: [], used: false }
    group.itemIndexes.push(index)
    groups.set(key, group)
  }
  if (declaration.used?.length) {
    const key = JSON.stringify(primaryScope), group = groups.get(key) ?? { scope: primaryScope, itemIndexes: [], used: false }
    group.used = true
    groups.set(key, group)
  }
  const used = declaration.used?.length ? await Promise.all(declaration.used.map(async entry_id => ({
    entry_id, read_version: await readVersion(config, event.session_id, entry_id, capture.received_at, 'summary'),
  }))) : undefined
  const drafts = []
  for (const group of groups.values()) {
    const messages = [...new Map([...group.itemIndexes.flatMap(index => itemSources[index]), final].map(message => [message.message_id, message])).values()]
      .sort((a, b) => a.location!.start - b.location!.start)
    const id = `evidence-${hash(JSON.stringify({ source, scope: group.scope, messages, run }))}`
    const evidence = evidenceSchema.parse({ id, submission: { schema_version: 1, submission_id: id, source, scope: group.scope, messages }, run })
    await writeJson(resolve(codexDirectory(config), 'evidence', `${id}.json`), { ...evidence, snapshots: [{ path: snapshot.path, original_path: snapshot.original_path }] })
    const draft = recordDraftSchema.parse({ evidence_id: id, extraction: { schema_version: 1, memories: [], proposals: [], revisions: [] }, changes: [] })
    if (group.used) draft.used = used
    for (const itemIndex of group.itemIndexes) {
      const item = declaration.items[itemIndex]
      const sourceIds = itemSources[itemIndex].map(message => message.message_id)
      const fact = { content: item.text, scope: item.scope, source_message_ids: sourceIds }
      if (item.basis === 'assistant_proposal' || item.basis === 'agent_inference') {
        const proposal_index = draft.extraction.proposals.length
        draft.extraction.proposals.push({ ...fact, basis: item.basis })
        if (item.derived_from) {
          draft.derivations ??= []
          draft.derivations.push({ proposal_index, sources: await Promise.all(item.derived_from.map(async entry_id => ({
            entry_id, read_version: await readVersion(config, event.session_id, entry_id, capture.received_at, 'evidence'),
          }))) })
        }
      }
      else {
        const index = draft.extraction.memories.length
        draft.extraction.memories.push({ ...fact, basis: item.basis })
        if (item.change) draft.changes.push({ kind: item.change.kind, previous_entry_id: item.change.target,
          expected_version: await readVersion(config, event.session_id, item.change.target, capture.received_at), current_memory_index: index,
          revision_index: null, explanation: `主会话声明 ${item.change.kind}：${item.text}`, source_message_ids: sourceIds,
          evidence_quote: item.confirmation_quote ?? item.quote, resolved_revision_conflict_ids: [],
        })
      }
    }
    drafts.push(draft)
  }
  return Promise.all(drafts.map(draft => stageRecord(config, draft, true)))
}

function workspaceScope(workspaces: NonNullable<CaptureSettings['workspaces']>) {
  return { project_ids: [...new Set(workspaces.flatMap(workspace => workspace.project_ids))], business_ids: [...new Set(workspaces.flatMap(workspace => workspace.business_ids))] }
}

/** Invalid declarations remain local diagnostics; this path never asks a model to repair them. */
export async function collectDeclarations(config: CapturePaths) {
  let received = 0, skipped = 0
  const errors: { event_id: string, error: string }[] = []
  for (const file of await jsonFiles(resolve(codexDirectory(config), 'declaration-inbox'))) {
    const capture = captureSchema.parse(await readJson(file))
    if (!matchesConfigFile(config, capture.settings.env_file)) continue
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
