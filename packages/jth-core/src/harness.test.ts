// Tests for jth-core harness: policy, evidence, activation
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluatePolicy } from './harness/application/policy.ts'
import { validateEvidence, EvidenceValidationError } from './harness/application/evidence.ts'
import { startActivation, nextCommand, advanceActivation } from './harness/application/activation.ts'
import { CAPABILITY } from './harness/domain/capability-ids.ts'

describe('evaluatePolicy', () => {
  it('noop for noop intent', () => {
    const r = evaluatePolicy({ intent: 'noop', relationship: 'new' })
    assert.equal(r.disposition, 'noop')
  })

  it('direct for question', () => {
    const r = evaluatePolicy({ intent: 'question', relationship: 'new' })
    assert.equal(r.disposition, 'direct')
  })

  it('guarded for bounded implement', () => {
    const r = evaluatePolicy({ intent: 'implement', relationship: 'new' })
    assert.equal(r.disposition, 'guarded')
  })

  it('planned for design', () => {
    const r = evaluatePolicy({ intent: 'design', relationship: 'new' })
    assert.equal(r.disposition, 'planned')
    assert.equal(r.planAction, 'create')
  })

  it('planned when planningReasons provided', () => {
    const r = evaluatePolicy({ intent: 'implement', relationship: 'new', planningReasons: ['dependent-work'] })
    assert.equal(r.disposition, 'planned')
  })

  it('strict mode always planned for work', () => {
    const r = evaluatePolicy({ intent: 'ops', relationship: 'new' }, 'strict')
    assert.equal(r.disposition, 'planned')
  })

  it('reuses plan on continue with active plan', () => {
    const r = evaluatePolicy({ intent: 'implement', relationship: 'continue', activePlan: true, contextAvailable: true })
    assert.equal(r.planAction, 'reuse')
  })
})

describe('validateEvidence', () => {
  it('passes with matching kind', () => {
    const items = [{ kind: 'implementation-complete', refs: ['file:src/index.ts:0'] }]
    const result = validateEvidence(items, ['implementation-complete'])
    assert.equal(result.length, 1)
  })

  it('throws on empty evidence', () => {
    assert.throws(() => validateEvidence([], ['implementation-complete']), EvidenceValidationError)
  })

  it('throws on missing required kind', () => {
    const items = [{ kind: 'implementation-complete', refs: [] }]
    assert.throws(() => validateEvidence(items, ['passing-test-observed']), EvidenceValidationError)
  })

  it('throws on placeholder ref', () => {
    const items = [{ kind: 'manual-verification', refs: ['TODO:placeholder'] }]
    assert.throws(() => validateEvidence(items, []), EvidenceValidationError)
  })

  it('requires receipt ref for passing-test-observed', () => {
    const items = [{ kind: 'passing-test-observed', refs: ['file:src/index.ts'] }]
    assert.throws(() => validateEvidence(items, ['passing-test-observed']), EvidenceValidationError)
  })

  it('passes passing-test-observed with receipt ref + resolver returning 0', () => {
    const items = [{ kind: 'passing-test-observed', refs: ['receipt:abc123'] }]
    const result = validateEvidence(items, ['passing-test-observed'], {
      resolveReceipt: ref => ({ exitCode: 0 }),
    })
    assert.equal(result.length, 1)
  })

  it('allows anyOf evidence', () => {
    const items = [{ kind: 'passing-test-observed', refs: ['receipt:abc'] }]
    const result = validateEvidence(items, [{ anyOf: ['passing-test-observed', 'manual-verification'] }], {
      resolveReceipt: () => ({ exitCode: 0 }),
    })
    assert.equal(result.length, 1)
  })
})

describe('activation lifecycle', () => {
  it('starts at first stage of a capability', () => {
    const decision = { capabilityId: CAPABILITY.IMPLEMENTATION_EXECUTE, blocked: false as const, requiredEvidence: [], provider: 'implementer' }
    const activation = startActivation(decision)
    assert.equal(activation.capabilityId, CAPABILITY.IMPLEMENTATION_EXECUTE)
    assert.equal(activation.stageId, 'implement')
    assert.equal(activation.completedStages.length, 0)
  })

  it('nextCommand returns objective and expectedEvidence', () => {
    const decision = { capabilityId: CAPABILITY.IMPLEMENTATION_EXECUTE, blocked: false as const, requiredEvidence: [], provider: 'implementer' }
    const activation = startActivation(decision)
    const command = nextCommand(activation, 'implementer')
    assert.ok(command.objective)
    assert.ok(command.expectedEvidence.length > 0)
  })

  it('advances through stages', () => {
    const decision = { capabilityId: CAPABILITY.IMPLEMENTATION_EXECUTE, blocked: false as const, requiredEvidence: [], provider: 'implementer' }
    const activation = startActivation(decision)
    const command = nextCommand(activation, 'implementer')
    const evidence = [{ kind: 'implementation-complete', refs: ['file:src/index.ts:1'] }]
    const { activation: next, completed } = advanceActivation(activation, evidence, command)
    assert.ok(next.completedStages.includes('implement'))
    assert.equal(completed, false) // still has verify stage
  })

  it('throws EvidenceValidationError on wrong evidence', () => {
    const decision = { capabilityId: CAPABILITY.TESTING_TDD, blocked: false as const, requiredEvidence: [], provider: 'tdd-guide' }
    const activation = startActivation(decision)
    const command = nextCommand(activation, 'tdd-guide')
    const badEvidence = [{ kind: 'implementation-complete', refs: [] }]
    assert.throws(() => advanceActivation(activation, badEvidence, command))
  })
})
