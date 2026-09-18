import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { extractMemories, finishExtraction } from './extract.ts'
import { optionsSchema, parseExtraction, submissionSchema } from '../contracts.ts'

const sample = JSON.parse(await readFile(new URL('./example.json', import.meta.url), 'utf8'))
const submission = submissionSchema.parse(sample)
const valid = {
  schema_version: 1,
  memories: [{ content: '当前只支持 Codex。', basis: 'user_statement', scope: 'project', source_message_ids: ['m1'] }],
  proposals: [{ content: '建议采用 DSH 插件。', basis: 'assistant_proposal', scope: 'project', source_message_ids: ['m2'] }],
  revisions: [{
    kind: 'correction',
    earlier_content: '发货完成属于业务状态。',
    later_content: '发货完成只是前端临时态。',
    explanation: '用户明确纠正了业务状态与展示状态的分类。',
    source_message_ids: ['m5', 'm6'],
  }],
}

test('会话材料保留原文，拒绝重复来源、未知角色和超限输入', () => {
  assert.deepEqual(submission, sample)
  assert.throws(() => submissionSchema.parse({ ...sample, messages: [sample.messages[0], sample.messages[0]] }))
  assert.throws(() => submissionSchema.parse({ ...sample, messages: [{ ...sample.messages[0], role: 'system' }] }))
  assert.throws(() => submissionSchema.parse({ ...sample, messages: [{ ...sample.messages[0], text: '中'.repeat(86_000) }] }))
  assert.throws(() => submissionSchema.parse({ ...sample, messages: [] }))
})

test('结构化结果绑定真实 ID 与范围；事实分类交给 Agent，不按角色组合拒收', () => {
  assert.deepEqual(parseExtraction(JSON.stringify(valid), submission), valid)
  const unknownSource = structuredClone(valid)
  unknownSource.memories[0].source_message_ids = ['invented']
  assert.throws(() => parseExtraction(JSON.stringify(unknownSource), submission), /不存在的消息/)
  const falseConfirmation = structuredClone(valid)
  falseConfirmation.memories[0].basis = 'user_confirmed'
  falseConfirmation.memories[0].source_message_ids = ['m2']
  assert.doesNotThrow(() => parseExtraction(JSON.stringify(falseConfirmation), submission))
  falseConfirmation.memories[0].source_message_ids = ['m1', 'm2']
  assert.doesNotThrow(() => parseExtraction(JSON.stringify(falseConfirmation), submission))
  falseConfirmation.memories[0].source_message_ids = ['m2', 'm4']
  assert.doesNotThrow(() => parseExtraction(JSON.stringify(falseConfirmation), submission))
  // Classification does not rewrite the source's actual roles or chronology.
  assert.equal(submission.messages.find(message => message.message_id === 'm2')!.role, 'assistant')
  const noBusinessScope = { ...submission, scope: { project_ids: ['jt-harness'], business_ids: [] } }
  const wrongScope = structuredClone(valid)
  wrongScope.memories[0].scope = 'business'
  assert.throws(() => parseExtraction(JSON.stringify(wrongScope), noBusinessScope), /业务范围/)
  assert.throws(() => parseExtraction('```json\n{}\n```', submission))
  assert.throws(() => parseExtraction(JSON.stringify({ ...valid, saved: true }), submission))
  assert.deepEqual(parseExtraction('{"schema_version":1,"memories":[],"proposals":[],"revisions":[]}', submission).memories, [])
})

test('模型配置按任务校验；超时和 token 上限不能失效', () => {
  assert.equal(optionsSchema.parse({ provider: 'test', model: 'test' }).timeoutMs, 180_000)
  assert.throws(() => optionsSchema.parse({ provider: '', model: 'test' }))
  assert.throws(() => optionsSchema.parse({ provider: 'test', model: 'test', timeoutMs: -1 }))
  assert.throws(() => optionsSchema.parse({ provider: 'test', model: 'test', maxTokens: 0 }))
})

test('只有 completed 且无工具调用才返回提炼结果', () => {
  // Deliberately small wire fixtures; unrelated SDK event fields are not read here.
  const result = {
    sessionId: 'test-session', finalResponse: JSON.stringify(valid), notifications: [],
    events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
  } as unknown as RunResult
  assert.deepEqual(finishExtraction(result, submission), valid)
  for (const kind of ['max_tokens', 'error', 'aborted']) {
    const failed = { ...result, events: [{ type: 'turn/end', data: { reason: { kind } } }] } as unknown as RunResult
    assert.throws(() => finishExtraction(failed, submission), /未完成提炼/)
  }
  assert.throws(() => finishExtraction({ ...result, events: [] }, submission), /missing turn\/end/)
  const withTool = { ...result, events: [...result.events, { type: 'tool/call', data: {} }] } as unknown as RunResult
  assert.throws(() => finishExtraction(withTool, submission), /调用了工具/)
  const withSchema = { ...result, events: [...result.events, { type: 'request/header', data: { header: { tools: [{ name: 'bash' }] } } }] } as unknown as RunResult
  assert.throws(() => finishExtraction(withSchema, submission), /暴露了额外工具/)
})

test('真实 DSH 提炼保留建议、任务范围和纠正，忽略资料中的提示注入', {
  skip: process.env.DSH_MEMORY_LIVE !== '1',
  timeout: 200_000,
}, async () => {
  const runtime = optionsSchema.parse(JSON.parse(await readFile(new URL('./runtime.json', import.meta.url), 'utf8')))
  const result = await extractMemories(submission, runtime)
  await writeFile(new URL('../../../../artifacts/memory-agent/example-result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  assert(result.memories.some(item => item.scope === 'project' && item.source_message_ids.includes('m1')))
  assert(result.proposals.some(item => item.basis === 'assistant_proposal' && item.source_message_ids.includes('m2')))
  assert(!result.memories.some(item => item.source_message_ids.includes('m2')))
  assert(result.memories.some(item => item.scope === 'current_task' && item.source_message_ids.includes('m4')))
  assert(result.revisions.some(item => item.kind === 'correction'
    && item.source_message_ids.includes('m5') && item.source_message_ids.includes('m6')))
  assert(![...result.memories, ...result.proposals].some(item => item.source_message_ids.includes('m7')))
})
