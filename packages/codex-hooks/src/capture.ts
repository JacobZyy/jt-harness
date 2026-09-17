import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { submissionSchema, timestampSchema } from '@jt-harness/memo/contracts'

export const hookEvents = ['SessionStart', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop'] as const
const identifier = z.string().trim().min(1).max(200)
const absolutePath = z.string().max(4096).refine(isAbsolute, '必须使用绝对路径')
export const hookEventSchema = z.object({
  hook_event_name: z.enum(hookEvents), session_id: identifier, cwd: absolutePath,
  transcript_path: absolutePath.nullable().optional(), turn_id: identifier.optional(),
  agent_id: identifier.optional(), agent_type: identifier.optional(),
  agent_transcript_path: absolutePath.nullable().optional(), source: z.string().optional(),
  model: z.string().optional(),
}).superRefine((event, context) => {
  if (event.hook_event_name.startsWith('Subagent') && !event.agent_id) context.addIssue({ code: 'custom', path: ['agent_id'], message: '子 Agent 事件缺少 agent_id' })
})

export const captureSettingsSchema = z.strictObject({
  workspace: absolutePath, codex_home: absolutePath, env_file: absolutePath, enabled_at: timestampSchema,
  scope: submissionSchema.shape.scope.refine(scope => scope.project_ids.length > 0, '自动采集必须明确指定项目 ID'),
})
export type CaptureSettings = z.infer<typeof captureSettingsSchema>
export const captureSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), received_at: timestampSchema,
  settings: captureSettingsSchema, event: hookEventSchema,
  snapshot: z.strictObject({ original_path: absolutePath, path: absolutePath, end: z.number().int().nonnegative() }).optional(),
})
export type Capture = z.infer<typeof captureSchema>

export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const codexDirectory = (config: { dataDir: string }) => resolve(config.dataDir, 'codex')
export const installationPath = (config: { dataDir: string }, workspace: string) => resolve(codexDirectory(config), 'installations', `${hash(resolve(workspace, '.codex/hooks.json'))}.json`)
export const inside = (root: string, path: string) => {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

export async function readJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Rename is atomic; fsync makes the local handoff survive process termination. */
export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
  try {
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

/** Keep the inode alive if Codex removes the transcript when SessionEnd returns. */
export async function retainTranscript(path: string, settings: CaptureSettings, config: { dataDir: string }) {
  const source = await realpath(path)
  const home = await realpath(settings.codex_home)
  if (!inside(resolve(home, 'sessions'), source) && !inside(resolve(home, 'archived_sessions'), source)) {
    throw new Error('会话文件必须位于指定 CODEX_HOME 的 sessions 或 archived_sessions 中')
  }
  const info = await stat(source)
  if (!info.isFile()) throw new Error('会话来源不是普通文件')
  const target = resolve(codexDirectory(config), 'sources', `${hash(`${source}:${info.dev}:${info.ino}`)}.jsonl`)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try { await link(source, target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const retained = await open(target, 'r')
  try { await retained.sync() } finally { await retained.close() }
  const directory = await open(dirname(target), 'r')
  try { await directory.sync() } finally { await directory.close() }
  return { original_path: source, path: target, end: info.size }
}

export async function captureEvent(input: unknown, settings: CaptureSettings, config: { dataDir: string }) {
  const event = hookEventSchema.parse(input)
  if (!event.agent_id && !inside(settings.workspace, event.cwd)) throw new Error('Hook cwd 不在安装时指定的项目范围内')
  const installation = await readJson(installationPath(config, settings.workspace)) as { disabled?: boolean } | undefined
  if (installation?.disabled) throw new Error('项目采集已卸载；请重新 install 后再采集')
  const path = event.agent_id ? event.agent_transcript_path : event.transcript_path
  // A missing child path is a registration, not an empty completed submission.
  const snapshot = path ? await retainTranscript(path, settings, config).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }) : undefined
  const capture = captureSchema.parse({ version: 1, id: randomUUID(), received_at: new Date().toISOString(), settings, event, snapshot })
  await writeJson(resolve(codexDirectory(config), 'inbox', `${capture.id}.json`), capture)
  return capture
}

export async function captureStatus(config: { dataDir: string }) {
  const directory = codexDirectory(config)
  const list = async (name: string) => {
    try { return (await readdir(resolve(directory, name))).filter(file => file.endsWith('.json')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const [inbox, events, records, errors, evidence, installations] = await Promise.all(['inbox', 'events', 'records', 'record-errors', 'evidence', 'installations'].map(list))
  const sessions = new Map<string, Capture>()
  for (const [folder, names] of [['events', events], ['inbox', inbox]] as const) for (const file of names) {
    const raw = await readJson(resolve(directory, folder, file))
    if (!raw) continue // A concurrent receiver may have moved an inbox item.
    const capture = captureSchema.parse(raw)
    const id = capture.event.agent_id ?? capture.event.session_id
    if (!sessions.has(id) || sessions.get(id)!.received_at < capture.received_at) sessions.set(id, capture)
  }
  return { directory, mode: 'in-session', pending_events: inbox.length, pending_records: records.length, evidence_count: evidence.length,
    delivery_errors: await Promise.all(errors.map(async file => ({ submission_id: file.slice(0, -5), ...await readJson(resolve(directory, 'record-errors', file)) as object }))),
    sessions: [...sessions.values()].map(capture => ({ session_id: capture.event.agent_id ?? capture.event.session_id,
      parent_session_id: capture.event.agent_id ? capture.event.session_id : undefined, scope: capture.settings.scope,
      last_event: capture.event.hook_event_name, received_at: capture.received_at, source_retained: Boolean(capture.snapshot) })),
    installations: await Promise.all(installations.map(file => readJson(resolve(directory, 'installations', file)))) }
}
