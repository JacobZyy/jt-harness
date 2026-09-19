import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Pool } from 'pg'
import { loadConfig, executionProfile } from '../packages/memo/src/config.ts'
import { prepareDatabase } from '../packages/memo/src/storage/database.ts'
import { MemoStorage } from '../packages/memo/src/storage/storage.ts'
import { enqueue } from '../packages/memo/src/storage/jobs.ts'
import { processJob } from '../packages/memo/src/storage/legacy-worker.ts'
import { embedTexts } from '../packages/memo/src/storage/embedding.ts'
import { extractMemories } from '../packages/memo/src/agents/extract.ts'
import { reconcileMemories } from '../packages/memo/src/agents/reconcile.ts'
import { extractionMaterial, comparisonMaterial } from '../packages/memo/src/agents/material.ts'
import type { AgentRun } from '../packages/memo/src/storage/contract.ts'
import type { Submission, Extraction } from '../packages/memo/src/contracts.ts'

const { values } = parseArgs({ options: { 'env-file': { type: 'string' } } })
assert(process.env.JTH_TEST_DATABASE_URL && values['env-file'], 'Use test-postgres.mjs --memory-live --env-file ... to isolate live cases')
const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
const root = process.cwd(), runId = new Date().toISOString().replaceAll(':', '-')
const directory = resolve(root, 'artifacts/memo-inputs', runId)
await mkdir(directory, { recursive: true, mode: 0o700 })
const save = (name: string, data: unknown) => writeFile(resolve(directory, name), JSON.stringify(data, null, 2), { mode: 0o600 })
const configured = await loadConfig(root, values['env-file'])
const config = { ...configured, databaseUrl: process.env.JTH_TEST_DATABASE_URL, dataDir: directory }
const execution = executionProfile(config), storage = new MemoStorage(pool)
const hookPath = resolve(root, '../jt-harness/.codex/hooks.json')
const hooksBefore = await readFile(hookPath, 'utf8')
const scope = { project_ids: ['jth-manual-input-cases'], business_ids: [] }
const source = (id: string, text: string, occurred_at: string): Submission => ({
  schema_version: 1, submission_id: `${runId}-${id}`, source: { provider: 'codex', session_id: 'manual-input-cases' }, scope,
  messages: [{ message_id: id, role: 'user', text, occurred_at }],
})
const results: object[] = []
try {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'jth_test')
  await prepareDatabase(pool, true)
  const seed = source('seed', '项目生产 API 地址为 https://old.example.invalid；请求超时时间为 30 秒；README 使用中文。', '2026-01-01T00:00:00+08:00')
  const seedFacts: Extraction = { schema_version: 1, memories: [
    '项目生产 API 地址为 https://old.example.invalid。', '项目请求超时时间为 30 秒。', '项目 README 使用中文。',
  ].map(content => ({ content, basis: 'user_statement', scope: 'project', source_message_ids: ['seed'] })), proposals: [], revisions: [] }
  await storage.store({ submission: seed, extraction: seedFacts, run: { session_id: 'synthetic-seed', provider: 'fixture', model: 'fixture' } })
  const seedEntries = (await storage.getSubmission(seed.submission_id)).entries
  const seedVectors = await embedTexts(seedEntries.map(entry => entry.content), config.embedding)
  await storage.index({ submission_id: seed.submission_id, space: execution.space,
    embeddings: seedEntries.map((entry, i) => ({ entry_id: entry.id, content_sha256: entry.content_sha256, vector: seedVectors[i] })) })
  const cases = [
    { id: 'case-1', text: '明确更正项目配置：生产 API 地址改为 https://new.example.invalid，原来的 https://old.example.invalid 作废。', relation: 'correction', old: seedEntries.find(entry => entry.content.includes('old.example.invalid'))! },
    { id: 'case-2', text: '项目请求超时时间是 60 秒。', relation: 'conflict', old: seedEntries.find(entry => entry.content.includes('30 秒'))! },
  ]
  for (const [index, scenario] of cases.entries()) {
    const submission = source(scenario.id, scenario.text, `2026-01-0${index + 2}T00:00:00+08:00`)
    submission.messages.push({ message_id: `${scenario.id}-tool`, role: 'tool', text: JSON.stringify({ tool: 'Bash', command: 'pnpm test', exit_code: 0, output: '测试进度：检查样例，未发现新业务事实。\n'.repeat(2200) }) })
    await save(`${scenario.id}-source.json`, submission)
    await save(`${scenario.id}-extraction-input.json`, extractionMaterial(submission))
    await enqueue(pool, submission, execution)
    const client = await pool.connect()
    try {
      const receipt = await processJob(client, { id: submission.submission_id, payload: submission, execution }, config, undefined, extractMemories,
        async (input, options, context) => {
          await save(`${scenario.id}-comparison-input.json`, comparisonMaterial(input))
          return reconcileMemories(input, options, context)
        })
      const stored = await storage.getSubmission(submission.submission_id)
      assert.deepEqual(stored.submission, submission, 'Input reduction must not modify the immutable stored transcript')
      assert.equal(receipt.intake_issues.length, 0)
      const relations = (await pool.query('SELECT kind,previous_entry_id FROM jt_memo.entry_relations WHERE evidence_submission_id=$1', [submission.submission_id])).rows
      assert(relations.some(row => row.kind === scenario.relation && row.previous_entry_id === scenario.old.id), `${scenario.id}: expected ${scenario.relation}`)
      const oldState = (await pool.query('SELECT state FROM jt_memo.entry_states WHERE id=$1', [scenario.old.id])).rows[0].state
      assert.equal(oldState, scenario.relation === 'correction' ? 'superseded' : 'conflicted')
      const calls = (await pool.query<{ stage: string, run: AgentRun }>('SELECT stage,run FROM jt_memo.agent_outputs WHERE submission_id=$1 ORDER BY received_at', [submission.submission_id])).rows
      assert(calls.some(call => call.stage === 'extraction') && calls.some(call => call.stage === 'reconciliation'))
      assert(calls.every(call => call.run.usage), 'Cache measurement requires actual provider usage for every returned call')
      const result = { case: scenario.id, passed: true, receipt, relations, oldState, calls }
      results.push(result)
      await save(`${scenario.id}-result.json`, result)
      console.log(JSON.stringify(result))
    } finally { client.release() }
  }
  const calls = (await pool.query<{ stage: string, run: AgentRun }>('SELECT stage,run FROM jt_memo.agent_outputs ORDER BY received_at')).rows
  const totals = calls.reduce((sum, call) => ({ input_tokens: sum.input_tokens + call.run.usage!.input_tokens,
    cache_hit_tokens: sum.cache_hit_tokens + call.run.usage!.cache_hit_tokens, output_tokens: sum.output_tokens + call.run.usage!.output_tokens }), { input_tokens: 0, cache_hit_tokens: 0, output_tokens: 0 })
  assert.equal(await readFile(hookPath, 'utf8'), hooksBefore)
  assert.deepEqual(JSON.parse(hooksBefore).hooks, {}, 'Production Hooks must remain disabled')
  const report = { runId, directory, provider: config.agent.provider, model: config.agent.model, cases: results, calls: calls.length, totals,
    cache_hit_rate: totals.cache_hit_tokens / totals.input_tokens, hooksUnchanged: true, isolatedDatabase: true, warmupCalls: 0 }
  await save('report.json', report)
  console.log(JSON.stringify({ directory, calls: calls.length, ...totals, cache_hit_rate: report.cache_hit_rate, hooksUnchanged: true }))
} catch (error) {
  await save('failure.json', { error: String(error), completedCases: results })
  console.error(JSON.stringify({ directory, error: String(error) }))
  process.exitCode = 1
} finally { await pool.end() }
