import { createReadStream } from 'node:fs'
import { parseArgs } from 'node:util'
import { runIndexWorker } from '@jt-harness/memo'
import { connectDatabase } from './postgres.ts'
import { loadWorkspaceConfig } from './configuration.ts'
import type { Pool } from '@jt-harness/memo'
import { optionsSchema, submissionSchema, timestampSchema } from '@jt-harness/memo/contracts'
import { executionProfile, loadConfig, safeError } from '@jt-harness/memo/config'
import type { Config } from '@jt-harness/memo/config'
import { scopeFilterSchema } from '@jt-harness/memo'
import { prepareDatabase } from '@jt-harness/memo'
import { embedTexts } from '@jt-harness/memo'
import { enqueue, jobStatus, retryJob } from '@jt-harness/memo'
import { MemoStorage } from '@jt-harness/memo'
import { listManagedEntries, manageEntry, storageStats } from '@jt-harness/memo'
import { storageDoctor } from '@jt-harness/memo'
import { startWorker } from './background.ts'
import { receiveRecords, receiveDshCaptures } from './ingest.ts'
import { schemaVersion, readAgentOutputs, readIntakeRecovery, recoverIntake } from '@jt-harness/memo'
import { rememberEntryRead } from '@jt-harness/codex-hooks'

const help = `jth init --project <id>  初始化项目；开启 update_plan，默认关闭本项目 Codex 原生记忆，--codex-memory inherit 跟随全局
jth install|upgrade|doctor|uninstall  项目接入、独立安装升级和运行诊断；运行 jth install --help
jth monitor <command>  本地 Phoenix 与会话观测
jth flow <command>  Codex 原生流程指导与 Memo 接入；运行 jth flow --help
jth db status|start|stop  本机 PostgreSQL 生命周期管理
jth memo <command>

  model                        交互切换当前 Agent 模型；--list 查询实时列表
  init                         初始化 PostgreSQL + pgvector 表
  prepare --session <id>       为当前 Agent 返回可引用来源
  record <file.json|->         保存会话内候选，后台仅生成向量
  evidence <id> --message <id>  读取来源原文
  send <file.json|-> --legacy   显式使用历史 DSH 提炼路径
  codex <command>             末尾声明：install / uninstall / status / declare
  status [submission-id]       队列、提炼和入库状态；--summary 仅显示汇总与失败原因
  outputs <submission-id>      查看原始模型返回，包括无法解析的结果
  work [--index]               接收声明并生成向量；--legacy 才处理历史 DSH 队列
  retry <submission-id>        重试失败任务，复用已保存提炼
  recover <id> [file.json|-]   查看未接收条目；按路径提交 replace/dismiss 修正和原因
  search <query> <scope>       返回候选摘要，默认排除助手建议
  read <entry-id>              读取正文与来源证据
  read --submission <id>       读取批次、修订证据和提交回执
  doctor                      只读体检：来源、向量、回执和关系一致性
  stats                       容量与生命周期统计
  review list                 查看已入库的待审条目
  review approve <id>         确认候选，必须提供 --reason 和 --evidence
  review reject <id>          拒绝条目，必须提供 --reason
  archive <id>                归档条目，必须提供 --reason
  archive --session <id>      归档该会话的 current_task 条目
  archives                    查看归档条目
  restore <id>                恢复归档条目，必须提供 --reason

scope 必须选一种：--project <id>（可重复）、--business <id>（可重复）、
  --session <id>、--user、--submission <id>
search 可选：--limit <1..50>、--candidates（或 --proposals）、--history、--archived
search/read 可选：--as-of <带时区 ISO 时间>，查看当时已知且已生效的状态
send 可选：--model <DSH model>、--provider <DSH provider>、--review（先入候选区）
retry 可选：--timeout-ms <毫秒>，显式调整本次及后续重试的 Agent 时间预算
retry 可选：--provider <id> --model <id>，显式切换失败任务，原执行快照保留在 failure_history
review list/archives 可选：--limit <1..100>
通用：--env-file <path>（显式覆盖）；默认使用项目已选配置或 ~/.jt-harness/.env；--help
输出均为 JSON；错误写入 stderr，退出码 1。
`

const optionTypes = {
  'env-file': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  wait: { type: 'boolean' }, model: { type: 'string' }, provider: { type: 'string' },
  project: { type: 'string', multiple: true }, business: { type: 'string', multiple: true },
  session: { type: 'string' }, user: { type: 'boolean' }, submission: { type: 'string' },
  limit: { type: 'string' }, proposals: { type: 'boolean' },
  history: { type: 'boolean' }, summary: { type: 'boolean' },
  'as-of': { type: 'string' }, candidates: { type: 'boolean' }, archived: { type: 'boolean' }, review: { type: 'boolean' },
  reason: { type: 'string' }, evidence: { type: 'string' },
  'timeout-ms': { type: 'string' }, legacy: { type: 'boolean' }, index: { type: 'boolean' }, 'source-session': { type: 'string' },
} as const

const commandOptions: Record<string, string[]> = {
  init: [], send: ['wait', 'model', 'provider', 'review', 'legacy'], status: ['summary'], work: ['legacy', 'index'], retry: ['timeout-ms', 'legacy', 'provider', 'model'],
  search: ['project', 'business', 'session', 'user', 'submission', 'limit', 'proposals', 'history', 'candidates', 'archived', 'as-of'],
  read: ['submission', 'as-of', 'source-session'], doctor: [], stats: [], review: ['limit', 'reason', 'evidence'],
  archive: ['session', 'reason'], restore: ['reason'], archives: ['limit'],
  outputs: [], recover: [],
}

async function readSubmission(path: string) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of path === '-' ? process.stdin : createReadStream(path)) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 512_000) throw new Error('输入文件超过 512000 字节；请按消息边界拆批')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function main(root: string, args = process.argv.slice(2)) {
  let config: Config | undefined
  let pool: Pool | undefined
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error('命令中断；已接收的任务可用 memo work 恢复'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const { values, positionals } = parseArgs({ args, options: optionTypes, allowPositionals: true })
    if (values.help || positionals.length === 0 || (positionals.length === 1 && positionals[0] === 'memo')) {
      process.stdout.write(help)
      return
    }
    const [group, command, ...operands] = positionals
    if (group !== 'memo' || !command || !Object.hasOwn(commandOptions, command)) throw new Error('未知命令；运行 jth --help 查看用法')
    const invalidOptions = Object.keys(values).filter(name => !['env-file', 'help', ...commandOptions[command]].includes(name))
    if (invalidOptions.length) throw new Error(`${command} 不支持：${invalidOptions.join(', ')}`)
    const count = command === 'status' ? operands.length <= 1
      : command === 'recover' ? operands.length >= 1 && operands.length <= 2
      : ['send', 'retry', 'search', 'outputs'].includes(command) ? operands.length === 1
      : command === 'read' ? operands.length + Number(Boolean(values.submission)) === 1
      : command === 'review' ? (operands[0] === 'list' ? operands.length === 1 : ['approve', 'reject'].includes(operands[0]) && operands.length === 2)
      : command === 'archive' ? operands.length + Number(Boolean(values.session)) === 1
      : command === 'restore' ? operands.length === 1
      : operands.length === 0
    if (!count) throw new Error('命令参数数量不正确；运行 jth --help 查看用法')
    if (command === 'send' && !values.legacy) throw new Error('自动 DSH 提炼已停用；需要历史路径时显式使用 send --legacy')
    const scopes = [
      ...(values.project ? [{ kind: 'project', project_ids: values.project }] : []),
      ...(values.business ? [{ kind: 'business', business_ids: values.business }] : []),
      ...(values.session ? [{ kind: 'current_task', source_session_id: values.session }] : []),
      ...(values.user ? [{ kind: 'user' }] : []),
      ...(values.submission ? [{ kind: 'unspecified', submission_id: values.submission }] : []),
    ]
    if (command === 'search' && scopes.length !== 1) throw new Error('search 必须明确指定一种范围；不会默认搜索全部记忆')
    const limit = Number(values.limit ?? (command === 'search' ? 3 : 10))
    if (command === 'search' && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw new Error('--limit 必须为 1..50 的整数')
    const asOf = values['as-of'] ? timestampSchema.parse(values['as-of']) : undefined
    config = await loadWorkspaceConfig(root, values['env-file'])
    if (!config.databaseUrl) throw new Error('请在 .env 配置 JTH_DATABASE_URL')
    pool = await connectDatabase(config)
    pool.on('error', error => { process.stderr.write(`${safeError(error, config)}\n`); controller.abort(error) })
    if (command === 'doctor') {
      const report = await storageDoctor(pool)
      if (!report.ok) process.exitCode = 1
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }
    await prepareDatabase(pool, command === 'init')
    const storage = new MemoStorage(pool)
    let result: unknown
    switch (command) {
      case 'init': result = { status: 'ready', schema_version: schemaVersion }; break
      case 'recover': {
        const recovery = operands[1]
          ? await recoverIntake(pool, operands[0], await readSubmission(operands[1]))
          : await readIntakeRecovery(pool, operands[0])
        result = recovery
        if (operands[1] && recovery.issues.some(issue => ['queued', 'running'].includes(issue.recovery?.followup_status))) {
          result = { ...recovery, worker: { started: false, recovery: '历史 DSH 回补保留在队列；显式 memo work --legacy 才执行' } }
        }
        break
      }
      case 'outputs': {
        const status = await jobStatus(pool, operands[0])
        result = { submission_id: operands[0], status: status.status, error: status.error, intake_issues: status.intake_issues,
          outputs: await readAgentOutputs(pool, operands[0]) }
        break
      }
      case 'status': {
        const status = await jobStatus(pool, operands[0])
        if (values.summary && operands.length) throw new Error('--summary 用于整个队列，不接受任务 ID')
        if (values.summary) { const { recent: _recent, ...summary } = status; result = summary }
        else result = status
        break
      }
      case 'stats': result = await storageStats(pool); break
      case 'archives': result = await listManagedEntries(pool, 'archives', limit); break
      case 'review': {
        if (operands[0] === 'list') {
          if (values.reason || values.evidence) throw new Error('review list 不接受 --reason 或 --evidence')
          result = await listManagedEntries(pool, 'candidates', limit)
        } else {
          if (values.limit) throw new Error('审核操作不接受 --limit')
          result = await manageEntry(pool, { action: operands[0] as 'approve' | 'reject', entry_id: operands[1], reason: values.reason ?? '', evidence_ref: values.evidence })
        }
        break
      }
      case 'archive':
      case 'restore': result = await manageEntry(pool, { action: command, entry_id: operands[0], source_session_id: values.session, reason: values.reason ?? '' }); break
      case 'work': {
        if (values.legacy && values.index) throw new Error('--legacy 和 --index 不可同时使用')
        const capture = values.legacy ? await receiveDshCaptures(pool, config, controller.signal) : await receiveRecords(pool, config)
        const counts = values.legacy
          ? await (await import('@jt-harness/memo/legacy')).runLegacyWorker(pool, root, controller.signal)
          : await runIndexWorker(pool, file => loadConfig(root, file), controller.signal)
        if (counts.failed > 0 || (capture?.errors.length ?? 0) > 0 || ('declaration_errors' in capture && capture.declaration_errors.length > 0)) process.exitCode = 1
        result = { ...counts, capture }
        break
      }
      case 'read': {
        if (values.submission) result = await storage.getSubmission(values.submission, asOf)
        else {
          const entry = await storage.getEntry(operands[0], asOf)
          const sessionId = values['source-session'] ?? process.env.CODEX_THREAD_ID
          if (sessionId && entry.version) await rememberEntryRead(config, sessionId, entry.id, entry.version)
          result = entry
        }
        break
      }
      case 'search': {
        const scope = scopeFilterSchema.parse(scopes[0])
        const profile = executionProfile(config)
        const [vector] = await embedTexts([operands[0]], config.embedding, controller.signal)
        const found = await storage.search({ space_id: profile.space.id, vector, scope, include_proposals: values.proposals,
          include_history: values.history, include_candidates: values.candidates, include_archived: values.archived, as_of: asOf, limit })
        result = { space: found.space, entries: found.entries.map(entry => ({
          id: entry.id, submission_id: entry.submission_id, collection: entry.collection, scope: entry.scope,
          preview: entry.content.slice(0, 400), distance: entry.distance,
          state: entry.state,
          claim_status: entry.claim_status, archived: entry.archived, entities: entry.entities,
          source_occurred_at: entry.source_occurred_at, valid_from: entry.valid_from, valid_until: entry.valid_until,
        })) }
        break
      }
      case 'send':
      case 'retry': {
        let indexOnly = false
        if (command === 'retry') {
          const previous = await jobStatus(pool, operands[0])
          indexOnly = previous.kind === 'index'
          if (!indexOnly && !values.legacy) throw new Error('历史 DSH 任务需显式 retry --legacy；默认声明流程不会启动 DSH')
          if (indexOnly && values.legacy) throw new Error('索引任务不使用 --legacy')
          if (Boolean(values.provider) !== Boolean(values.model)) throw new Error('retry 切换模型须同时指定 --provider 和 --model')
          if (indexOnly && values.provider) throw new Error('索引任务不调用 DSH，不能覆盖 Provider 或模型')
          if (values.provider && values.model) {
            const { withModelCatalog } = await import('@jt-harness/memo/models')
            await withModelCatalog(config, (_catalog, check) => check(values.provider!, values.model!))
          }
        }
        config.agent = optionsSchema.parse({ ...config.agent, model: values.model ?? config.agent.model, provider: values.provider ?? config.agent.provider })
        const receipt = command === 'send'
          ? await enqueue(pool, values.review ? { ...submissionSchema.parse(await readSubmission(operands[0])), review_required: true } : await readSubmission(operands[0]), executionProfile(config))
          : await retryJob(pool, operands[0], values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
            values.provider && values.model ? { provider: values.provider, model: values.model } : undefined)
        if (values.wait) {
          await (indexOnly ? runIndexWorker(pool, file => loadConfig(root, file), controller.signal) : (await import('@jt-harness/memo/legacy')).runLegacyWorker(pool, root, controller.signal))
          result = await jobStatus(pool, receipt.submission_id)
          if (!['complete', 'partial'].includes((result as { status: string }).status)) process.exitCode = 1
        } else if (receipt.status === 'queued' || receipt.status === 'running') {
          try { result = { ...receipt, worker: await startWorker(root, config, indexOnly) } } catch (error) {
            // Acceptance already committed. Report launch failure without losing
            // the submission ID or pretending the source was not received.
            result = { ...receipt, worker: { started: false, error: safeError(error, config), recovery: 'jth memo work' } }
            process.exitCode = 1
          }
        } else {
          result = receipt
          if (receipt.status === 'failed') process.exitCode = 1
        }
        break
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: safeError(error, config) })}\n`)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    await pool?.end()
  }
}
