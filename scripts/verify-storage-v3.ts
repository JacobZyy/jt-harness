import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { MemoStorage } from '@jt-harness/memo'

if (!process.argv.includes('--live')) throw new Error('将调用真实 DSH/Embedding 并写入隔离的验证项目；需显式 --live')
const root = fileURLToPath(new URL('../', import.meta.url))
const project = `jth-storage-v3-${Date.now()}`
const directory = resolve(root, 'artifacts/jth', project)
await mkdir(directory, { recursive: true, mode: 0o700 })
const execute = promisify(execFile)
const cli = async (...args: string[]) => {
  try {
    return JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.ts'), 'memo', ...args], { cwd: root, timeout: 240_000, maxBuffer: 3_000_000 })).stdout)
  } catch (error) {
    const output = error as { stdout?: string, stderr?: string }
    const result = JSON.parse(output.stdout || output.stderr || '{}')
    throw new Error(`${args[0]}: ${result.error ?? '命令未完成'}`)
  }
}
const input = {
  schema_version: 1, submission_id: project, source: { provider: 'codex', session_id: project },
  scope: { project_ids: [project], business_ids: [] },
  messages: [
    { message_id: 'u1', role: 'user', text: '项目 StorageDemo 的 API 地址为 https://storage.example.invalid，请求超时为 30 秒。' },
    { message_id: 'a1', role: 'assistant', text: '建议项目 StorageDemo 启用 local-cache。这个建议尚未被确认。' },
    { message_id: 'u2', role: 'user', text: '本次 StorageDemo 调试任务的临时约束：只读取 test-fixtures 目录；只对本次任务有效。' },
    { message_id: 'u3', role: 'user', text: 'StorageDemo 的 season-feature 仅在 2100-01-01T00:00:00Z 至 2100-02-01T00:00:00Z 期间启用。' },
  ].map((message, index) => ({ ...message, occurred_at: new Date(Date.now() - 4000 + index * 1000).toISOString() })),
}
const file = resolve(directory, 'input.json')
await writeFile(file, JSON.stringify(input, null, 2), { mode: 0o600 })
const receipt = await cli('send', file, '--legacy', '--wait')
assert.equal(receipt.status, 'complete')
const batch: Awaited<ReturnType<MemoStorage['getSubmission']>> = await cli('read', '--submission', project)
const address = batch.entries.find(entry => entry.content.includes('storage.example.invalid'))!
const timeout = batch.entries.find(entry => entry.content.includes('30') && !entry.content.includes('storage.example.invalid'))!
const scheduled = batch.entries.find(entry => entry.entities.includes('season-feature'))!
const candidate = batch.entries.find(entry => entry.collection === 'proposals' && entry.content.includes('local-cache'))!
const task = batch.entries.find(entry => entry.scope === 'current_task')!
assert(address && timeout && scheduled && candidate && task)
assert(!address.content.includes('30'), 'address and timeout must be independently revisable facts')
assert.equal(scheduled.state, 'scheduled')
assert.equal(candidate.claim_status, 'candidate')
assert(batch.entries.every(entry => entry.source_occurred_at !== null))
assert.equal((await cli('read', scheduled.id, '--as-of', '2100-01-15T00:00:00Z')).state, 'active')
assert.equal((await cli('read', scheduled.id, '--as-of', '2100-03-01T00:00:00Z')).state, 'expired')
const approval = await cli('review', 'approve', candidate.id, '--reason', '隔离验证：演示候选确认，不代表实际项目决策', '--evidence', 'verification:storage-v3')
assert.equal(approval.entries[0].claim_status, 'verified')
await cli('review', 'reject', candidate.id, '--reason', '隔离验证结束，拒绝测试建议')
assert.equal((await cli('read', candidate.id)).claim_status, 'rejected')
const archived = await cli('archive', '--session', project, '--reason', '隔离验证：本次任务结束')
assert.equal(archived.changed, 1)
assert.equal((await cli('read', task.id)).archived, true)
assert.equal((await cli('read', address.id)).archived, false)
await cli('restore', task.id, '--reason', '隔离验证：恢复归档')
assert.equal((await cli('read', task.id)).archived, false)
await cli('archive', task.id, '--reason', '验证结束，归档测试任务')
const reviewProject = `${project}-review`
const reviewFile = resolve(directory, 'review-input.json')
await writeFile(reviewFile, JSON.stringify({ ...input, submission_id: reviewProject, scope: { project_ids: [reviewProject], business_ids: [] },
  messages: [{ message_id: 'u1', role: 'user', text: '项目 ReviewDemo 的日志保留天数为 14 天。', occurred_at: new Date().toISOString() }] }), { mode: 0o600 })
await cli('send', reviewFile, '--review', '--wait')
const reviewBatch: Awaited<ReturnType<MemoStorage['getSubmission']>> = await cli('read', '--submission', reviewProject)
assert(reviewBatch.entries.length > 0 && reviewBatch.entries.every(entry => entry.claim_status === 'candidate'))
const doctor = await cli('doctor')
assert.equal(doctor.ok, true)
const stats = await cli('stats')
const evidence = { project, directory, receipt, batch, approval, archived, review_entries: reviewBatch.entries, doctor, stats, checked_at: new Date().toISOString() }
await writeFile(resolve(root, 'artifacts/jth/storage-v3-live-result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ project, result: 'passed', facts: batch.entries.length, candidateReview: true, reversibleArchive: true, temporalReads: true, doctor: doctor.ok })}\n`)
