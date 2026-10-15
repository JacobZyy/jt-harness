import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { EvidenceBundle } from '@jacob-z/jt-harness/analysis'
import { sanitizeMemoryText, sanitizeMemoryValue } from '@jacob-z/jt-harness/memo/contracts'
import { codexDirectory, hash, inside } from './capture.ts'
import { canonicalFilePath } from './source-path.ts'
import { transcriptLines } from './transcript.ts'

export interface AnalysisEvidenceOptions {
  codexHome: string
  dataDir: string
  sessionIds?: string[]
  workspace?: string
  since?: string
  until?: string
  cutoff: string
  includeSubmissionIds?: Record<string, string[]>
}
export interface AnalysisSession {
  sessionId: string
  workspacePaths: string[]
  primaryWorkspace: string
  parentSessionId: string | null
  delegated: boolean
  startedAt: string
  sourcePath: string
  sourceRetained: boolean
  submissionIds: string[]
}
export type CollectedAnalysisEvidence = Pick<EvidenceBundle, 'selection' | 'sources' | 'evidence' | 'chainFacts' | 'usage'> & { sessions: AnalysisSession[] }
type TranscriptRow = Exclude<Awaited<ReturnType<ReturnType<typeof transcriptLines>['next']>>['value'], void>
type EvidenceKind = EvidenceBundle['evidence'][number]['kind']
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const instant = (value: string, name: string) => { const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error(`${name} 必须是有效时间`); return time }
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const tokenNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const usageFields = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cachedInputTokens: 'cached_input_tokens', totalTokens: 'total_tokens' } as const
const emptyUsage = (): EvidenceBundle['usage'] => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null })
const normalizePath = (path: string) => realpath(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return resolve(path); throw error })

export function analysisVisibleValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value) && /"(?:base64|image_url|audio_url|video_url)"\s*:|"type"\s*:\s*"(?:image|input_image|output_image|audio|input_audio|output_audio|video)"/.test(value)) {
      try { return JSON.stringify(analysisVisibleValue(JSON.parse(value))) } catch { /* Ordinary tool text is not a serialized media envelope. */ }
    }
    return sanitizeMemoryText(value.replace(/data:(?:image|audio|video)\/[^\s"'<>]+/gi, '[media omitted]'))
  }
  if (Array.isArray(value)) return value.map(analysisVisibleValue)
  if (value && typeof value === 'object') {
    const item = object(value)
    if (['image', 'input_image', 'output_image', 'image_url', 'audio', 'input_audio', 'output_audio', 'video'].includes(String(item.type))) return { type: item.type, omitted: 'media' }
    return sanitizeMemoryValue(Object.fromEntries(Object.entries(item).filter(([key]) => !['reasoning', 'reasoning_content', 'encrypted_content', 'base64', 'blob', 'image_url', 'audio_url', 'video_url'].includes(key)).map(([key, child]) => [key, analysisVisibleValue(child)])))
  }
  return value
}
const jsonText = (value: unknown) => JSON.stringify(analysisVisibleValue(value))
function contentText(value: unknown): string {
  if (typeof value === 'string') return analysisVisibleValue(value) as string
  if (!Array.isArray(value)) return ''
  return value.flatMap(part => {
    const item = object(part)
    return ['text', 'Text', 'input_text', 'output_text'].includes(String(item.type)) && typeof item.text === 'string' ? [analysisVisibleValue(item.text) as string] : []
  }).join('\n')
}
const goalTool = (name: unknown) => typeof name === 'string' && /(?:^|\.)(?:get_goal|create_goal|update_goal|update_plan)$/.test(name)

function visibleRow(row: TranscriptRow, session: AnalysisSession, calls: Map<string, string>): { kind: EvidenceKind, text: string } | null {
  const { type, payload } = row.value
  const delegated = session.delegated || typeof payload.thread_id === 'string' && payload.thread_id !== session.sessionId
  if (type === 'world_state') return { kind: 'session_configuration', text: jsonText(payload) }
  if (type === 'token_usage_record') return { kind: 'usage_detail', text: jsonText(payload) }
  if (type === 'inter_agent_communication_metadata') return { kind: 'delegation', text: jsonText(payload) }
  if (type === 'session_meta') return { kind: 'session_metadata', text: jsonText({ id: payload.id, cwd: payload.cwd, runtime_workspace_roots: payload.runtime_workspace_roots, parent_thread_id: payload.parent_thread_id, source: payload.source }) }
  if (type === 'turn_context') return { kind: 'turn_context', text: jsonText(payload) }
  if (type === 'compacted') return { kind: 'recovery', text: jsonText(payload) }
  const userKind = (text: string) => delegated || /^\s*<realtime_delegation(?:\s|>)/.test(text) ? 'delegated_user_message' : 'human_user_message'
  if (type === 'event_msg') {
    if (payload.type === 'token_count') return { kind: 'usage', text: jsonText(payload) }
    if (payload.type === 'item_completed') {
      const item = object(payload.item), text = contentText(item.content)
      if (item.type === 'UserMessage') return text ? { kind: userKind(text), text } : null
      if (item.type === 'AgentMessage') return text ? { kind: 'assistant_message', text } : null
      if (['Reasoning', 'ImageView'].includes(String(item.type))) return null
      if (item.type === 'ContextCompaction') return { kind: 'recovery', text: jsonText(item) }
      if (item.type === 'HookPrompt') return { kind: 'host_hook', text: jsonText(item) }
      if (item.type === 'SubAgentActivity' || item.type === 'CollabAgentToolCall') return { kind: 'delegation', text: jsonText(item) }
      return { kind: goalTool(item.name) || goalTool(item.tool) ? 'goal_plan' : 'tool_result', text: jsonText(item) }
    }
    if (payload.type === 'user_message' || payload.type === 'agent_message') {
      const text = string(payload.message) ?? ''
      return text ? { kind: payload.type === 'user_message' ? userKind(text) : 'assistant_message', text: analysisVisibleValue(text) as string } : null
    }
    if (['agent_reasoning', 'reasoning', 'reasoning_raw_content'].includes(String(payload.type))) return null
    return { kind: /compact|recover|resum/.test(String(payload.type)) ? 'recovery' : 'session_event', text: jsonText(payload) }
  }
  if (type !== 'response_item') return { kind: 'unrecognized_event', text: jsonText(row.value) }
  if (['reasoning', 'image', 'audio', 'video'].includes(String(payload.type))) return null
  if (payload.type === 'message' || payload.type === 'agent_message') {
    const text = contentText(payload.content)
    if (!text) return null
    if (payload.role === 'user') return { kind: userKind(text), text }
    if (payload.role === 'assistant' || payload.type === 'agent_message') return { kind: 'assistant_message', text }
    return { kind: 'host_instruction', text: jsonText({ role: payload.role, text }) }
  }
  if (['function_call', 'custom_tool_call'].includes(String(payload.type))) {
    if (typeof payload.call_id === 'string' && typeof payload.name === 'string') calls.set(payload.call_id, payload.name)
    return { kind: goalTool(payload.name) ? 'goal_plan' : 'tool_call', text: jsonText(payload) }
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(String(payload.type))) {
    return { kind: goalTool(calls.get(String(payload.call_id))) ? 'goal_plan' : 'tool_result', text: jsonText(payload) }
  }
  return { kind: 'unrecognized_event', text: jsonText(payload) }
}

async function files(directory: string, suffix: string, recursive = false) {
  const entries = await readdir(directory, { recursive, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(suffix)).map(entry => resolve(entry.parentPath, entry.name)).sort()
}

interface Artifact { path: string, raw: Buffer, value: Record<string, unknown>, changedAt: string }
async function artifacts(directory: string, recursive = false): Promise<Artifact[]> {
  return Promise.all((await files(directory, '.json', recursive)).map(async path => {
    const raw = await readFile(path)
    let value: Record<string, unknown>
    try { value = object(JSON.parse(raw.toString('utf8'))) }
    catch { value = { unreadable_json: true } }
    return { path, raw, value, changedAt: (await stat(path)).mtime.toISOString() }
  }))
}

function addEvidence(result: Pick<CollectedAnalysisEvidence, 'sources' | 'evidence'>, session: AnalysisSession, path: string,
  range: { start: number, end: number, sha256: string }, kind: string, text: string, occurredAt: string) {
  const sourceId = `source-${hash(`${session.sessionId}:${path}:${range.start}:${range.end}:${range.sha256}`)}`
  if (!result.sources.some(source => source.id === sourceId)) result.sources.push({ id: sourceId, sessionId: session.sessionId, workspacePath: session.primaryWorkspace, path, ...range })
  const id = `evidence-${hash(`${sourceId}:${kind}:${text}`)}`
  if (!result.evidence.some(item => item.id === id)) result.evidence.push({ id, kind, text, occurredAt, sourceId })
  return id
}

function addFact(result: Pick<CollectedAnalysisEvidence, 'chainFacts'>, session: AnalysisSession, stage: string,
  status: EvidenceBundle['chainFacts'][number]['status'], detail: string, evidenceIds: string[], discriminator = '') {
  const id = `fact-${hash(`${session.sessionId}:${stage}:${discriminator}:${evidenceIds.join(':')}`)}`
  if (!result.chainFacts.some(fact => fact.id === id)) result.chainFacts.push({ id, domain: stage.startsWith('workflow') ? 'workflow' : 'memo', stage, status, detail, evidenceIds })
}

const addArtifactEvidence = (result: Pick<CollectedAnalysisEvidence, 'sources' | 'evidence'>, session: AnalysisSession, artifact: Artifact, kind: string, value: unknown, occurredAt: string) => addEvidence(result, session, artifact.path,
  { start: 0, end: artifact.raw.length, sha256: hash(artifact.raw) }, kind, jsonText(value), occurredAt)

/** Build read-only evidence from existing native logs and local receipts. No judge, network or knowledge writes. */
export async function collectAnalysisEvidence(options: AnalysisEvidenceOptions): Promise<CollectedAnalysisEvidence> {
  if (!options.sessionIds?.length && !(options.workspace && options.since)) throw new Error('选择会话 ID，或同时指定工作目录和 since')
  if (options.sessionIds && new Set(options.sessionIds).size !== options.sessionIds.length) throw new Error('会话 ID 不得重复')
  if (options.workspace && !isAbsolute(options.workspace)) throw new Error('工作目录必须是绝对路径')
  const cutoff = instant(options.cutoff, 'cutoff'), end = Math.min(cutoff, options.until ? instant(options.until, 'until') : cutoff)
  const start = options.since ? instant(options.since, 'since') : -Infinity
  if (start > end) throw new Error('since 晚于分析截止时间')
  const selectedWorkspace = options.workspace ? await normalizePath(options.workspace) : undefined
  const home = await realpath(options.codexHome), directory = codexDirectory(options)
  const declarationArtifacts = (await Promise.all(['declaration-events', 'declaration-errors', 'declaration-inbox'].map(name => artifacts(resolve(directory, name))))).flat()
  const candidates = new Map<string, { path: string, retained: boolean }>()
  for (const folder of ['sessions', 'archived_sessions']) for (const path of await files(resolve(home, folder), '.jsonl', true)) {
    const actual = await canonicalFilePath(path)
    if (!inside(resolve(home, folder), actual)) throw new Error('会话文件超出 CODEX_HOME')
    candidates.set(actual, { path: actual, retained: false })
  }
  for (const artifact of declarationArtifacts) {
    const snapshot = object(object(artifact.value.capture).snapshot)
    if (typeof snapshot.path !== 'string') continue
    const path = await canonicalFilePath(snapshot.path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (path && inside(resolve(directory, 'sources'), path)) candidates.set(path, { path, retained: true })
  }
  const sessions = new Map<string, { session: AnalysisSession, rows: TranscriptRow[], sourceEnd: number }>()
  let unidentifiedMetadata = false
  for (const candidate of [...candidates.values()].sort((a, b) => Number(a.retained) - Number(b.retained) || a.path.localeCompare(b.path))) {
    const size = (await stat(candidate.path)).size
    let first: TranscriptRow | undefined
    try { for await (const row of transcriptLines(candidate.path, 0, size)) { first = row; break } }
    catch (error) {
      if (options.sessionIds?.some(id => basename(candidate.path).includes(id))) throw error
      unidentifiedMetadata = true
      continue
    }
    if (!first || first.value.type !== 'session_meta') { unidentifiedMetadata = true; continue }
    const meta = first.value.payload, id = string(meta.id)
    if (!id) { unidentifiedMetadata = true; continue }
    if (sessions.has(id) || options.sessionIds?.length && !options.sessionIds.includes(id)) continue
    if (meta.runtime_workspace_roots !== undefined && !Array.isArray(meta.runtime_workspace_roots)) throw new Error(`会话 ${id} 绑定工作目录格式无效`)
    const rawRoots = Array.isArray(meta.runtime_workspace_roots) ? meta.runtime_workspace_roots : typeof meta.cwd === 'string' ? [meta.cwd] : []
    if (rawRoots.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error(`会话 ${id} 缺少有效绑定工作目录`)
    const roots = [...new Set(await Promise.all((rawRoots as string[]).map(normalizePath)))]
    const cwd = typeof meta.cwd === 'string' && isAbsolute(meta.cwd) ? await normalizePath(meta.cwd) : undefined
    const primary = cwd ? roots.find(root => root === cwd) ?? roots.find(root => inside(root, cwd)) ?? roots[0] : roots[0]
    if (!primary) { if (options.sessionIds?.includes(id)) throw new Error(`会话 ${id} 没有绑定工作目录`); continue }
    if (selectedWorkspace && !roots.includes(selectedWorkspace)) continue
    if (Date.parse(first.value.timestamp) > end) continue
    const rows: TranscriptRow[] = []
    for await (const row of transcriptLines(candidate.path, 0, size)) rows.push(row)
    const visible = rows.filter(row => { const time = Date.parse(row.value.timestamp); return time >= start && time <= end })
    if (!visible.length) continue
    const spawn = object(object(object(meta.source).subagent).thread_spawn)
    const parent = string(meta.parent_thread_id) ?? string(spawn.parent_thread_id) ?? null
    sessions.set(id, { session: { sessionId: id, workspacePaths: [primary, ...roots.filter(root => root !== primary)], primaryWorkspace: primary,
      parentSessionId: parent, delegated: Boolean(parent || object(meta.source).subagent), startedAt: first.value.timestamp, sourcePath: candidate.path, sourceRetained: candidate.retained, submissionIds: [] }, rows, sourceEnd: size })
  }
  if (options.sessionIds?.some(id => !sessions.has(id))) throw new Error(`未找到所选范围内会话：${options.sessionIds.filter(id => !sessions.has(id)).join(', ')}`)
  if (!sessions.size) throw new Error('所选目录和时间范围没有会话证据')
  const result: CollectedAnalysisEvidence = { selection: { workspacePaths: [...new Set([...sessions.values()].flatMap(value => value.session.workspacePaths))], sessionIds: [...sessions.keys()] },
    sources: [], evidence: [], chainFacts: [], usage: emptyUsage(), sessions: [...sessions.values()].map(value => value.session) }
  const add = (session: AnalysisSession, path: string, range: { start: number, end: number, sha256: string }, kind: string, text: string, at: string) => addEvidence(result, session, path, range, kind, text, at)
  const fact = (session: AnalysisSession, stage: string, status: EvidenceBundle['chainFacts'][number]['status'], detail: string, evidenceIds: string[], discriminator = '') => addFact(result, session, stage, status, detail, evidenceIds, discriminator)
  const addArtifact = (session: AnalysisSession, artifact: Artifact, kind: string, value: unknown, at: string) => addArtifactEvidence(result, session, artifact, kind, value, at)
  const sessionUsages: EvidenceBundle['usage'][] = []
  for (const { session, rows, sourceEnd } of sessions.values()) {
    if (unidentifiedMetadata) fact(session, 'workflow_source_discovery', 'unknown', '存在无法归属会话的来源元数据；没有将其正文作为所选会话证据。', [])
    if (rows.at(-1)!.end < sourceEnd) fact(session, 'workflow_source_completeness', 'unknown', '来源尾部存在尚未完整落盘的 JSONL 行；未将其当作已完成执行证据。', [])
    const calls = new Map<string, string>(), usage = emptyUsage(), invalidFields = new Set<keyof typeof usage>()
    let previous: Record<string, unknown> = Object.fromEntries(Object.values(usageFields).map(field => [field, 0]))
    for (const row of rows) {
      const time = Date.parse(row.value.timestamp)
      const isUsage = row.value.type === 'event_msg' && row.value.payload.type === 'token_count'
      if (time > end) continue
      if (isUsage) {
        const info = object(row.value.payload.info), total = object(info.total_token_usage), last = object(info.last_token_usage)
        for (const [target, field] of Object.entries(usageFields) as [keyof typeof usage, string][]) {
          const current = tokenNumber(total[field]), before = tokenNumber(previous?.[field])
          const delta = current !== null && before !== null && current >= before ? current - before : tokenNumber(last[field])
          if (delta === null) { invalidFields.add(target); usage[target] = null }
          else if (!invalidFields.has(target)) usage[target] = (usage[target] ?? 0) + delta
        }
        previous = total
      }
      const visible = visibleRow(row, session, calls)
      if (!visible?.text.trim()) continue
      const id = add(session, session.sourcePath, { start: row.start, end: row.end, sha256: row.sha256 }, visible.kind, visible.text, row.value.timestamp)
      if (visible.kind === 'unrecognized_event') fact(session, 'workflow_source_format', 'unknown', '存在尚未识别的来源事件；原始可见字段已保留，不能假定完整覆盖。', [id], id)
      if (visible.kind === 'session_configuration') fact(session, 'workflow_session_configuration', 'observed', '宿主保存了会话配置；配置记录不证明 Agent 实际读取全部规则。', [id], id)
    }
    sessionUsages.push(usage)
    const matching = declarationArtifacts.filter(artifact => object(object(artifact.value.capture).event).session_id === session.sessionId)
    if (!matching.length) fact(session, 'collection', 'unknown', '没有此会话的采集回执；不代表没有值得保存的记忆。', [])
    if (declarationArtifacts.some(artifact => artifact.value.unreadable_json)) fact(session, 'collection_integrity', 'unknown', '存在无法归属会话的损坏采集文件；没有将其内容作为所选会话证据。', [])
    const ruleRefs = new Map<string, { at: string, evidenceId: string }>()
    for (const artifact of matching) {
      const capture = object(artifact.value.capture), at = string(capture.received_at)
      if (!at || !Number.isFinite(Date.parse(at))) { fact(session, 'capture_time', 'unknown', '关联采集回执缺少有效时间，无法确认截止前状态。', [], artifact.path); continue }
      if (Date.parse(at) > end) continue
      const observation = object(artifact.value.observation), processedAt = string(observation.processed_at) ?? artifact.changedAt
      const processed = Date.parse(processedAt) <= end
      const id = addArtifact(session, artifact, 'memo_capture', { capture, ...(processed ? { observation: artifact.value.observation, result: artifact.value.result, error: artifact.value.error } : { processing: 'unknown_at_cutoff' }) }, at)
      fact(session, 'capture', 'observed', '主回合来源已交接到本地；Stop 是回合结束，不证明任务完成。', [id], artifact.path)
      const ruleId = string(object(capture.settings).rule_snapshot_id) ?? string(observation.rule_snapshot_id)
      if (ruleId && /^[a-f0-9]{64}$/.test(ruleId)) ruleRefs.set(ruleId, { at, evidenceId: id })
      if (!processed) { fact(session, 'declaration_processing', 'unknown', '截止时间前没有可确认的处理结果。', [id], artifact.path); continue }
      const declared = observation.declaration
      fact(session, 'declaration', declared === 'present' ? 'observed' : declared === 'missing' ? 'missing' : declared === 'invalid' ? 'failed' : 'unknown',
        declared === 'missing' ? '回合未观察到声明；原因未知，不能推断不值得保存。' : `声明状态：${string(declared) ?? '旧回执未记录'}`, [id], artifact.path)
      const decision = object(observation.decision)
      fact(session, 'memory_decision', decision.action === 'record' || decision.action === 'skip' ? 'observed' : 'unknown',
        decision.action ? `明确决定：${decision.action}；${string(decision.reason) ?? '原因未记录'}` : '没有明确记录决定及理由；不能补造当时原因。', [id], artifact.path)
      fact(session, 'declaration_processing', observation.stage === 'failed' || artifact.value.error ? 'failed' : observation.stage === 'staged' ? 'observed' : observation.stage === 'skipped' ? 'not_applicable' : 'unknown',
        string(observation.error) ?? string(artifact.value.error) ?? `处理阶段：${string(observation.stage) ?? '旧回执未记录'}`, [id], artifact.path)
      if (Array.isArray(observation.submission_ids)) session.submissionIds.push(...observation.submission_ids.filter((value): value is string => typeof value === 'string'))
      if (Array.isArray(artifact.value.result)) session.submissionIds.push(...artifact.value.result.flatMap(value => string(object(value).submission_id) ?? []))
    }
    if (!ruleRefs.size) fact(session, 'configured_rules', 'unknown', '没有保留此会话的历史配置快照引用；不能用当前安装规则替代当时规则。', [])
    for (const [ruleId, reference] of ruleRefs) {
      const path = resolve(directory, 'rule-snapshots', `${ruleId}.json`)
      const raw = await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!raw) { fact(session, 'configured_rules', 'unknown', '配置引用的历史规则快照缺失。', [reference.evidenceId], ruleId); continue }
      const snapshot = object(JSON.parse(raw.toString('utf8'))), snapshotFiles = Array.isArray(snapshot.files) ? snapshot.files : []
      const expected = hash(JSON.stringify({ schemaVersion: snapshot.schemaVersion, packageVersion: snapshot.packageVersion, files: snapshot.files }))
      const valid = snapshot.id === ruleId && expected === ruleId && snapshotFiles.every(file => typeof object(file).text === 'string' && object(file).sha256 === hash(object(file).text as string))
      const id = add(session, path, { start: 0, end: raw.length, sha256: hash(raw) }, 'configured_rules', jsonText(snapshot), reference.at)
      fact(session, 'configured_rules', valid ? 'observed' : 'failed', valid ? '历史配置快照可核查；不证明 Agent 实际加载这些规则。' : '历史配置快照哈希不一致。', [id], ruleId)
    }
    fact(session, 'rule_loading', 'unknown', '配置记录不证明实际加载；需执行轨迹中的加载证据。', [])
    session.submissionIds = [...new Set(session.submissionIds)]
  }
  for (const artifact of await artifacts(resolve(directory, 'reads'), true)) {
    const session = sessions.get(String(artifact.value.session_id))?.session, at = string(artifact.value.read_at)
    if (!session) continue
    if (!at || !Number.isFinite(Date.parse(at))) { fact(session, 'memory_read', 'unknown', '关联读取回执缺少有效时间，无法确认截止前状态。', [], artifact.path); continue }
    if (Date.parse(at) > end) continue
    const id = addArtifact(session, artifact, 'memo_read_receipt', artifact.value, at)
    fact(session, 'memory_read', 'observed', '记忆读取回执只证明指定版本被读取；不证明实际采用。', [id], artifact.path)
  }
  await appendAnalysisWriteUsage(result, options, options.includeSubmissionIds ?? {})
  for (const target of Object.keys(usageFields) as (keyof EvidenceBundle['usage'])[]) {
    result.usage[target] = sessionUsages.some(usage => usage[target] === null) ? null : sessionUsages.reduce((sum, usage) => sum + usage[target]!, 0)
  }
  result.evidence.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
  return result
}

/** Add actual database job IDs after the CLI's read-only query, without rescanning native transcripts. */
export async function appendAnalysisWriteUsage(result: CollectedAnalysisEvidence, options: AnalysisEvidenceOptions, includeSubmissionIds: Record<string, string[]>): Promise<void> {
  const cutoff = instant(options.cutoff, 'cutoff'), end = Math.min(cutoff, options.until ? instant(options.until, 'until') : cutoff)
  const directory = codexDirectory(options)
  const submissions = new Map(result.sessions.flatMap(session => [...new Set([...session.submissionIds, ...(includeSubmissionIds[session.sessionId] ?? [])])].map(id => [id, session] as const)))
  for (const artifact of await artifacts(resolve(directory, 'write-usage'))) {
    const session = submissions.get(String(artifact.value.submission_id))
    if (!session) continue
    const at = string(artifact.value.started_at)
    if (!at || !Number.isFinite(Date.parse(at))) { addFact(result, session, 'index_attempt', 'unknown', '关联写入用量记录缺少有效时间。', [], artifact.path); continue }
    if (Date.parse(at) > end) continue
    const complete = string(artifact.value.completed_at), attempts = Array.isArray(artifact.value.embedding_attempts) ? artifact.value.embedding_attempts.filter(attempt => {
      const completed = string(object(attempt).completed_at); return completed && Date.parse(completed) <= end
    }) : []
    const beforeCutoff = complete && Date.parse(complete) <= end
    const id = addArtifactEvidence(result, session, artifact, 'memo_write_usage', { ...artifact.value, embedding_attempts: attempts,
      ...(!beforeCutoff ? { status: 'unknown_at_cutoff', error: null, completed_at: null } : {}) }, at)
    addFact(result, session, 'index_attempt', beforeCutoff ? artifact.value.status === 'failed' ? 'failed' : artifact.value.status === 'indexed' || artifact.value.status === 'already_indexed' ? 'observed' : 'unknown' : 'unknown',
      `单次写入尝试 ${artifact.value.job_attempt ?? '未知'}；Embedding 用量来自 Provider，缺值未知；背景提炼为 0 不含主 Agent 声明成本。`, [id], artifact.path)
  }
  result.evidence.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
}
