import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig, openDatabase } from '@jt-harness/memo'
import { withCodex, type NativeHookList } from '../packages/cli/src/codex-client.ts'

// A local Responses fixture exercises real Codex hooks without paid inference or transcript upload.
const root = process.cwd(), directory = await mkdtemp('/tmp/jth-monitor-verification-'), home = resolve(directory, 'codex-home'), workspace = resolve(directory, 'workspace')
const execute = promisify(execFile), config = await loadConfig(root)
let requests = 0
const server = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    requests++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const message = { id: 'msg_jth_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '本地监控集成测试完成。', annotations: [] }] }
    for (const event of [
      { type: 'response.created', response: { id: 'resp_jth_fixture', status: 'in_progress', model: 'jth-monitor-fixture' } },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_jth_fixture', status: 'completed', model: 'jth-monitor-fixture', output: [message], usage: { input_tokens: 64, input_tokens_details: { cached_tokens: 16 }, output_tokens: 8, total_tokens: 72 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port
const previousHome = process.env.CODEX_HOME
try {
  await mkdir(home); await mkdir(workspace)
  await execute('git', ['init', '-q', workspace])
  await writeFile(resolve(workspace, 'AGENTS.md'), '# Monitor verification\nNo code changes, tools or memory declarations are requested.\n')
  const envFile = resolve(directory, '.env')
  await writeFile(envFile, `JTH_DATABASE_URL=${config.databaseUrl}\nJTH_DATA_DIR=${directory}/data\n`, { mode: 0o600 })
  await execute('bun', [resolve(root, 'bin/jth.mjs'), 'install', '--workspace', workspace, '--project', 'jth-monitor-fixture', '--env-file', envFile], { env: { ...process.env, CODEX_HOME: home } })
  await writeFile(resolve(workspace, '.jth/monitor.json'), '{"enabled":true}')
  const { configureMonitorHooks } = await import('../packages/codex-hooks/src/monitor.ts')
  await configureMonitorHooks(root, workspace, true)
  await writeFile(resolve(home, 'config.toml'), `model="jth-monitor-fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local verification"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[agents]\nenabled=false\n[features]\nhooks=true\nmemories=false\n[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n`)
  process.env.CODEX_HOME = home
  const report = await withCodex(async call => {
    const hooks = (await call('hooks/list', { cwds: [workspace] }) as NativeHookList).data[0].hooks
    await call('config/batchWrite', { edits: hooks.map(h => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash, mergeStrategy: 'replace' })), reloadUserConfig: true })
    const started = await call('thread/start', { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never' })
    const threadId = started.thread.id as string
    await call('turn/start', { threadId, input: [{ type: 'text', text: '本地监听集成测试，直接回复完成。' }] })
    let status
    for (let i = 0; i < 80; i++) {
      status = await readFile(resolve(workspace, '.jth/monitor/last-export.json'), 'utf8').then(text => JSON.parse(text), () => null)
      if (status?.event === 'Stop' && status.sessionId === threadId) break
      await delay(100)
    }
    assert.equal(status?.event, 'Stop', 'Codex must automatically trigger and export its Stop hook')
    assert.equal(status.tokens, 72)
    // last-export is written before its pending file is acknowledged; wait for the drain separately.
    for (let i = 0; i < 40 && (await readdir(resolve(workspace, '.jth/monitor/pending'))).length; i++) await delay(100)
    assert.equal((await readdir(resolve(workspace, '.jth/monitor/pending'))).length, 0)
    return { threadId, lastExport: status, localResponsesRequests: requests, paidModelCalls: 0 }
  })
  const pool = openDatabase(config)
  try {
    let result = await pool.query("SELECT count(*)::int AS spans FROM phoenix.spans WHERE attributes::text LIKE $1", [`%${report.threadId}%`])
    for (let i = 0; i < 30 && result.rows[0].spans < 3; i++) {
      await delay(100)
      result = await pool.query("SELECT count(*)::int AS spans FROM phoenix.spans WHERE attributes::text LIKE $1", [`%${report.threadId}%`])
    }
    assert(result.rows[0].spans >= 3, 'Phoenix must persist entry, turn and standard LLM usage spans')
    const usage = await pool.query("SELECT cumulative_llm_token_count_prompt + cumulative_llm_token_count_completion AS total FROM phoenix.spans WHERE name='Codex 回合' AND attributes::text LIKE $1", [`%${report.threadId}%`])
    assert.equal(Number(usage.rows[0]?.total), 72, 'The Phoenix UI cumulative token field must reflect the native usage')
    await writeFile(resolve(root, 'artifacts/delivery/monitor-verification.json'), JSON.stringify({ ...report, spans: result.rows[0].spans }, null, 2))
    console.log(JSON.stringify({ ...report, spans: result.rows[0].spans }))
  } finally { await pool.end() }
} finally {
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome
  await new Promise<void>(done => server.close(() => done()))
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
