import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { declarationSchema, parseDeclaration } from './declaration-contract.ts'

test('project declarations optionally select absolute workspaces without changing legacy items', () => {
  const item = { text: '项目使用 pnpm。', scope: 'project', basis: 'user_statement', quote: '项目使用 pnpm。' }
  assert.deepEqual(declarationSchema.parse({ items: [item] }), { items: [item] })
  const workspaces = [resolve('/workspace', 'a'), resolve('/workspace', 'b')]
  const declaration = { items: [{ ...item, workspaces }] }
  assert.deepEqual(parseDeclaration(`<!-- jth-memory ${JSON.stringify(declaration)} -->`), declaration)
  assert.throws(() => declarationSchema.parse({ items: [{ ...item, workspaces: [] }] }))
  assert.throws(() => declarationSchema.parse({ items: [{ ...item, workspaces: ['relative/path'] }] }), /绝对路径/)
  assert.throws(() => declarationSchema.parse({ items: [{ ...item, workspaces: [workspaces[0], workspaces[0]] }] }), /不得重复/)
  for (const scope of ['user', 'business', 'current_task', 'unspecified']) {
    assert.throws(() => declarationSchema.parse({ items: [{ ...item, scope, workspaces }] }), /仅用于 project/)
  }
})

test('explicit decisions preserve legacy declarations and never turn skip reasons into knowledge', () => {
  const decision = { action: 'skip', reason: '本轮没有新的可复用事实。' }
  assert.deepEqual(declarationSchema.parse({ items: [], decision }), { items: [], decision })
  const used = ['11111111-1111-4111-8111-111111111111']
  assert.deepEqual(declarationSchema.parse({ items: [], used, decision }), { items: [], used, decision })
  const item = { text: '项目使用 pnpm。', scope: 'project', basis: 'user_statement', quote: '项目使用 pnpm。' }
  assert.throws(() => declarationSchema.parse({ items: [item], decision }), /skip 决定不能包含/)
  assert.throws(() => declarationSchema.parse({ items: [], used, decision: { action: 'record', reason: '新增事实。' } }), /record 决定必须包含/)
  assert.throws(() => declarationSchema.parse({ items: [], decision: { action: 'skip', reason: ' ' } }))
  assert.throws(() => declarationSchema.parse({ items: [] }))
  assert.equal(declarationSchema.parse({ items: [item], decision: { action: 'record', reason: '用户明确指定包管理器。' } }).decision?.action, 'record')
})
