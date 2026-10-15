import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeBundle, bundleDigest, evidenceBundleSchema, judgmentSetSchema, renderAnalysisMarkdown } from './index.ts'
import type { EvidenceBundle, JudgmentItem, JudgmentSet } from './index.ts'

function savedConversation(): EvidenceBundle {
  return {
    schemaVersion: 1,
    analysisId: 'analysis-20261015',
    cutoff: '2026-10-15T12:00:00Z',
    selection: { workspacePaths: ['/workspace/jt-harness'], sessionIds: ['source-session'] },
    sources: [{ id: 'source', sessionId: 'source-session', workspacePath: '/workspace/jt-harness', path: '/sessions/source.jsonl', start: 0, end: 800 }],
    evidence: [
      { id: 'request', kind: 'user_message', text: '只分析记录，不能改代码。把已确认的模块清单保存为项目记忆。', occurredAt: '2026-10-15T10:00:00Z', sourceId: 'source' },
      { id: 'result', kind: 'tool_result', text: '分析报告已输出；模块清单没有声明；另修改了无关代码；当前任务未调用检索。', occurredAt: '2026-10-15T11:00:00Z', sourceId: 'source' },
    ],
    chainFacts: [{ id: 'declaration-missing', domain: 'memo', stage: 'declaration', status: 'missing', evidenceIds: ['result'], detail: '完整选定会话没有模块清单声明；无法还原当时遗漏理由。' }],
    usage: { inputTokens: null, cachedInputTokens: null, outputTokens: 0, totalTokens: null },
  }
}

function scoredItem(id: string, domain: JudgmentItem['domain'], dimension: JudgmentItem['dimension'], status: JudgmentItem['status']): JudgmentItem {
  return judgmentSetSchema.shape.items.element.parse({
    id, taskId: 'task-one', domain, dimension, criterion: `${dimension}适用要求`, requirementIds: [domain === 'workflow' ? 'flow-requirement' : 'memo-requirement'], status,
    requirementRefs: [{ evidenceId: 'request', quote: '只分析记录，不能改代码。' }],
    evidenceRefs: [{ evidenceId: 'result', quote: '分析报告已输出' }],
    reason: '根据当前用户要求和保存的执行记录作出判定。',
    ...(status === 'partial' ? { missing: '报告缺少用户要求的模块明细。' } : {}),
    severity: 'normal',
  })
}

function review(bundle = savedConversation()): JudgmentSet {
  return {
    schemaVersion: 1,
    bundleHash: bundleDigest(bundle),
    judge: { model: null, sessionId: 'analysis-session', rubricVersion: '1', assessedAt: '2026-10-15T13:00:00Z' },
    tasks: [{
      id: 'task-one', title: '只读分析与模块记忆', sessionIds: ['source-session'], state: 'completed',
      requirements: [
        { id: 'flow-requirement', domain: 'workflow', text: '保持只读分析范围', sourceRefs: [{ evidenceId: 'request', quote: '只分析记录，不能改代码。' }] },
        { id: 'memo-requirement', domain: 'memo', text: '保存已确认的模块清单', sourceRefs: [{ evidenceId: 'request', quote: '把已确认的模块清单保存为项目记忆。' }] },
      ],
      coverageReview: { status: 'complete', reason: '逐条核对完整选定会话，当前有效要求为只读分析和保存已确认模块，未发现授权替换。', evidenceRefs: [{ evidenceId: 'request', quote: '只分析记录，不能改代码。把已确认的模块清单保存为项目记忆。' }] },
    }],
    items: [
      scoredItem('flow-goal', 'workflow', 'goal_preservation', 'satisfied'),
      scoredItem('flow-delivery', 'workflow', 'deliverable_completion', 'partial'),
      { ...scoredItem('flow-scope', 'workflow', 'scope_constraints', 'violated'), evidenceRefs: [{ evidenceId: 'result', quote: '另修改了无关代码' }], severity: 'critical' },
      scoredItem('flow-evidence', 'workflow', 'completion_evidence', 'satisfied'),
      { ...scoredItem('memo-capture', 'memo', 'memory_capture', 'violated'), requirementRefs: [{ evidenceId: 'request', quote: '把已确认的模块清单保存为项目记忆。' }], evidenceRefs: [{ evidenceId: 'result', quote: '模块清单没有声明' }], reason: '已确认的模块清单漏声明；具体原因未知。' },
      scoredItem('memo-fidelity', 'memo', 'memory_fidelity', 'satisfied'),
      scoredItem('memo-scope', 'memo', 'scope_confirmation', 'partial'),
      { ...scoredItem('memo-retrieval', 'memo', 'retrieval_application', 'not_applicable'), evidenceRefs: [{ evidenceId: 'result', quote: '当前任务未调用检索' }], reason: '本任务没有需要评价的检索与采用过程。' },
    ],
    contributions: [{ id: 'help', taskId: 'task-one', domain: 'workflow', kind: 'no_effect_evidence', claim: '报告已输出，但没有 Workflow 因果贡献证据。', evidenceRefs: [{ evidenceId: 'result', quote: '分析报告已输出' }] }],
  }
}

test('weighted scores preserve critical failures, exclude justified inapplicable Memo dimensions and retain unknown usage', () => {
  const result = analyzeBundle(savedConversation(), review())
  assert.equal(result.tasks[0].workflow.score, 65)
  assert.equal(result.tasks[0].memo.score, 50)
  assert.equal(result.tasks[0].workflow.scoreKind, 'final')
  assert.deepEqual(result.tasks[0].workflow.criticalIssues, ['flow-scope'])
  assert.equal(result.tasks[0].memo.coverage.applicableItems, 3)
  assert.equal(result.tasks[0].memo.coverage.requiredDimensions, 4)
  assert.equal(result.usage.inputTokens, null)
  assert.equal(result.usage.outputTokens, 0)
  const markdown = renderAnalysisMarkdown(result)
  assert.match(markdown, /不得被总分抵消/)
  assert.match(markdown, /输入 Token：未知/)
  assert.match(markdown, /具体原因未知/)
  assert.match(markdown, /不估算 Workflow 的因果提升/)
  assert.match(markdown, /\/sessions\/source.jsonl/)
})

test('missing or unknown scoring evidence withholds the domain score instead of passing or treating uncertainty as zero', () => {
  const incomplete = review()
  incomplete.items = incomplete.items.filter(item => item.id !== 'flow-evidence')
  const missing = analyzeBundle(savedConversation(), incomplete)
  assert.equal(missing.tasks[0].workflow.score, null)
  assert.equal(missing.tasks[0].workflow.coverage.assessedDimensions, 3)
  assert.equal(missing.tasks[0].memo.score, 50)
  incomplete.items.push({ ...scoredItem('flow-evidence', 'workflow', 'completion_evidence', 'unknown'), requirementRefs: [], evidenceRefs: [], reason: '执行结果已丢失，无法确认。' })
  const unknown = analyzeBundle(savedConversation(), incomplete)
  assert.equal(unknown.tasks[0].workflow.score, null)
  assert.equal(unknown.tasks[0].workflow.coverage.itemPercentage, 75)
  assert.equal(unknown.batch.workflow.assessedTasks, 0)
})

test('partial credit requires a concrete missing result; ungrounded and invented quotes cannot become deductions', () => {
  const partial = review()
  delete partial.items[1].missing
  assert.throws(() => analyzeBundle(savedConversation(), partial), /部分满足必须说明具体缺失/)
  const invented = review()
  invented.items[2].evidenceRefs[0].quote = '用户授权修改代码'
  assert.throws(() => analyzeBundle(savedConversation(), invented), /引文与原始证据不一致/)
  invented.items[2].evidenceRefs[0] = { evidenceId: 'absent', quote: '修改代码' }
  assert.throws(() => analyzeBundle(savedConversation(), invented), /引用证据不存在/)
  const ungrounded = review()
  ungrounded.items[0].requirementRefs = []
  assert.throws(() => analyzeBundle(savedConversation(), ungrounded), /明确判定必须引用要求与执行证据/)
})

test('cutoff, snapshot hash, selected scope and stable IDs reject mixed or changed evidence', () => {
  const bundle = savedConversation()
  const judgments = review(bundle)
  bundle.evidence[0].text += '用户后续新增要求。'
  assert.throws(() => analyzeBundle(bundle, judgments), /快照哈希不一致/)
  const future = savedConversation()
  future.evidence[1].occurredAt = '2026-10-15T14:00:00Z'
  assert.throws(() => evidenceBundleSchema.parse(future), /证据晚于分析截止时间/)
  const outside = savedConversation()
  outside.sources[0].workspacePath = '/another/workspace'
  assert.throws(() => evidenceBundleSchema.parse(outside), /来源目录不在选定范围/)
  const duplicate = savedConversation()
  duplicate.evidence.push(duplicate.evidence[0])
  assert.throws(() => evidenceBundleSchema.parse(duplicate), /ID 不能重复/)
})

test('snapshot digest is independent of object key ordering, with no token policy limit', () => {
  const bundle = savedConversation()
  const reversed = Object.fromEntries(Object.entries(bundle).reverse())
  assert.equal(bundleDigest(bundle), bundleDigest(reversed))
  bundle.usage = { inputTokens: 9_000_000, cachedInputTokens: 4_000_000, outputTokens: 3_000_000, totalTokens: 12_000_000 }
  assert.equal(analyzeBundle(bundle, review(bundle)).usage.totalTokens, 12_000_000)
})

test('ongoing and unconfirmed tasks cannot inflate completed-task averages', () => {
  const judgments = review()
  judgments.tasks.push({ ...judgments.tasks[0], id: 'task-two', title: '尚在执行的任务', state: 'in_progress' })
  judgments.tasks.push({ ...judgments.tasks[0], id: 'task-three', title: '边界未确认的任务', state: 'unknown' })
  const original = [...judgments.items]
  judgments.items.push(...original.map(item => ({ ...item, id: `${item.id}-two`, taskId: 'task-two' })))
  judgments.items.push(...original.map(item => ({ ...item, id: `${item.id}-three`, taskId: 'task-three' })))
  const result = analyzeBundle(savedConversation(), judgments)
  assert.equal(result.tasks[1].workflow.score, 65)
  assert.equal(result.tasks[1].workflow.scoreKind, 'stage')
  assert.equal(result.tasks[2].workflow.score, null)
  assert.equal(result.batch.workflow.score, 65)
  assert.equal(result.batch.workflow.assessedTasks, 1)
  assert.equal(result.batch.workflow.selectedTasks, 3)
  assert.equal(result.batch.workflow.coveragePercentage, 33.3)
  assert.match(renderAnalysisMarkdown(result), /阶段分，不是最终结果/)
})

test('task ownership rejects unknown task IDs and references to other task sessions', () => {
  const judgments = review()
  judgments.items[0].taskId = 'invented-task'
  assert.throws(() => analyzeBundle(savedConversation(), judgments), /评审引用的任务不存在/)
  const bundle = savedConversation()
  bundle.selection.sessionIds.push('other-session')
  bundle.sources.push({ id: 'other-source', sessionId: 'other-session', workspacePath: '/workspace/jt-harness', path: '/sessions/other.jsonl' })
  bundle.evidence.push({ id: 'other-result', kind: 'tool_result', text: '其他任务通过了测试', occurredAt: '2026-10-15T11:30:00Z', sourceId: 'other-source' })
  const crossTask = review(bundle)
  crossTask.tasks.push({ id: 'other-task', title: '其他会话的待评任务', sessionIds: ['other-session'], state: 'unknown', requirements: [],
    coverageReview: { status: 'unknown', reason: '当前任务尚未确认。', evidenceRefs: [] } })
  crossTask.items[3].evidenceRefs = [{ evidenceId: 'other-result', quote: '通过了测试' }]
  assert.throws(() => analyzeBundle(bundle, crossTask), /其他任务会话的证据/)
})

test('empty observations do not invent task boundaries or scores', () => {
  const judgments = review()
  judgments.tasks = []
  judgments.items = []
  judgments.contributions = []
  const result = analyzeBundle(savedConversation(), judgments)
  assert.equal(result.batch.workflow.score, null)
  assert.equal(result.batch.memo.score, null)
  assert.equal(result.batch.workflow.selectedTasks, 0)
  assert.match(renderAnalysisMarkdown(result), /未确认任务单位/)
})

test('fully assessed submitted items cannot hide an unassessed active requirement', () => {
  const judgments = review()
  judgments.tasks[0].requirements.push({ id: 'missing-deliverable', domain: 'workflow', text: '保存已确认模块清单这一交付没有评项', sourceRefs: [{ evidenceId: 'request', quote: '把已确认的模块清单保存为项目记忆。' }] })
  const result = analyzeBundle(savedConversation(), judgments)
  assert.equal(result.tasks[0].workflow.coverage.itemPercentage, 100)
  assert.equal(result.tasks[0].workflow.coverage.requirementPercentage, 50)
  assert.equal(result.tasks[0].workflow.score, null)
  assert.equal(result.tasks[0].memo.score, 50)
  assert.match(renderAnalysisMarkdown(result), /已提交评项覆盖 4\/4/)
  assert.match(renderAnalysisMarkdown(result), /要求覆盖 1\/2/)
})

test('unconfirmed inventory completeness withholds scores even when every submitted dimension is assessed', () => {
  for (const status of ['unknown', 'incomplete'] as const) {
    const judgments = review()
    judgments.tasks[0].coverageReview = { status, reason: '缺少早期原始目标，不能确认清单完整。', evidenceRefs: [] }
    const result = analyzeBundle(savedConversation(), judgments)
    assert.equal(result.tasks[0].workflow.score, null)
    assert.equal(result.tasks[0].memo.score, null)
  }
})

test('requirement references must belong to the task and analysis domain, and inventory claims need original evidence', () => {
  const missing = review()
  missing.items[0].requirementIds = ['invented-requirement']
  assert.throws(() => analyzeBundle(savedConversation(), missing), /要求不存在/)
  const wrongDomain = review()
  wrongDomain.items[0].requirementIds = ['memo-requirement']
  assert.throws(() => analyzeBundle(savedConversation(), wrongDomain), /其他分析领域的要求/)
  const noInventoryEvidence = review()
  noInventoryEvidence.tasks[0].coverageReview.evidenceRefs = []
  assert.throws(() => analyzeBundle(savedConversation(), noInventoryEvidence), /完整性核对必须引用/)
})

test('selected sessions cannot be dropped from nonempty task judgments to inflate batch scores', () => {
  const bundle = savedConversation()
  bundle.selection.sessionIds.push('unresolved-session')
  const judgments = review(bundle)
  assert.throws(() => analyzeBundle(bundle, judgments), /评审未覆盖选定会话：unresolved-session/)
  judgments.tasks.push({ id: 'unresolved-task', title: '未确认的选定会话', sessionIds: ['unresolved-session'], state: 'unknown', requirements: [],
    coverageReview: { status: 'unknown', reason: '没有可确认的执行结果，保留待评任务。', evidenceRefs: [] } })
  const result = analyzeBundle(bundle, judgments)
  assert.equal(result.batch.workflow.assessedTasks, 1)
  assert.equal(result.batch.workflow.selectedTasks, 2)
  assert.equal(result.batch.workflow.coveragePercentage, 50)
  judgments.tasks = []
  judgments.items = []
  judgments.contributions = []
  assert.equal(analyzeBundle(bundle, judgments).batch.workflow.score, null)
})

test('readable reports keep each write retry and unknown provider usage separate from session cost', () => {
  const bundle = savedConversation()
  const observation = (attempt: number, tokens: number | null) => JSON.stringify({ submission_id: 'write-one', job_attempt: attempt,
    status: attempt === 1 ? 'failed' : 'indexed', background_extraction_model_calls: 0, declaration_tokens: null,
    embedding_attempts: [{ usage: { prompt_tokens: tokens, total_tokens: tokens } }] })
  bundle.evidence.push(
    { id: 'write-attempt-one', kind: 'memo_write_usage', text: observation(1, null), occurredAt: '2026-10-15T11:01:00Z', sourceId: 'source' },
    { id: 'write-attempt-two', kind: 'memo_write_usage', text: observation(2, 17), occurredAt: '2026-10-15T11:02:00Z', sourceId: 'source' },
  )
  const markdown = renderAnalysisMarkdown(analyzeBundle(bundle, review(bundle)))
  assert.match(markdown, /单次记忆写入用量/)
  assert.match(markdown, /write-one \| 1 \| failed \| 1 \| 未知 \| 未知 \| 0 \| 未知/)
  assert.match(markdown, /write-one \| 2 \| indexed \| 1 \| 17 \| 17 \| 0 \| 未知/)
  assert.match(markdown, /不是声明生成成本/)
})
