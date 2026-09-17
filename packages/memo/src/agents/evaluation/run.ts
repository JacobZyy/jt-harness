import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { extractMemories } from '../extract.ts'
import { optionsSchema } from '../../contracts.ts'
import type { Extraction } from '../../contracts.ts'
import { cases } from './cases.ts'
import { judgeExtraction } from './judge.ts'

const runtime = optionsSchema.parse(JSON.parse(await readFile(new URL('../runtime.json', import.meta.url), 'utf8')))
const judgeRuntime = { ...runtime, model: 'glm-5.3-flash' }
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const directory = fileURLToPath(new URL(`../../../../../artifacts/memory-agent/evaluation/${runId}/`, import.meta.url))
await mkdir(directory, { recursive: true })

const frozenFiles = ['../agent.md', '../agent.cordis.patch.yml', '../../contracts.ts', '../extract.ts', '../runtime.json', './cases.ts', './judge.ts']
async function snapshot() {
  return Object.fromEntries(await Promise.all(frozenFiles.map(async file => [file, createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex')])))
}
const hashes = await snapshot()
await writeFile(join(directory, 'manifest.json'), JSON.stringify({
  runId, startedAt: new Date().toISOString(), runtime, judgeRuntime, hashes,
  uniqueCases: cases.length, plannedRuns: cases.reduce((count, item) => count + item.repeat, 0),
  synthetic: true, cache: false, concurrency: 2,
  network: { tokenhubExcludedFromProxy: process.env.NO_PROXY?.includes('tokenhub.zhuanspirit.com') ?? false },
}, null, 2))
await writeFile(join(directory, 'cases.json'), JSON.stringify(cases, null, 2))

// Calibration is separate from candidate evaluation and never enters its score.
const blank: Extraction = { schema_version: 1, memories: [], proposals: [], revisions: [] }
const calibration = [
  {
    name: 'known-good', scenario: cases[0], output: { ...blank, memories: [{
      content: 'alpha 项目使用 pnpm 安装依赖，并将锁文件提交到仓库。',
      basis: 'user_statement', scope: 'project', source_message_ids: ['m1'],
    }] } as Extraction,
    shouldPass: true,
  },
  { name: 'missing-required-facts', scenario: cases[0], output: blank, shouldPass: false },
  {
    name: 'false-user-confirmation', scenario: cases[7], output: { ...blank, memories: [{
      content: '用户已确认将所有请求正文完整写入日志。',
      basis: 'user_confirmed', scope: 'project', source_message_ids: ['m1', 'm2'],
    }] } as Extraction,
    shouldPass: false,
  },
]
for (const sample of calibration) {
  const grade = await judgeExtraction(sample.scenario, sample.output, judgeRuntime)
  await writeFile(join(directory, `calibration-${sample.name}.json`), JSON.stringify({ ...sample, grade }, null, 2))
  assert.equal(grade.verdict.criteria.every(item => item.pass), sample.shouldPass, `评审校准失败：${sample.name}`)
}
console.log(JSON.stringify({ calibration: 'passed', directory }))

const jobs = cases.flatMap(scenario => Array.from({ length: scenario.repeat }, (_, index) => ({ scenario, repeat: index + 1 })))
const results: Record<string, unknown>[] = []
let cursor = 0
async function worker() {
  while (cursor < jobs.length) {
    const { scenario, repeat } = jobs[cursor++]
    const started = Date.now()
    const submission = { ...scenario.submission, submission_id: `${runId}-${scenario.id}-${repeat}` }
    let result: Awaited<ReturnType<typeof extractMemories>>
    try {
      result = await extractMemories(submission, runtime)
    } catch (error) {
      const failed = { id: scenario.id, repeat, title: scenario.title, stage: 'extraction_error', elapsedMs: Date.now() - started, error: String(error) }
      await writeFile(join(directory, `${scenario.id}-${repeat}.json`), JSON.stringify(failed, null, 2))
      results.push(failed)
      console.log(JSON.stringify(failed))
      if (/MISSING_CREDENTIAL|INVALID_CREDENTIAL|Unauthorized|\b401\b/.test(String(error))) throw error
      continue
    }
    const elapsedMs = Date.now() - started
    await writeFile(join(directory, `${scenario.id}-${repeat}.json`), JSON.stringify({ id: scenario.id, repeat, title: scenario.title, stage: 'extracted', elapsedMs, result }, null, 2))
    try {
      const grade = await judgeExtraction(scenario, result, judgeRuntime)
      const failedCriteria = scenario.criteria.filter(rule => !grade.verdict.criteria.find(item => item.id === rule.id)!.pass)
      const unsupported = grade.verdict.items.filter(item => !item.supported)
      const record = {
        id: scenario.id, repeat, title: scenario.title, stage: 'graded', elapsedMs,
        passed: failedCriteria.length === 0 && unsupported.length === 0,
        criticalFailures: failedCriteria.filter(rule => rule.critical).map(rule => rule.id),
        failedCriteria: failedCriteria.map(rule => rule.id), unsupported,
        result, grade,
      }
      await writeFile(join(directory, `${scenario.id}-${repeat}.json`), JSON.stringify(record, null, 2))
      results.push(record)
      console.log(JSON.stringify({ id: scenario.id, repeat, passed: record.passed, criticalFailures: record.criticalFailures, elapsedMs }))
    } catch (error) {
      const failed = { id: scenario.id, repeat, title: scenario.title, stage: 'grading_error', elapsedMs, error: String(error), result }
      await writeFile(join(directory, `${scenario.id}-${repeat}.json`), JSON.stringify(failed, null, 2))
      results.push(failed)
      console.log(JSON.stringify({ id: scenario.id, repeat, stage: failed.stage, error: String(error) }))
      if (/MISSING_CREDENTIAL|INVALID_CREDENTIAL|Unauthorized|\b401\b/.test(String(error))) throw error
    }
  }
}
await Promise.all([worker(), worker()])
assert.deepEqual(await snapshot(), hashes, '评测期间候选 Agent 或评测定义被修改')
await writeFile(join(directory, 'results.json'), JSON.stringify(results.sort((a, b) => `${a.id}-${a.repeat}`.localeCompare(`${b.id}-${b.repeat}`)), null, 2))
await writeFile(join(directory, 'completed.json'), JSON.stringify({ completedAt: new Date().toISOString(), frozenFilesUnchanged: true, completedRuns: results.length }, null, 2))
console.log(JSON.stringify({ completed: true, directory, runs: results.length }))
