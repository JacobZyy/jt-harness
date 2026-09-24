import { readdir, stat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evidenceSchema, recordDraftSchema, recordId, declarationId, parseExtraction, submissionSchema } from '@jacob-z/jt-harness/memo/contracts'
import type { Evidence, RecordDraft, Submission } from '@jacob-z/jt-harness/memo/contracts'
import { matchesConfigFile } from '@jacob-z/jt-harness/memo/config'
import { captureSchema, codexDirectory, hash, inside, readJson, retainTranscript, writeJson } from './capture.ts'
import { readTranscript, transcriptIdentity } from './transcript.ts'

export interface CapturePaths { dataDir: string, envFile: string, envAliases?: readonly string[] }
async function files(directory: string) {
  try { return (await readdir(directory)).filter(name => name.endsWith('.json')).map(name => resolve(directory, name)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Preserve receipts as source registrations. No conversation is sent to an extraction model. */
export async function registerCaptures(config: CapturePaths) {
  let received = 0
  for (const path of await files(resolve(codexDirectory(config), 'inbox'))) {
    const event = captureSchema.parse(await readJson(path))
    if (!matchesConfigFile(config, event.settings.env_file)) continue
    const target = resolve(codexDirectory(config), 'events', `${event.id}.json`)
    await writeJson(target, event)
    const { unlink } = await import('node:fs/promises')
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
    received++
  }
  return { received }
}

export async function prepareEvidence(config: CapturePaths, sessionId: string, options: { limit?: number, includeTools?: boolean, before?: string, messageIds?: string[] } = {}) {
  const limit = options.messageIds?.length ?? options.limit ?? 12
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('证据条数必须为 1..40')
  const captures = []
  for (const directory of ['inbox', 'events']) for (const path of await files(resolve(codexDirectory(config), directory))) {
    const value = captureSchema.parse(await readJson(path))
    if ((value.event.agent_id ?? value.event.session_id) === sessionId && matchesConfigFile(config, value.settings.env_file)) captures.push(value)
  }
  captures.sort((a, b) => a.received_at.localeCompare(b.received_at))
  const latest = captures.at(-1)
  if (!latest) throw new Error('该会话尚未登记；请恢复会话，让 SessionStart 先提供来源信息')
  const registrations = captures.filter(item => JSON.stringify(item.settings.scope) === JSON.stringify(latest.settings.scope))
  const paths = new Map(registrations.flatMap(item => item.snapshot ? [[item.snapshot.path, item.snapshot.original_path] as const] : []))
  // SubagentStart can arrive before the child transcript exists. Discover only this registered ID.
  if (!paths.size) for (const folder of ['sessions', 'archived_sessions']) {
    const root = resolve(latest.settings.codex_home, folder)
    try {
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
          const path = resolve(entry.parentPath, entry.name)
          paths.set(path, path)
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const messages = new Map<string, Submission['messages'][number]>()
  const snapshots: { path: string, original_path: string }[] = []
  for (const [path, original] of paths) {
    const retained = inside(resolve(codexDirectory(config), 'sources'), path) ? { path, original_path: original } : await retainTranscript(path, latest.settings, config)
    snapshots.push(retained)
    const end = (await stat(retained.path)).size
    const identity = await transcriptIdentity(retained.path, end)
    if (identity.id !== sessionId) throw new Error('日志线程与登记的会话不一致')
    if (latest.event.agent_id && identity.parent !== latest.event.session_id) throw new Error('子 Agent 的父会话不一致')
    const since = latest.event.agent_id && Date.parse(identity.timestamp) > Date.parse(latest.settings.enabled_at) ? identity.timestamp : latest.settings.enabled_at
    for await (const row of readTranscript({ path: retained.path, start: 0, end, sessionId, child: Boolean(latest.event.agent_id), since })) {
      for (const message of row.messages) {
        if (message.role === 'tool' && !options.includeTools) continue
        messages.set(message.message_id, { ...message, location: { path: original, start: row.start, end: row.end } })
      }
    }
  }
  const selected: Submission['messages'] = []
  let bytes = 0
  let ordered = [...messages.values()].sort((a, b) => Date.parse(a.occurred_at!) - Date.parse(b.occurred_at!))
  if (options.before) {
    const index = ordered.findIndex(message => message.message_id === options.before)
    if (index < 0) throw new Error('分页位置不是该会话中的消息')
    ordered = ordered.slice(0, index)
  }
  if (options.messageIds?.length) {
    if (new Set(options.messageIds).size !== options.messageIds.length || options.messageIds.some(id => !messages.has(id))) throw new Error('消息 ID 重复或不属于当前可用来源')
    ordered = ordered.filter(message => options.messageIds!.includes(message.message_id))
  }
  for (const message of [...ordered].reverse()) {
    const size = Buffer.byteLength(JSON.stringify(message))
    if (selected.length >= limit || bytes + size > 180_000) break
    selected.unshift(message); bytes += size
  }
  if (options.messageIds?.length && selected.length !== options.messageIds.length) throw new Error('指定来源超过单批证据预算，请拆分事实和来源')
  if (!selected.length) throw new Error('尚无完整的可引用消息；不会猜测来源或提交空事实')
  const source = { provider: 'codex' as const, session_id: sessionId,
    ...(latest.event.agent_id ? { parent_session_id: latest.event.session_id } : {}),
  }
  const run = { session_id: sessionId, provider: 'codex', model: latest.event.model ?? 'unknown' }
  const id = `evidence-${hash(JSON.stringify({ source, scope: latest.settings.scope, messages: selected, run }))}`
  const evidence = evidenceSchema.parse({ id, submission: { schema_version: 1, submission_id: id, source, scope: latest.settings.scope, messages: selected }, run })
  await writeJson(resolve(codexDirectory(config), 'evidence', `${id}.json`), { ...evidence, snapshots })
  return { evidence_id: id, scope: evidence.submission.scope, source: evidence.submission.source,
    messages: selected.map(({ text, ...message }) => ({ ...message, preview: text.slice(0, 400), characters: text.length })),
    truncated: selected.length < ordered.length, next_before: selected.length < ordered.length ? selected[0].message_id : null,
  }
}

export async function readEvidence(config: CapturePaths, id: string) {
  if (!/^evidence-[0-9a-f]{64}$/.test(id)) throw new Error('无效的证据回执 ID')
  const raw = await readJson(resolve(codexDirectory(config), 'evidence', `${id}.json`)) as Record<string, unknown>
  if (!raw) throw new Error('证据回执不存在；请重新 prepare')
  const { snapshots: rawSnapshots, ...stored } = raw
  const evidence = evidenceSchema.parse(stored)
  const { source, scope, messages } = evidence.submission
  if (`evidence-${hash(JSON.stringify({ source, scope, messages, run: evidence.run }))}` !== id || evidence.id !== id) throw new Error('证据快照发生变化；请重新 prepare')
  if (!Array.isArray(rawSnapshots)) throw new Error('证据缺少运行时来源文件')
  const remaining = new Map(messages.map(message => [message.message_id, message]))
  for (const snapshot of rawSnapshots as { path: string, original_path: string }[]) {
    if (!inside(await realpath(resolve(codexDirectory(config), 'sources')), await realpath(snapshot.path))) throw new Error('证据引用了采集区以外的文件')
    const selected = messages.filter(message => message.location?.path === snapshot.original_path)
    if (!selected.length) continue
    const identity = await transcriptIdentity(snapshot.path, (await stat(snapshot.path)).size)
    if (identity.id !== source.session_id || identity.parent !== source.parent_session_id) throw new Error('证据文件的父子会话身份不匹配')
    for await (const row of readTranscript({ path: snapshot.path, start: Math.min(...selected.map(message => message.location!.start)),
      end: Math.max(...selected.map(message => message.location!.end)), sessionId: source.session_id, child: Boolean(source.parent_session_id), since: '1970-01-01T00:00:00Z' })) {
      for (const message of row.messages) {
        const expected = remaining.get(message.message_id)
        if (!expected) continue
        if (expected.text !== message.text || expected.role !== message.role || expected.occurred_at !== message.occurred_at
          || expected.location!.start !== row.start || expected.location!.end !== row.end) throw new Error('候选证据与原始会话记录不一致')
        remaining.delete(message.message_id)
      }
    }
  }
  if (remaining.size) throw new Error('引用消息未在原始会话中找到')
  return evidence
}

export async function stageRecord(config: CapturePaths, input: RecordDraft, declaration = false) {
  const draft = recordDraftSchema.parse(input)
  const evidence = await readEvidence(config, draft.evidence_id)
  parseExtraction(JSON.stringify(draft.extraction), evidence.submission)
  const id = declaration ? declarationId(draft) : recordId(draft)
  await writeJson(resolve(codexDirectory(config), 'records', `${id}.json`), { draft, evidence_id: evidence.id, env_file: config.envFile, ...(declaration ? { declaration: true } : {}) })
  return { submission_id: id, status: 'staged' }
}

/** The receiver is supplied by the CLI; this adapter owns no SQL or DSH configuration. */
export async function deliverRecords(config: CapturePaths, accept: (draft: RecordDraft, evidence: Evidence, declaration?: boolean) => Promise<unknown>) {
  const accepted: unknown[] = [], errors: { submission_id: string, error: string }[] = []
  for (const path of await files(resolve(codexDirectory(config), 'records'))) {
    const raw = await readJson(path) as { draft: RecordDraft, env_file: string, declaration?: boolean }
    if (!matchesConfigFile(config, raw?.env_file)) continue
    const id = path.slice(path.lastIndexOf('/') + 1, -5)
    try {
      const draft = recordDraftSchema.parse(raw.draft)
      if ((raw.declaration ? declarationId(draft) : recordId(draft)) !== id) throw new Error('候选文件身份不匹配')
      const receipt = await accept(draft, await readEvidence(config, draft.evidence_id), raw.declaration)
      await writeJson(resolve(codexDirectory(config), 'receipts', `${id}.json`), receipt)
      const { unlink } = await import('node:fs/promises')
      await unlink(path)
      await unlink(resolve(codexDirectory(config), 'record-errors', `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error })
      accepted.push(receipt)
    } catch (error) {
      const message = error instanceof Error ? error.message : '提交失败'
      errors.push({ submission_id: id, error: message })
      await writeJson(resolve(codexDirectory(config), 'record-errors', `${id}.json`), { error: message })
    }
  }
  return { accepted, errors }
}
