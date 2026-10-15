import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PoolClient } from 'pg'
import { readMemoAnalysis } from './analysis-read.ts'

test('Memo analysis uses scoped cutoff queries inside a read-only snapshot', async () => {
  const queries: { sql: string, values?: unknown[] }[] = []
  const database = { query: async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values })
    return { rows: sql.startsWith('SELECT id,kind,created_at') ? [{ id: 'submission-fixture', kind: 'index', created_at: '2026-10-15T01:00:00Z',
      status: null, attempts: null, error: null, updated_at: null, later_state_unavailable: true }] : [] }
  } } as unknown as PoolClient
  const result = await readMemoAnalysis(database, ['selected-session', 'selected-session'], '2026-10-15T02:00:00Z')
  assert.equal(queries[0].sql, 'BEGIN')
  assert.equal(queries[1].sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(queries.at(-1)!.sql, 'COMMIT')
  for (const query of queries.slice(2, -1)) {
    assert(!/INSERT|UPDATE|DELETE|CREATE|ALTER/.test(query.sql))
    assert.equal(query.values?.[1], '2026-10-15T02:00:00Z')
    assert(query.values?.[0] === 'selected-session' || Array.isArray(query.values?.[0]))
  }
  assert.equal(result.length, 1)
  assert.equal(result[0].sessionId, 'selected-session')
  assert.equal(result[0].value.status, null)
  assert.equal(result[0].value.later_state_unavailable, true)
})
