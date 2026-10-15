import type { EvidenceReference, JudgmentItem } from './contracts.ts'
import type { AnalysisReport, DomainScore } from './scoring.ts'

const statusLabels: Record<JudgmentItem['status'], string> = {
  satisfied: '满足', partial: '部分满足', violated: '违反', unknown: '证据不足', not_applicable: '不适用',
}
const contributionLabels = { observed_help: '已观察到帮助', observed_burden: '已观察到负担', no_effect_evidence: '没有效果证据' } as const
const taskStateLabels = { completed: '已完成', in_progress: '进行中', unknown: '状态待确认' } as const
const escape = (value: string) => value.replace(/[\\`*_\[\]<>|]/g, character => `\\${character}`).replace(/\r?\n/g, ' ')
const usage = (value: number | null) => value === null ? '未知' : String(value)
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const observedNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

function writeUsageLines(report: AnalysisReport) {
  const writes = report.evidence.filter(item => item.kind === 'memo_write_usage').map(item => {
    try { return { evidenceId: item.id, value: object(JSON.parse(item.text)) } } catch { return { evidenceId: item.id, value: {} as Record<string, unknown> } }
  })
  const lines = ['', '### 单次记忆写入用量', '', '原会话 Token 是上下文用量，不是声明生成成本。下面只列截止前实际保留的索引尝试；重试不合并为一次成功。', '']
  if (!writes.length) return [...lines, '选定记录没有可确认的单次索引用量。旧记录不能补算；未知不是 0。', '']
  lines.push('| 写入批次 | 尝试 | 状态 | 已记录请求数 | Embedding 输入 Token | Embedding 总 Token | 后台提炼调用 | 声明专属 Token | 证据 |',
    '|---|---:|---|---:|---:|---:|---:|---:|---|')
  for (const { evidenceId, value } of writes) {
    const attempts = Array.isArray(value.embedding_attempts) ? value.embedding_attempts.map(object) : null
    const total = (field: string) => {
      if (!attempts) return null
      if (!attempts.length) return ['indexed', 'already_indexed', 'failed'].includes(String(value.status)) ? 0 : null
      const numbers = attempts.map(attempt => observedNumber(object(attempt.usage)[field]))
      return numbers.some(number => number === null) ? null : numbers.reduce<number>((sum, number) => sum + number!, 0)
    }
    lines.push(`| ${escape(String(value.submission_id ?? evidenceId))} | ${usage(observedNumber(value.job_attempt))} | ${escape(String(value.status ?? '未知'))} | ${attempts?.length ?? '未知'} | ${usage(total('prompt_tokens'))} | ${usage(total('total_tokens'))} | ${usage(observedNumber(value.background_extraction_model_calls))} | ${usage(observedNumber(value.declaration_tokens))} | ${escape(evidenceId)} |`)
  }
  lines.push('', 'Embedding 输入 Token 与总 Token 不再次相加；部分请求未返回用量时整次总量保持未知。状态未知的尝试仅表示截止前已观察到的部分，不推算剩余成本。', '')
  return lines
}

function scoreLabel(score: DomainScore) {
  if (score.scoreKind === 'not_applicable') return '不适用'
  if (score.score === null) return '待评；不出正式分'
  return `${score.score}/100${score.scoreKind === 'stage' ? '（阶段分，不是最终结果）' : ''}`
}

function references(refs: EvidenceReference[], report: AnalysisReport) {
  return refs.map(reference => {
    const evidence = report.evidence.find(item => item.id === reference.evidenceId)!
    const source = report.sources.find(item => item.id === evidence.sourceId)!
    const position = source.start === undefined ? '' : `；来源区间 ${source.start}..${source.end} 字节`
    return `  - ${escape(reference.evidenceId)}：${escape(reference.quote)}（会话 ${escape(source.sessionId)}；${escape(source.path)}${position}）`
  })
}

function domainLines(label: string, score: DomainScore) {
  const coverage = score.coverage
  return [
    `${label}：**${scoreLabel(score)}**。已提交评项覆盖 ${coverage.assessedItems}/${coverage.applicableItems}；维度覆盖 ${coverage.assessedDimensions}/${coverage.requiredDimensions}；要求覆盖 ${coverage.assessedRequirements}/${coverage.totalRequirements}。`,
    ...score.dimensions.map(dimension => `- ${dimension.label}（权重 ${dimension.weight}%）：${dimension.score === null ? dimension.status === 'not_applicable' ? '不适用' : '证据不足' : `${dimension.score}/100`}`),
    ...score.withheldReasons.map(reason => `- 待评原因：${reason}`),
    ...(score.criticalIssues.length ? [`- **严重错误（critical）：${score.criticalIssues.map(escape).join('、')}。不得被总分抵消。**`] : []),
    ...(score.seriousIssues.length ? [`- 严重问题：${score.seriousIssues.map(escape).join('、')}`] : []),
  ]
}

export function renderAnalysisMarkdown(report: AnalysisReport) {
  const lines = [
    '# JTH 按需分析报告', '',
    `分析：${escape(report.analysisId)}；证据截止：${report.cutoff}。`,
    `规则版本：${report.judge.rubricVersion}；评审模型：${escape(report.judge.model ?? '未知')}；评审会话：${escape(report.judge.sessionId ?? '未知')}。`,
    `证据快照：\`${report.bundleHash}\`。`, '',
    '本报告基于已保存的执行材料。评分表示满足明确要求的程度；不证明业务任务已重新验证，也不估算 Workflow 的因果提升。', '',
    '## 批次结果', '',
    ...(['workflow', 'memo'] as const).map(domain => {
      const result = report.batch[domain]
      const label = domain === 'workflow' ? 'Flow' : 'Memo'
      return `- ${label}：${result.score === null ? '待评' : `${result.score}/100（已完成且证据完整任务的平均分）`}；正式评分 ${result.assessedTasks}/${result.selectedTasks} 个任务，阶段评分 ${result.stageTasks} 个，待评 ${result.unknownTasks} 个，不适用 ${result.notApplicableTasks} 个。`
    }), '',
    '## 实际用量', '',
    `输入 Token：${usage(report.usage.inputTokens)}；缓存输入：${usage(report.usage.cachedInputTokens)}；输出：${usage(report.usage.outputTokens)}；总量：${usage(report.usage.totalTokens)}。缓存输入不再次相加；未知不是 0。`, '',
    ...writeUsageLines(report),
  ]
  if (!report.tasks.length) lines.push('未确认任务单位，只保留观察记录；没有正式评分。', '')
  for (const task of report.tasks) {
    lines.push(`## ${escape(task.title)}（${taskStateLabels[task.state]}）`, '', `任务 ${escape(task.id)}；会话：${task.sessionIds.map(escape).join('、')}。`, '',
      `要求清单完整性：${task.coverageReview.status}；${escape(task.coverageReview.reason)}。完整性由评审者对照原始目标和有效修订核对，不能由已提交评项数量自证。`, '',
      ...references(task.coverageReview.evidenceRefs, report), '', ...domainLines('Flow', task.workflow), '', ...domainLines('Memo', task.memo), '', '### 当前有效要求', '')
    for (const requirement of task.requirements) lines.push(`- ${escape(requirement.id)}｜${requirement.domain === 'workflow' ? 'Flow' : 'Memo'}：${escape(requirement.text)}`, ...references(requirement.sourceRefs, report))
    lines.push('', '### 逐项依据', '')
    for (const item of task.items) {
      lines.push(`- **${statusLabels[item.status]}**｜${escape(item.id)}｜${escape(item.criterion)}`, `  - 理由：${escape(item.reason)}`)
      lines.push(`  - 对应要求：${item.requirementIds.map(escape).join('、')}`)
      if (item.missing) lines.push(`  - 具体缺失：${escape(item.missing)}`)
      lines.push('  - 要求来源：', ...references(item.requirementRefs, report), '  - 执行证据：', ...references(item.evidenceRefs, report))
    }
    lines.push('', '### 可观察贡献', '')
    if (!task.contributions.length) lines.push('没有可引用的贡献事件；不补造助力分。')
    for (const contribution of task.contributions) lines.push(`- ${contributionLabels[contribution.kind]}：${escape(contribution.claim)}`, ...references(contribution.evidenceRefs, report))
    lines.push('')
  }
  lines.push('## 机械链路观察', '')
  if (!report.chainFacts.length) lines.push('未提供链路观察；不能推断不存在错误。')
  for (const fact of report.chainFacts) lines.push(`- ${escape(fact.id)}｜${escape(fact.stage)}｜${fact.status}：${escape(fact.detail)}；证据：${fact.evidenceIds.length ? fact.evidenceIds.map(escape).join('、') : '未提供'}`)
  return `${lines.join('\n')}\n`
}
