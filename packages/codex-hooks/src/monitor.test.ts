import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { captureMonitor } from './monitor.ts'
import { monitorMetrics } from './monitor-metrics.ts'

test('monitor captures only new native metadata, counts cache separately, and preserves disabled/outside boundaries', async () => {
  const workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-monitor-')))
  const home = resolve(workspace, 'home'), path = resolve(home, 'sessions/source.jsonl'), timestamp = '2026-09-21T01:00:00.000Z'
  const row = (type: string, payload: object) => JSON.stringify({ timestamp, type, payload }) + '\n'
  try {
    await mkdir(resolve(home, 'sessions'), { recursive: true })
    await mkdir(resolve(workspace, '.jth'), { recursive: true })
    await writeFile(path, row('session_meta', { id: 'native-session' }) + row('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 400, cached_input_tokens: 230, output_tokens: 0 } } }))
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 'native-session', turn_id: 'native-turn', cwd: workspace, transcript_path: path, prompt: 'PRIVATE_USER_PROMPT' }
    assert.equal(await captureMonitor(input, workspace, home), null)
    await writeFile(resolve(workspace, '.jth/monitor.json'), '{"enabled":true}')
    const start = await captureMonitor(input, workspace, home)
    assert(start)
    const usage = (input: number, cached: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: 5 })
    await writeFile(path, row('turn_context', { model: 'test-model' }) +
      row('response_item', { type: 'function_call', name: 'exec_command', call_id: 'tool-one', arguments: 'PRIVATE_ARGUMENTS' }) +
      row('response_item', { type: 'function_call_output', call_id: 'tool-one', output: 'PRIVATE_OUTPUT' }) +
      row('event_msg', { type: 'token_count', info: { total_token_usage: usage(500, 300), last_token_usage: usage(100, 70) } }) +
      row('event_msg', { type: 'token_count', info: { total_token_usage: usage(500, 300), last_token_usage: usage(100, 70) } }), { flag: 'a' })
    const end = await captureMonitor({ ...input, hook_event_name: 'Stop' }, workspace, home)
    const receipt = JSON.parse(await readFile(end!, 'utf8'))
    const metrics = await monitorMetrics(receipt)
    assert.equal(metrics.usageObserved, true)
    assert.equal(receipt.baseline.input_tokens, 400)
    assert.equal(metrics.input, 100)
    assert.equal(metrics.cached, 70)
    assert.equal(metrics.output, 5)
    assert.equal(metrics.requests.length, 1, 'Repeated native token notifications must not duplicate usage')
    assert.equal(metrics.tools.length, 1)
    assert(!JSON.stringify({ receipt, metrics }).includes('PRIVATE_'))
    assert.equal(await captureMonitor({ ...input, cwd: await realpath(tmpdir()) }, workspace, home), null)
    await assert.rejects(captureMonitor({ ...input, session_id: 'wrong' }, workspace, home), /会话不匹配/)
    await writeFile(resolve(workspace, '.jth/monitor.json'), '{"enabled":false}')
    assert.equal(await captureMonitor(input, workspace, home), null)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
