import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { analyzeBundle, bundleDigest, evidenceBundleSchema, judgmentSetSchema, renderAnalysisMarkdown, rubric } from '@jacob-z/jt-harness/analysis'
import type { EvidenceBundle } from '@jacob-z/jt-harness/analysis'
import { analysisVisibleValue, appendAnalysisWriteUsage, collectAnalysisEvidence } from '@jacob-z/jt-harness/codex-hooks'
import { openDatabase, readMemoAnalysis } from '@jacob-z/jt-harness/memo'
import { safeError } from '@jacob-z/jt-harness/memo/config'
import type { Config } from '@jacob-z/jt-harness/memo/config'
import { loadWorkspaceConfig } from './configuration.ts'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const help = `jth analysis prepare --session <id> [--session <id> ...] [--output <directory>]
jth analysis prepare --workspace <root> --since <ISO> [--until <ISO>]
jth analysis evidence <directory|bundle.json> [--id <evidence-id> ...]
jth analysis report <directory|bundle.json> --judgments <file.json>
jth analysis usage --session <id> [--session <id> ...]
jth analysis usage --workspace <root> --since <ISO> [--until <ISO>]

prepare/usage 可用 --codex-home <directory>、--env-file <file>。
日常只采集，分析按需执行；不调用模型、不改原任务、不设 Token 上限。
prepare 冻结原始记录；当前分析会话按 jth-analysis 填写判断，report 校验引用并生成评分。
Token 未知保持 null；原回合用量不能精确归属到单条声明。
`

/** Existing artifacts are immutable: another preparation cannot replace a judge's inputs. */
async function saveExact(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await readFile(path, 'utf8') !== text) throw new Error(`分析文件已存在且内容不同；保留原文件：${path}`)
  }
}

export async function readAnalysisBundle(input: string) {
  const selected = resolve(input)
  const path = (await stat(selected)).isDirectory() ? resolve(selected, 'bundle.json') : selected
  return { path, bundle: evidenceBundleSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
}

async function memoEvidence(config: Config, bundle: Pick<EvidenceBundle, 'selection' | 'sources' | 'evidence' | 'chainFacts'>, cutoff: string) {
  let pool
  try {
    pool = openDatabase(config)
    const rows = await readMemoAnalysis(pool, bundle.selection.sessionIds, cutoff)
    for (const row of rows) {
      const text = JSON.stringify(analysisVisibleValue(row.value)), rawHash = digest(JSON.stringify(row.value))
      const sourceId = `memo-source-${digest(`${row.sessionId}:${row.kind}:${row.id}:${text}`)}`
      const evidenceId = sourceId.replace('memo-source-', 'memo-')
      const workspacePath = bundle.sources.find(source => source.sessionId === row.sessionId)!.workspacePath
      bundle.sources.push({ id: sourceId, sessionId: row.sessionId, workspacePath, path: `postgres:jt_memo/${row.kind}/${row.id}`, sha256: rawHash })
      bundle.evidence.push({ id: evidenceId, kind: `memo_${row.kind}`, text, occurredAt: row.occurredAt, sourceId })
      if (row.kind === 'job') bundle.chainFacts.push({ id: `fact-${evidenceId}`, domain: 'memo', stage: 'index_job',
        status: row.value.later_state_unavailable ? 'unknown' : row.value.status === 'failed' ? 'failed' : 'observed', evidenceIds: [evidenceId],
        detail: row.value.later_state_unavailable ? '任务状态在截止时间之后发生变化；无法从当前队列恢复当时状态。'
          : `实际任务状态 ${String(row.value.status)}；不等同于语义正确。` })
    }
    bundle.chainFacts.push({ id: 'memo-database-snapshot', domain: 'memo', stage: 'database_snapshot', status: 'observed',
      evidenceIds: bundle.evidence.filter(item => item.kind.startsWith('memo_')).map(item => item.id), detail: `只读查询了选定会话；获得 ${rows.length} 条持久化记录。空结果不能证明应该记忆的内容不存在。` })
    return rows
  } catch (error) {
    bundle.chainFacts.push({ id: 'memo-database-snapshot', domain: 'memo', stage: 'database_snapshot', status: 'unknown', evidenceIds: [],
      detail: `持久化结果未确认：${safeError(error, config)}。本地记录仍可分析；不把数据库不可用解释为未记录。` })
    return []
  } finally { await pool?.end() }
}

export function analysisJudgmentTemplate(bundle: EvidenceBundle) {
  return {
    schemaVersion: 1, bundleHash: bundleDigest(bundle),
    judge: { model: null, sessionId: null, rubricVersion: '1', assessedAt: new Date().toISOString() },
    tasks: bundle.selection.sessionIds.map((sessionId, index) => ({
      id: `task-${index + 1}`, title: `待确认任务边界：${sessionId}`, sessionIds: [sessionId], state: 'unknown',
      requirements: [], coverageReview: { status: 'unknown', reason: '尚未对照全部目标及有效用户修订核对要求清单。', evidenceRefs: [] },
    })),
    items: [], contributions: [],
  }
}

export async function writeAnalysisPreparation(bundle: EvidenceBundle, output: string) {
  const bundlePath = resolve(output, 'bundle.json')
  let saved = bundle
  try {
    const existing = (await readAnalysisBundle(bundlePath)).bundle
    const signature = (value: EvidenceBundle) => JSON.stringify({ ...value, cutoff: undefined })
    if (signature(existing) !== signature(bundle)) throw new Error(`输出目录已绑定其他证据；请指定新的 --output：${output}`)
    saved = existing
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await saveExact(bundlePath, json(saved))
  const templatePath = resolve(output, 'judgment-template.json')
  // A filled template is user work. Re-preparing the same bundle never replaces it.
  try { await writeFile(templatePath, json(analysisJudgmentTemplate(saved)), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await saveExact(resolve(output, 'judgment-schema.json'), json(z.toJSONSchema(judgmentSetSchema)))
  await saveExact(resolve(output, 'rubric.json'), json(rubric))
  const index = saved.evidence.map(item => ({ id: item.id, kind: item.kind, occurredAt: item.occurredAt, sourceId: item.sourceId,
    characters: Array.from(item.text).length, preview: Array.from(item.text).slice(0, 180).join('') }))
  await saveExact(resolve(output, 'evidence-index.json'), json(index))
  return { analysis_id: saved.analysisId, bundle_hash: bundleDigest(saved), cutoff: saved.cutoff, bundle: bundlePath,
    judgments_template: templatePath, judgments_schema: resolve(output, 'judgment-schema.json'), evidence_index: resolve(output, 'evidence-index.json'),
    selected: saved.selection, sources: saved.sources.length, evidence: saved.evidence.length, usage: saved.usage, chain_facts: saved.chainFacts,
    next: '在分析会话中使用 jth-analysis 读取全部所选目标和相关原文，确认任务边界，填写判断后运行 jth analysis report。当前没有评分。' }
}

export async function writeAnalysisReport(bundle: EvidenceBundle, judgments: unknown, output: string) {
  const report = analyzeBundle(bundle, judgments)
  const directory = resolve(output, 'reports', digest(json(judgments)))
  await saveExact(resolve(directory, 'judgments.json'), json(judgments))
  await saveExact(resolve(directory, 'report.json'), json(report))
  await saveExact(resolve(directory, 'report.md'), renderAnalysisMarkdown(report))
  return { analysis_id: report.analysisId, bundle_hash: report.bundleHash, report_json: resolve(directory, 'report.json'),
    report_markdown: resolve(directory, 'report.md'), tasks: report.tasks.length, batch: report.batch }
}

export async function analysisMain(root: string, args: string[]) {
  let config: Config | undefined
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      session: { type: 'string', multiple: true }, workspace: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
      'codex-home': { type: 'string' }, 'env-file': { type: 'string' }, output: { type: 'string' },
      judgments: { type: 'string' }, id: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
    } })
    if (values.help || args.length === 0) { process.stdout.write(help); return }
    const [command, operand] = positionals
    const selectionFlags = ['session', 'workspace', 'since', 'until', 'codex-home', 'env-file']
    const allowed: Record<string, string[]> = { prepare: [...selectionFlags, 'output'], usage: selectionFlags, evidence: ['id'], report: ['judgments'] }
    if (!Object.hasOwn(allowed, command)) throw new Error('未知分析命令；使用 jth analysis --help')
    const invalid = Object.keys(values).filter(key => key !== 'help' && !allowed[command].includes(key))
    if (invalid.length) throw new Error(`${command} 不支持：${invalid.join(', ')}`)
    let result: unknown
    if (command === 'evidence' || command === 'report') {
      if (positionals.length !== 2) throw new Error(`${command} 需要一个分析目录或 bundle.json`)
      const { path, bundle } = await readAnalysisBundle(operand)
      if (command === 'evidence') {
        if (!values.id?.length) result = { bundle_hash: bundleDigest(bundle), selection: bundle.selection, sources: bundle.sources,
          evidence: bundle.evidence.map(({ text, ...item }) => ({ ...item, characters: Array.from(text).length })), chain_facts: bundle.chainFacts }
        else result = { bundle_hash: bundleDigest(bundle), evidence: values.id.map(id => {
          const item = bundle.evidence.find(item => item.id === id)
          if (!item) throw new Error(`证据不存在：${id}`)
          return { ...item, source: bundle.sources.find(source => source.id === item.sourceId) }
        }) }
      } else {
        if (!values.judgments) throw new Error('report 需要 --judgments <file.json>')
        result = await writeAnalysisReport(bundle, JSON.parse(await readFile(resolve(values.judgments), 'utf8')), dirname(path))
      }
    } else {
      if (positionals.length !== 1) throw new Error(`${command} 不接受位置参数`)
      config = await loadWorkspaceConfig(root, values['env-file'])
      const now = new Date().toISOString()
      if (values.until) z.iso.datetime({ offset: true }).parse(values.until)
      const cutoff = values.until && Date.parse(values.until) < Date.parse(now) ? new Date(values.until).toISOString() : now
      const options = { codexHome: resolve(values['codex-home'] ?? process.env.CODEX_HOME ?? resolve(homedir(), '.codex')),
        dataDir: config.dataDir, sessionIds: values.session, workspace: values.workspace && resolve(values.workspace), since: values.since, until: values.until, cutoff }
      const collected = await collectAnalysisEvidence(options)
      const { sessions: _sessions, ...evidence } = collected
      if (!evidence.selection.sessionIds.length || !evidence.evidence.length) throw new Error('所选范围没有可分析的完整记录；未生成评分或空快照')
      const rows = await memoEvidence(config, evidence, cutoff)
      await appendAnalysisWriteUsage(collected, options, Object.fromEntries(evidence.selection.sessionIds.map(sessionId => [sessionId,
        rows.filter(row => row.sessionId === sessionId).flatMap(row => row.kind === 'submission' || row.kind === 'job' ? [row.id]
          : row.kind === 'declaration_receipt' && typeof (row.value.result as { submission_id?: unknown })?.submission_id === 'string'
            ? [(row.value.result as { submission_id: string }).submission_id] : [])])))
      if (command === 'usage') {
        result = { selection: evidence.selection, cutoff, session_usage: evidence.usage,
          writes: evidence.evidence.filter(item => ['memo_capture', 'memo_write_usage'].includes(item.kind)).map(item => ({ evidence_id: item.id, kind: item.kind,
            source: evidence.sources.find(source => source.id === item.sourceId), observed: JSON.parse(item.text) })),
          persistence: analysisVisibleValue(rows.filter(row => ['job', 'declaration_receipt', 'index_commit'].includes(row.kind))),
          chain_facts: evidence.chainFacts,
          notice: '后台新增提炼调用为 0；声明生成成本未知；回合用量仅供上下文参考。Embedding 使用实际 Provider 回执，失败和重试分别保存。缓存 Token 不再次相加；null 不是 0。' }
      } else {
        const analysisId = `analysis-${digest(JSON.stringify(evidence)).slice(0, 32)}`
        const bundle = evidenceBundleSchema.parse({ schemaVersion: 1, analysisId, cutoff, ...evidence })
        result = await writeAnalysisPreparation(bundle, resolve(values.output ?? resolve(config.dataDir, 'analysis', analysisId)))
      }
    }
    process.stdout.write(json(result))
  } catch (error) {
    process.stderr.write(json({ error: safeError(error, config) }))
    process.exitCode = 1
  }
}
