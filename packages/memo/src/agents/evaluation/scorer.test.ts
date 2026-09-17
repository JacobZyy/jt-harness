import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cases } from './cases.ts'
import { parseVerdict } from './judge.ts'
import type { Extraction } from '../../contracts.ts'

test('评分必须覆盖全部规则和输出记录，不能遗漏或重复计分', () => {
  const output: Extraction = { schema_version: 1, memories: [], proposals: [], revisions: [] }
  const criteria = cases[0].criteria.map(rule => ({ id: rule.id, pass: true, reason: 'fixture' }))
  assert.doesNotThrow(() => parseVerdict(JSON.stringify({ criteria, items: [] }), cases[0], output))
  assert.throws(() => parseVerdict(JSON.stringify({ criteria: criteria.slice(1), items: [] }), cases[0], output))
  assert.throws(() => parseVerdict(JSON.stringify({ criteria: [criteria[0], criteria[0]], items: [] }), cases[0], output))
  assert.throws(() => parseVerdict(JSON.stringify({ criteria, items: [{ path: 'memories.0', supported: true, reason: 'invented' }] }), cases[0], output))
  assert.equal(cases.length, 30)
  assert.equal(cases.reduce((sum, item) => sum + item.repeat, 0), 42)
})
