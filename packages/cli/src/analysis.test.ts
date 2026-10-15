import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { bundleDigest, judgmentSetSchema } from '@jacob-z/jt-harness/analysis'
import type { EvidenceBundle } from '@jacob-z/jt-harness/analysis'
import { analysisJudgmentTemplate, readAnalysisBundle, writeAnalysisPreparation, writeAnalysisReport } from './analysis.ts'

const bundle = (workspace: string): EvidenceBundle => ({ schemaVersion: 1, analysisId: 'analysis-fixture', cutoff: '2026-10-15T12:00:00Z',
  selection: { workspacePaths: [workspace], sessionIds: ['session-fixture'] },
  sources: [{ id: 'source-user', sessionId: 'session-fixture', workspacePath: workspace, path: '/fixture/native.jsonl', start: 0, end: 120 }],
  evidence: [{ id: 'original-user', kind: 'human_user_message', text: '分析这项需求，保留未知，不调用模型。', occurredAt: '2026-10-15T11:00:00Z', sourceId: 'source-user' }],
  chainFacts: [], usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null } })

test('preparation freezes evidence, preserves filled judgments and reuses unchanged inputs', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-analysis-snapshot-'))
  try {
    const input = bundle(directory)
    const first = await writeAnalysisPreparation(input, directory)
    assert.equal(first.bundle_hash, bundleDigest(input))
    const template = JSON.parse(await readFile(first.judgments_template, 'utf8'))
    judgmentSetSchema.parse(template)
    template.tasks[0].title = '已确认任务'
    await writeFile(first.judgments_template, JSON.stringify(template))
    const second = await writeAnalysisPreparation({ ...input, cutoff: '2026-10-15T13:00:00Z' }, directory)
    assert.equal(second.cutoff, input.cutoff)
    assert.equal(JSON.parse(await readFile(first.judgments_template, 'utf8')).tasks[0].title, '已确认任务')
    const changed = structuredClone(input); changed.evidence[0].text = '不同的原文'
    await assert.rejects(writeAnalysisPreparation(changed, directory), /绑定其他证据/)
    assert.equal((await readAnalysisBundle(directory)).bundle.evidence[0].text, input.evidence[0].text)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unknown template cannot invent scores; mismatched snapshots cannot save reports', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-analysis-report-'))
  try {
    const input = bundle(directory), judgments = analysisJudgmentTemplate(input)
    const result = await writeAnalysisReport(input, judgments, directory)
    assert.equal(result.batch.workflow.score, null)
    assert.equal(result.batch.memo.score, null)
    assert.match(await readFile(result.report_markdown, 'utf8'), /待评/)
    judgments.bundleHash = 'a'.repeat(64)
    await assert.rejects(writeAnalysisReport(input, judgments, directory), /哈希不一致/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('analysis CLI selects native records and emits no invented score or model request', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-analysis-cli-'))
  const root = resolve(import.meta.dirname, '../../..'), workspace = resolve(directory, 'project'), codexHome = resolve(directory, 'codex')
  const configuration = resolve(directory, 'config'), output = resolve(directory, 'output')
  const execute = promisify(execFile)
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(JTH_|EMBEDDING_|CODEX_)/.test(name))),
    HOME: directory, CODEX_HOME: codexHome, JTH_CONFIG_DIR: configuration }
  const cli = (...args: string[]) => execute(process.execPath, [...(process.versions.bun ? ['--no-env-file'] : []), resolve(root, 'bin/jth.ts'), 'analysis', ...args], { cwd: workspace, env: environment })
  try {
    await mkdir(workspace); await mkdir(configuration); await mkdir(resolve(codexHome, 'sessions'), { recursive: true })
    await writeFile(resolve(configuration, '.env'), `JTH_DATA_DIR=${directory}/data\nJTH_DSH_BIN=/must-not-run\n`)
    const row = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload })
    await writeFile(resolve(codexHome, 'sessions/fixture.jsonl'), [
      row('2026-10-15T01:00:00Z', 'session_meta', { id: 'session-fixture', cwd: workspace }),
      row('2026-10-15T01:01:00Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '保留原目标，分析错误原因。' }] }),
      row('2026-10-15T02:00:00Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '原因已核对；结果尚未完成。' }] }),
    ].join('\n') + '\n')
    const prepared = JSON.parse((await cli('prepare', '--session', 'session-fixture', '--output', output)).stdout)
    assert.equal(prepared.evidence, 3)
    const catalog = JSON.parse((await cli('evidence', output)).stdout)
    const original = catalog.evidence.find((item: { kind: string }) => item.kind === 'human_user_message')
    const excerpt = JSON.parse((await cli('evidence', output, '--id', original.id)).stdout)
    assert.equal(excerpt.evidence[0].text, '保留原目标，分析错误原因。')
    const report = JSON.parse((await cli('report', output, '--judgments', prepared.judgments_template)).stdout)
    assert.equal(report.batch.workflow.score, null)
    const usage = JSON.parse((await cli('usage', '--session', 'session-fixture')).stdout)
    assert.equal(usage.session_usage.totalTokens, null)
    assert.deepEqual(usage.writes, [])
    assert(usage.chain_facts.some((fact: { stage: string, status: string }) => fact.stage === 'database_snapshot' && fact.status === 'unknown'))
    const since = JSON.parse((await cli('prepare', '--workspace', workspace, '--since', '2026-10-15T01:30:00Z')).stdout)
    const retained = (await readAnalysisBundle(since.bundle)).bundle
    assert(retained.evidence.some(item => item.text === '保留原目标，分析错误原因。'))
    await assert.rejects(cli('evidence', output, '--until', '2026-10-15T02:00:00Z'), /不支持/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
