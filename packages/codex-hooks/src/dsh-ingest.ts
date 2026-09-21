import { open, readdir, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { submissionSchema } from '@jt-harness/memo/contracts'
import type { Submission } from '@jt-harness/memo/contracts'
import { matchesConfigFile, safeError } from '@jt-harness/memo/config'
import { captureSchema, captureSettingsSchema, codexDirectory, hash, installationPath, readJson, retainTranscript, writeJson } from './capture.ts'
import type { Capture } from './capture.ts'
import { readTranscript, transcriptIdentity } from './transcript.ts'
import type { Message } from './transcript.ts'

const fileSchema = captureSchema.shape.snapshot.unwrap().extend({ offset: z.number().int().nonnegative(), anchor: z.string().optional() })
const streamSchema = z.object({
  version: z.literal(1), session_id: z.string(), parent_session_id: z.string().optional(), agent_type: z.string().optional(),
  settings: captureSettingsSchema, files: z.record(z.string(), fileSchema),
  seen: z.array(z.string()), context: z.array(submissionSchema.shape.messages.element).max(2),
  last_event: z.string(), last_receipt: z.string().optional(), error: z.string().nullable().optional(),
  waiting_for_transcript: z.boolean().optional(),
  pending: z.object({ submission: submissionSchema, file_key: z.string(), offset: z.number() }).optional(),
})
type Stream = z.infer<typeof streamSchema>
type Deliver = (input: Submission) => Promise<{ submission_id: string }>

async function boundaryHash(path: string, offset: number) {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size < offset) throw new Error('Codex 日志被截短；没有重置已确认游标')
    const bytes = Buffer.alloc(Math.min(offset, 256))
    await file.read(bytes, 0, bytes.length, offset - bytes.length)
    return hash(bytes.toString('base64'))
  } finally { await file.close() }
}

/** A saved pending batch is immutable across uncertain receipts and later file growth. */
export async function ingestStream(statePath: string, stream: Stream, deliver: Deliver, signal?: AbortSignal) {
  let accepted = 0
  const save = async () => { signal?.throwIfAborted(); await writeJson(statePath, stream) }
  const publish = async () => {
    const pending = stream.pending!
    signal?.throwIfAborted()
    const receipt = await deliver(pending.submission)
    if (receipt.submission_id !== pending.submission.submission_id) throw new Error('记忆队列返回了不同批次的回执')
    signal?.throwIfAborted()
    stream.seen = [...new Set([...stream.seen, ...pending.submission.messages.filter(message => !message.context_only).map(message => message.message_id)])]
    // Keep conversational context only; tool dumps are available in their original submissions.
    stream.context = pending.submission.messages.filter(message => message.role !== 'tool').slice(-2).map(({ context_only, ...message }) => message)
    const file = stream.files[pending.file_key]
    file.offset = pending.offset
    file.anchor = await boundaryHash(file.path, file.offset)
    stream.last_receipt = receipt.submission_id
    delete stream.pending
    stream.error = null
    await save()
    accepted++
  }
  if (stream.pending) await publish()
  for (const [fileKey, file] of Object.entries(stream.files)) {
    signal?.throwIfAborted()
    const identity = await transcriptIdentity(file.path, file.end)
    if (identity.id !== stream.session_id) throw new Error('日志线程 ID 与 Hook 的来源 ID 不一致')
    if (stream.parent_session_id && identity.parent !== stream.parent_session_id) throw new Error('子 Agent 日志的父会话与 Hook 不一致')
    if (file.anchor && file.anchor !== await boundaryHash(file.path, file.offset)) throw new Error('Codex 日志游标前内容发生变化；保留状态等待检查')
    const since = stream.parent_session_id && Date.parse(identity.timestamp) > Date.parse(stream.settings.enabled_at)
      ? identity.timestamp : stream.settings.enabled_at
    const seen = new Set(stream.seen)
    let messages: Message[] = []
    let bytes = 0
    let cursor = file.offset
    let sourceEnd = file.offset
    let batchStart = file.offset
    let scanned = file.offset
    const flush = async () => {
      if (!messages.length) return
      const context: Message[] = []
      let contextBytes = bytes
      for (const message of [...stream.context].reverse()) {
        const size = Buffer.byteLength(JSON.stringify(message)) + 32
        if (messages.some(next => next.message_id === message.message_id)
          || Date.parse(message.occurred_at!) > Date.parse(messages[0].occurred_at!) || contextBytes + size > 235_000) continue
        context.unshift({ ...message, context_only: true })
        contextBytes += size
      }
      const submission = submissionSchema.parse({
        schema_version: 1,
        submission_id: `codex-${hash(JSON.stringify([stream.settings.scope, stream.session_id, messages.map(message => message.message_id)]))}`,
        source: { provider: 'codex', session_id: stream.session_id, codex: {
          ...(stream.parent_session_id ? { parent_session_id: stream.parent_session_id } : {}),
          ...(stream.agent_type ? { agent_type: stream.agent_type } : {}),
          transcript_path: file.original_path, start_offset: batchStart, end_offset: sourceEnd, parser_version: 1,
        } },
        scope: stream.settings.scope, messages: [...context, ...messages],
      })
      stream.pending = { submission, file_key: fileKey, offset: cursor }
      await save()
      await publish()
      messages = []; bytes = 0; batchStart = cursor
    }
    for await (const row of readTranscript({ path: file.path, start: file.offset, end: file.end, sessionId: stream.session_id, child: Boolean(stream.parent_session_id), since })) {
      signal?.throwIfAborted()
      scanned = row.end
      for (const [index, message] of row.messages.entries()) {
        if (seen.has(message.message_id)) continue
        const size = Buffer.byteLength(JSON.stringify(message))
        if (messages.length && (bytes + size > 165_000 || messages.length >= 100)) await flush()
        messages.push(message)
        seen.add(message.message_id)
        bytes += size
        sourceEnd = row.end
        // A split record stays at its start until its final fragment is accepted.
        cursor = index === row.messages.length - 1 ? row.end : row.start
      }
    }
    await flush()
    file.offset = scanned
    file.anchor = await boundaryHash(file.path, file.offset)
    stream.error = null
    await save()
  }
  return accepted
}

async function jsonFiles(path: string) {
  try { return (await readdir(path)).filter(file => file.endsWith('.json')).map(file => resolve(path, file)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function discoverTranscripts(stream: Stream) {
  const found: string[] = []
  for (const directory of ['sessions', 'archived_sessions']) {
    const root = resolve(stream.settings.codex_home, directory)
    try {
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(stream.session_id)) found.push(resolve(entry.parentPath, entry.name))
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return found.sort()
}

/** Also callable with a fake durable recipient for offline crash/replay checks. */
export async function drainCaptureFiles(config: { dataDir: string, envFile: string, envAliases?: readonly string[] }, deliver: Deliver, signal?: AbortSignal) {
  const directory = codexDirectory(config)
  const reports: { stream: string, error: string }[] = []
  let received = 0
  let accepted = 0
  let waiting = 0
  const events: { path: string, capture: Capture }[] = []
  for (const path of await jsonFiles(resolve(directory, 'inbox'))) {
    try { events.push({ path, capture: captureSchema.parse(await readJson(path)) }) } catch (error) { reports.push({ stream: path, error: safeError(error) }) }
  }
  events.sort((left, right) => left.capture.received_at.localeCompare(right.capture.received_at) || left.capture.id.localeCompare(right.capture.id))
  for (const { path, capture } of events) {
    if (!matchesConfigFile(config, capture.settings.env_file)) continue
    signal?.throwIfAborted()
    const sessionId = capture.event.agent_id ?? capture.event.session_id
    const key = hash(JSON.stringify([capture.settings, sessionId]))
    const statePath = resolve(directory, 'streams', `${key}.json`)
    try {
      const saved = await readJson(statePath)
      const stream: Stream = saved ? streamSchema.parse(saved) : {
        version: 1, session_id: sessionId, parent_session_id: capture.event.agent_id ? capture.event.session_id : undefined,
        agent_type: capture.event.agent_type, settings: capture.settings, files: {}, seen: [], context: [], last_event: capture.event.hook_event_name,
      }
      if (JSON.stringify(stream.settings) !== JSON.stringify(capture.settings)) throw new Error('同一采集来源的安装范围或起点发生变化')
      if (stream.parent_session_id !== (capture.event.agent_id ? capture.event.session_id : undefined)) throw new Error('子 Agent 的父会话发生变化')
      stream.last_event = capture.event.hook_event_name
      if (capture.snapshot) {
        const fileKey = hash(capture.snapshot.path)
        const previous = stream.files[fileKey]
        stream.files[fileKey] = { ...capture.snapshot, offset: previous?.offset ?? 0, anchor: previous?.anchor, end: Math.max(previous?.end ?? 0, capture.snapshot.end) }
      }
      await writeJson(statePath, stream)
      await writeJson(resolve(directory, 'events', `${capture.id}.json`), capture)
      await unlink(path)
      received++
    } catch (error) { reports.push({ stream: sessionId, error: safeError(error) }) }
  }
  // ponytail: scan only registered sessions on wake-up, no watcher or timer.
  // Partition discovery by active project if the personal session registry grows large.
  for (const statePath of await jsonFiles(resolve(directory, 'streams'))) {
    signal?.throwIfAborted()
    let stream: Stream | undefined
    try {
      stream = streamSchema.parse(await readJson(statePath))
      if (!matchesConfigFile(config, stream.settings.env_file)) continue
      const installation = await readJson(installationPath(config, stream.settings.workspace)) as { disabled?: boolean, settings?: { enabled_at: string } } | undefined
      const active = !installation?.disabled && (!installation?.settings || installation.settings.enabled_at === stream.settings.enabled_at)
      for (const path of active ? await discoverTranscripts(stream) : []) {
        const snapshot = await retainTranscript(path, stream.settings, config)
        const identity = await transcriptIdentity(snapshot.path, snapshot.end)
        if (identity.id !== stream.session_id) continue
        const key = hash(snapshot.path)
        stream.files[key] = { ...snapshot, offset: stream.files[key]?.offset ?? 0, anchor: stream.files[key]?.anchor }
      }
      if (!Object.keys(stream.files).length) {
        stream.waiting_for_transcript = true
        stream.error = null
        await writeJson(statePath, stream)
        waiting++
        continue
      }
      stream.waiting_for_transcript = false
      // Hard links retain final records even if the original was removed after SessionEnd.
      if (active) for (const file of Object.values(stream.files)) file.end = (await stat(file.path)).size
      await writeJson(statePath, stream)
      accepted += await ingestStream(statePath, stream, deliver, signal)
    } catch (error) {
      signal?.throwIfAborted()
      const message = safeError(error)
      if (stream) { stream.error = message; await writeJson(statePath, stream) }
      reports.push({ stream: stream?.session_id ?? statePath, error: message })
    }
  }
  return { received, accepted, waiting, failed: reports.length, errors: reports }
}
