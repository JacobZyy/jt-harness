import { execFile } from 'node:child_process'
import { readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs, promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { context, trace, SpanStatusCode } from '@opentelemetry/api'
import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { captureMonitor, configureMonitorHooks, monitorMetrics, readJson, writeJson, type MonitorReceipt } from '@jacob-z/jt-harness/codex-hooks'
import { openDatabase, safeError, type Config } from '@jacob-z/jt-harness/memo'
import { loadWorkspaceConfig } from './configuration.ts'
import { findFlowWorkspace } from '@jacob-z/jt-harness/flow'
import { phoenixStatus, phoenixUrl, startPhoenix, stopPhoenix } from './phoenix.ts'
import { startBackground } from './background.ts'
import { withCodex } from './codex-client.ts'

const execute = promisify(execFile)
const help = `jth monitor start|stop|status|open [--workspace <项目目录>] [--env-file <path>]
jth monitor flush                重投当前项目未上报的事件，不调用模型
jth monitor capture              Codex Hook 入口；只本地交接，后台上报
start 启动本机 Phoenix 并接入当前项目；stop 移除当前项目采集并停止受管服务，数据保留。
首次准备：uv tool install --python 3.12 --with asyncpg arize-phoenix==20.14.0
界面默认 http://127.0.0.1:6006；数据使用原 PostgreSQL 的 phoenix schema。
`
const digest = (text: string, length: number) => createHash('sha256').update(text).digest('hex').slice(0, length)

async function exportReceipt(receipt: MonitorReceipt, goal?: { status: string, tokensUsed: number, timeUsedSeconds: number }) {
  const metrics = await monitorMetrics(receipt), memory = new InMemorySpanExporter()
  let serial = 0
  const identity = `${receipt.sessionId}:${receipt.turnId}:${receipt.event}`
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)], idGenerator: {
    generateTraceId: () => digest(identity, 32), generateSpanId: () => digest(`${identity}:${serial++}`, 16),
  } })
  const tracer = provider.getTracer('jth')
  const correlation = { 'session.id': receipt.sessionId, 'jth.turn_id': receipt.turnId, 'jth.workspace': receipt.workspace }
  const span = tracer.startSpan(receipt.event === 'UserPromptSubmit' ? 'Flow 入口' : metrics.usageObserved ? 'Codex 回合' : 'Codex 回合（用量未知）', {
    startTime: new Date(receipt.event === 'UserPromptSubmit' ? receipt.receivedAt : receipt.startedAt),
    attributes: { ...correlation, 'openinference.span.kind': 'CHAIN', 'jth.event': receipt.event, 'jth.tools.count': metrics.tools.length,
      'jth.tools.truncated': metrics.truncatedTools, 'jth.usage.available': metrics.usageObserved,
      'jth.usage.baseline': receipt.baseline ? 'native-counter' : 'first-request-fallback',
      ...(metrics.usageObserved ? { 'jth.tokens.input': metrics.input, 'jth.tokens.cached': metrics.cached,
      'jth.tokens.output': metrics.output, 'jth.tokens.reasoning': metrics.reasoning } : {}),
      ...(metrics.model ? { 'jth.model': metrics.model } : {}),
      ...(goal ? { 'jth.goal.status': goal.status, 'jth.goal.tokens': goal.tokensUsed, 'jth.goal.seconds': goal.timeUsedSeconds } : {}),
    },
  })
  const parent = trace.setSpan(context.active(), span)
  for (const tool of metrics.tools) {
    const child = tracer.startSpan(tool.name, { startTime: new Date(tool.started), attributes: { ...correlation, 'openinference.span.kind': 'TOOL', 'tool.name': tool.name } }, parent)
    if (tool.failed) child.setStatus({ code: SpanStatusCode.ERROR, message: '工具报告执行失败' })
    child.end(new Date(tool.ended))
  }
  for (const request of metrics.requests) {
    // Token events report usage, not model latency. Keep their timestamp instantaneous.
    const child = tracer.startSpan('模型用量', { startTime: new Date(request.ended), attributes: {
      ...correlation, 'openinference.span.kind': 'LLM', 'jth.duration.available': false,
      'llm.token_count.prompt': request.input, 'llm.token_count.completion': request.output,
      'llm.token_count.prompt_details.cache_read': request.cached,
      'llm.token_count.total': request.input + request.output,
      ...(request.model ? { 'llm.model_name': request.model } : {}),
    } }, parent)
    child.end(new Date(request.ended))
  }
  if (receipt.event === 'Interrupt') span.setStatus({ code: SpanStatusCode.UNSET, message: '用户中断；不等于任务失败或完成' })
  span.end(new Date(receipt.receivedAt))
  await provider.forceFlush()
  const exporter = new OTLPTraceExporter({ url: `${phoenixUrl}/v1/traces`, headers: { 'x-project-name': 'jth' }, timeoutMillis: 3000 })
  try {
    await new Promise<void>((done, reject) => exporter.export(memory.getFinishedSpans(), result => result.code === 0 ? done() : reject(result.error ?? new Error('Phoenix 上报失败'))))
  } finally { await exporter.shutdown(); await provider.shutdown() }
  return { tools: metrics.tools.length, tokens: metrics.usageObserved ? metrics.input + metrics.output : null }
}

export async function flushMonitor(config: Config, workspace: string) {
  const settings = await readJson(resolve(workspace, '.jth/monitor.json')) as { enabled?: boolean } | undefined
  if (!settings?.enabled) return { skipped: 'disabled' }
  if (!(await phoenixStatus(config)).reachable) throw new Error('Phoenix 离线，待投递事件保留；运行 jth monitor start 后重试')
  const pool = openDatabase(config), client = await pool.connect()
  try {
    // Wait for the earlier exporter so a last Stop event cannot be stranded by a try-lock race.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`jth:monitor:${workspace}`])
    const directory = resolve(workspace, '.jth/monitor/pending')
    const names = (await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(name => name.endsWith('.json'))
    let exported = 0
    for (const name of names) {
      const path = resolve(directory, name), receipt = await readJson(path) as MonitorReceipt
      let goal
      if (receipt.event !== 'UserPromptSubmit' && receipt.event !== 'Replay') {
        try { goal = await withCodex(async call => (await call('thread/goal/get', { threadId: receipt.sessionId })).goal) } catch { /* Goal may not be available for this native session. */ }
      }
      const result = await exportReceipt(receipt, goal)
      await writeJson(resolve(workspace, '.jth/monitor/last-export.json'), { ...result, sessionId: receipt.sessionId, turnId: receipt.turnId, event: receipt.event, exportedAt: new Date().toISOString() })
      await unlink(path)
      exported++
    }
    return { exported }
  } finally { client.release(true); await pool.end() }
}

export async function monitorMain(root: string, args: string[]) {
  let config: Config | undefined
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { workspace: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
    const [command] = positionals
    if (values.help || !command) { process.stdout.write(help); return }
    if (positionals.length !== 1 || !['start', 'stop', 'status', 'open', 'capture', 'flush'].includes(command)) throw new Error('未知 monitor 命令')
    const workspace = values.workspace ? resolve(values.workspace) : command === 'capture' ? findFlowWorkspace(process.cwd()) : resolve(process.cwd())
    const locator = await readJson(resolve(workspace, '.jth/flow.json'))
    config = await loadWorkspaceConfig(root, values['env-file'], workspace)
    if (command === 'capture') {
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 512000) throw new Error('监控 Hook 输入过大'); chunks.push(Buffer.from(chunk)) }
      let input: unknown
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('监控 Hook 输入不是有效 JSON') }
      const receipt = await captureMonitor(input, workspace, process.env.CODEX_HOME ?? resolve(homedir(), '.codex'))
      if (receipt) await startBackground(root, ['monitor', 'flush', '--workspace', workspace, '--env-file', config.envFile], resolve(config.dataDir, 'monitor/exporter.log'))
      return
    }
    let result: unknown
    if (command === 'start') {
      if (!locator) throw new Error('先 jth install 接入当前项目')
      const service = await startPhoenix(config, root)
      await writeJson(resolve(workspace, '.jth/monitor.json'), { enabled: true, url: phoenixUrl })
      await configureMonitorHooks(root, workspace, true)
      result = { ...service, workspace, activation: '运行 jth install --trust 审阅并信任新增的本工具采集入口；恢复会话后生效' }
    } else if (command === 'stop') {
      await configureMonitorHooks(root, workspace, false)
      await writeJson(resolve(workspace, '.jth/monitor.json'), { enabled: false, url: phoenixUrl })
      result = await stopPhoenix(config)
    } else if (command === 'flush') result = await flushMonitor(config, workspace)
    else if (command === 'open') { await execute(process.platform === 'darwin' ? 'open' : 'xdg-open', [phoenixUrl]); result = { url: phoenixUrl } }
    else result = { ...await phoenixStatus(config), workspace, capture: await readJson(resolve(workspace, '.jth/monitor.json')) ?? null,
      lastExport: await readJson(resolve(workspace, '.jth/monitor/last-export.json')) ?? null,
      pending: (await readdir(resolve(workspace, '.jth/monitor/pending')).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(name => name.endsWith('.json')).length }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) { process.stderr.write(JSON.stringify({ error: safeError(error, config) }) + '\n'); if (args[0] !== 'capture') process.exitCode = 1 }
}
