import type { FlowTask } from './contracts.ts'

export function currentStep(task: FlowTask) { return task.steps.findIndex(step => !step.completedAt) + 1 || null }

/** Compare reported evidence, not elapsed time or tool-call count. Semantic progress remains the agent's responsibility. */
export function workProgress(task: FlowTask) {
  const attempts = task.attempts.filter(attempt => attempt.work.step === currentStep(task) && attempt.work.contractVersion === task.contractVersion)
  const seenEvidence = new Set<string>()
  let consecutive = 0
  let hypothesis: string | null = null
  for (const attempt of attempts) {
    const newEvidence = attempt.evidence.some(reference => !seenEvidence.has(reference))
    const changedHypothesis = attempt.work.hypothesis !== hypothesis
    if (attempt.outcome === 'progress') consecutive = 0
    else if (attempt.outcome === 'failed' || attempt.outcome === 'no-progress') {
      consecutive = newEvidence || changedHypothesis ? 1 : consecutive + 1
    }
    for (const reference of attempt.evidence) seenEvidence.add(reference)
    hypothesis = attempt.work.hypothesis
  }
  const changedApproach = task.work !== null && task.work.hypothesis !== hypothesis
  const action = task.blocked ? 'blocked' : consecutive >= 2 && !changedApproach ? 'change-approach' : 'continue'
  return { action, consecutiveWithoutProgress: consecutive, lastHypothesis: hypothesis }
}
