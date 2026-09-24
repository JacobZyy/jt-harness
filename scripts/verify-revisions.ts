import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { StateEntry } from '@jt-harness/memo'
import type { MemoStorage } from '@jt-harness/memo'

// Explicit live verification: writes only synthetic facts in a fresh test project.
if (!process.argv.includes('--live')) throw new Error('此脚本会调用真实 DSH/Embedding 并写入测试项目；需显式 --live')
const root = fileURLToPath(new URL('../', import.meta.url))
const projectOption = process.argv.indexOf('--project')
const project = projectOption < 0 ? `jth-revision-check-${Date.now()}` : process.argv[projectOption + 1]
if (!/^jth-revision-check-\d+$/.test(project ?? '')) throw new Error('--project 必须是本脚本创建的测试项目 ID')
const directory = resolve(root, 'artifacts/jth', project)
await mkdir(directory, { recursive: true, mode: 0o700 })
const execute = promisify(execFile)
const cli = async (...args: string[]) => {
  try {
    return JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.ts'), 'memo', ...args], { cwd: root, timeout: 240_000, maxBuffer: 2_000_000 })).stdout)
  } catch (error) {
    const output = error as { stdout?: string, stderr?: string }
    const result = JSON.parse(output.stdout || output.stderr || '{}')
    throw new Error(`${args[0]}: ${result.error ?? '命令未完成'}`)
  }
}
type Batch = Awaited<ReturnType<MemoStorage['getSubmission']>>
const completedBeforeResume = new Set<string>()
if (projectOption >= 0) {
  for (const step of ['initial', 'correction', 'supplement', 'conflict', 'resolution']) {
    try {
      if ((await cli('status', `${project}-${step}`)).status === 'complete') completedBeforeResume.add(step)
    } catch (error) { if (!String(error).includes('任务不存在')) throw error }
  }
}
const send = async (step: string, text: string): Promise<Batch> => {
  const submission_id = `${project}-${step}`
  const file = resolve(directory, `${step}.json`)
  await writeFile(file, JSON.stringify({
    schema_version: 1, submission_id, source: { provider: 'codex', session_id: project },
    scope: { project_ids: [project], business_ids: [] },
    messages: [{ message_id: `${step}-u1`, role: 'user', text }],
  }, null, 2), { mode: 0o600 })
  if (projectOption >= 0) {
    let existing
    try { existing = await cli('status', submission_id) } catch (error) {
      if (!String(error).includes('任务不存在')) throw error
    }
    if (existing?.status === 'failed') await cli('retry', submission_id)
  }
  const receipt = await cli('send', file, '--legacy', '--wait')
  assert.equal(receipt.status, 'complete')
  const result = await cli('read', '--submission', submission_id)
  await writeFile(resolve(directory, `${step}-result.json`), JSON.stringify({ receipt, result }, null, 2), { mode: 0o600 })
  process.stdout.write(`${step}: complete, entries=${result.entries.length}, relations=${receipt.relation_count}\n`)
  return result
}
const onlyFact = (batch: Batch): StateEntry => {
  const facts = batch.entries.filter(entry => entry.collection === 'memories')
  assert.equal(facts.length, 1)
  return facts[0]
}

const initial = onlyFact(await send('initial', '这个验证项目的生产 API 地址确定为 https://alpha.example.invalid。'))
const corrected = onlyFact(await send('correction', '明确更正：这个验证项目的生产 API 地址从 https://alpha.example.invalid 改为 https://beta.example.invalid，以 beta 为准，alpha 已停用。'))
assert.equal((await cli('read', initial.id)).state, 'superseded')
if (!completedBeforeResume.has('conflict') && !completedBeforeResume.has('resolution')) assert.equal((await cli('read', corrected.id)).state, 'active')
const extra = await send('supplement', '补充这个验证项目的生产 API 约定：现行 beta 地址的请求超时为 30 秒；地址本身保持不变。')
assert(extra.relations.some(relation => relation.kind === 'supplement' && relation.previous_entry_id === corrected.id))
if (!completedBeforeResume.has('conflict') && !completedBeforeResume.has('resolution')) assert.equal((await cli('read', corrected.id)).state, 'active')
const conflict = await send('conflict', '这个验证项目的生产 API 地址出现冲突：既有约定为 https://beta.example.invalid，另一份资料却写 https://gamma.example.invalid，目前没有依据判断谁正确，两种说法都保留待确认。')
assert(conflict.relations.some(relation => relation.kind === 'conflict' && relation.previous_entry_id === corrected.id))
if (!completedBeforeResume.has('resolution')) assert.equal((await cli('read', corrected.id)).state, 'conflicted')
const resolved = await send('resolution', '明确更正并裁决上次 beta/gamma 地址争议：这个验证项目的生产 API 只使用 https://delta.example.invalid，beta 和 gamma 都不再有效。请求超时仍为 30 秒。')
const current = resolved.entries.find(entry => entry.content.includes('delta.example.invalid'))!
assert(current)
assert.equal((await cli('read', corrected.id)).state, 'superseded')
assert.equal((await cli('read', current.id)).state, 'active')
const visible = await cli('search', '生产 API 地址', '--project', project)
const history = await cli('search', '生产 API 地址', '--project', project, '--history')
assert(!visible.entries.some((entry: { id: string }) => [initial.id, corrected.id].includes(entry.id)))
assert(history.entries.some((entry: { id: string, state: string }) => entry.id === initial.id && entry.state === 'superseded'))
const evidence = { project, directory, initial: initial.id, corrected: corrected.id, current: current.id, search: visible, history, checked_at: new Date().toISOString() }
await writeFile(resolve(root, 'artifacts/jth/revisions-live-result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ project, result: 'passed', directory })}\n`)
