import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { declarationSchema, findDeclarationBlock, parseDeclaration } from './declaration-contract.ts'

const skipped = { decision: { action: 'skip', reason: '本轮没有新的可复用事实。' }, items: [], used: [] }
const skipYaml = '# JTH · 附注\ndecision:\n  action: skip\n  reason: 本轮没有新的可复用事实。\nitems: []\nused: []'
const fenced = (format: 'yaml' | 'json', content: string, fence = '```') => `${fence}${format} jth-memory\n${content}\n${fence}`

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

test('one marked YAML declaration preserves all schema fields and the JSON alternative is lossless', () => {
  const source = '11111111-1111-4111-8111-111111111111'
  const target = '22222222-2222-4222-8222-222222222222'
  const declaration = {
    decision: { action: 'record', reason: '保留完整字段：不做摘要。' },
    items: [
      {
        text: '项目路径：/workspace/a#b\n第二行 "完整保留"。', scope: 'project', workspaces: ['/workspace/a#b', '/workspace/中文路径'],
        basis: 'tool_observation', quote: '原始输出："value: #tag"', change: { kind: 'supplement', target },
      },
      { text: '用户确认沿用当前配置。', scope: 'user', basis: 'user_confirmed', quote: '当前配置不变。', confirmation_quote: '可以，保留。' },
      { text: '候选推断仍需核实。', scope: 'current_task', basis: 'agent_inference', quote: '由现有事实推断。', derived_from: [source] },
    ],
    used: [source, target],
  }
  const yaml = [
    '# JTH · 附注',
    'decision:',
    '  action: record',
    '  reason: "保留完整字段：不做摘要。"',
    'items:',
    '  - text: |-',
    '      项目路径：/workspace/a#b',
    '      第二行 "完整保留"。',
    '    scope: project',
    '    workspaces:',
    '      - /workspace/a#b',
    '      - /workspace/中文路径',
    '    basis: tool_observation',
    '    quote: \'原始输出："value: #tag"\'',
    '    change:',
    '      kind: supplement',
    `      target: ${target}`,
    '  - text: 用户确认沿用当前配置。',
    '    scope: user',
    '    basis: user_confirmed',
    '    quote: 当前配置不变。',
    '    confirmation_quote: 可以，保留。',
    '  - text: 候选推断仍需核实。',
    '    scope: current_task',
    '    basis: agent_inference',
    '    quote: 由现有事实推断。',
    '    derived_from:',
    `      - ${source}`,
    'used:',
    `  - ${source}`,
    `  - ${target}`,
  ].join('\n')
  assert.deepEqual(parseDeclaration(`交付正文。\n\n${fenced('yaml', yaml)}`), declaration)
  assert.deepEqual(parseDeclaration(fenced('json', JSON.stringify(declaration, null, 2))), declaration)
})

test('marked fences preserve empty arrays, absent legacy decisions, line endings and fence lengths', () => {
  assert.deepEqual(parseDeclaration(fenced('yaml', skipYaml)), skipped)
  assert.deepEqual(parseDeclaration(fenced('yaml', skipYaml, '~~~~').replaceAll('\n', '\r\n')), skipped)
  assert.deepEqual(parseDeclaration(`${fenced('yaml', skipYaml)}\`\` \t\n`), skipped)
  const item = { text: '项目使用 pnpm。', scope: 'project', basis: 'user_statement', quote: '项目使用 pnpm。' }
  assert.deepEqual(parseDeclaration(fenced('json', JSON.stringify({ items: [item] }))), { items: [item] })
  const body = '正文含 emoji 😀。\n'
  assert.deepEqual(findDeclarationBlock(body + fenced('yaml', skipYaml)), { start: body.length, format: 'yaml', content: skipYaml + '\n' })
})

test('unmarked, quoted, nested, inline and non-trailing examples never execute', () => {
  const declaration = fenced('yaml', skipYaml)
  const examples = [
    `\`\`\`yaml\n${skipYaml}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify(skipped)}\n\`\`\``,
    declaration.replace('yaml jth-memory', 'yaml jth-memory-example'),
    declaration.replace('yaml jth-memory', 'jth-memory yaml'),
    declaration.replace('yaml jth-memory', 'yml jth-memory'),
    `引用示例：${declaration}`,
    declaration.split('\n').map(line => `> ${line}`).join('\n'),
    declaration.split('\n').map(line => `  ${line}`).join('\n'),
    `- 示例\n${declaration.split('\n').map(line => `  ${line}`).join('\n')}`,
    `\`\`\`\`markdown\n${declaration}\n\`\`\`\``,
    `~~~markdown\n${declaration}\n~~~`,
    `${declaration}\n后续正文。`,
    `\`\`\`text\n<!-- jth-memory ${JSON.stringify(skipped)} -->\n\`\`\``,
    `> <!-- jth-memory ${JSON.stringify(skipped)} -->`,
  ]
  for (const text of examples) {
    assert.equal(findDeclarationBlock(text), null, text)
    assert.equal(parseDeclaration(text), null, text)
  }
  assert.deepEqual(parseDeclaration(`\`\`\`json\n{"example":true}\n\`\`\`\n${declaration}`), skipped)
  assert.deepEqual(parseDeclaration(`${declaration}\n中间示例结束。\n${fenced('json', JSON.stringify(skipped))}`), skipped)
})

test('invalid trailing declarations remain identifiable without becoming valid declarations', () => {
  for (const [format, content] of [['yaml', 'items: ['], ['json', '{bad json}']] as const) {
    const text = `交付正文。\n${fenced(format, content)}`
    assert.deepEqual(findDeclarationBlock(text), { start: '交付正文。\n'.length, format, content: content + '\n' })
    assert.throws(() => parseDeclaration(text))
  }
  for (const format of ['yaml', 'json'] as const) {
    const text = `交付正文。\n\`\`\`${format} jth-memory\n${format === 'yaml' ? skipYaml : JSON.stringify(skipped)}`
    assert.equal(findDeclarationBlock(text)?.start, '交付正文。\n'.length)
    assert.throws(() => parseDeclaration(text), /未完整结束/)
  }
  assert.throws(() => parseDeclaration(fenced('yaml', 'items: []')), /声明需要新事实/)
  const legacy = `<!-- jth-memory ${JSON.stringify(skipped)} -->`
  assert.deepEqual(findDeclarationBlock(legacy), { start: 0, format: 'legacy-json', content: JSON.stringify(skipped) })
  assert.deepEqual(parseDeclaration(legacy), skipped)
  for (const whitespace of [' ', '   ', '    ', '\t', ' \t  ', '\u00a0']) {
    assert.deepEqual(parseDeclaration(whitespace + legacy), skipped)
    assert.equal(findDeclarationBlock(whitespace + legacy)?.start, whitespace.length)
    assert.equal(parseDeclaration(whitespace + fenced('yaml', skipYaml)), null)
  }
  assert.deepEqual(parseDeclaration(`${legacy}\n这是历史格式示例。\n${legacy}`), skipped)
  assert.equal(findDeclarationBlock(`${legacy}\n这是历史格式示例。\n${legacy}`)?.start, `${legacy}\n这是历史格式示例。\n`.length)
  assert.equal(findDeclarationBlock('<!-- jth-memory {bad json} -->')?.format, 'legacy-json')
  assert.throws(() => parseDeclaration('<!-- jth-memory {bad json} -->'))
})

test('YAML rejects duplicate keys, aliases, multiple documents and unsupported tags', () => {
  for (const content of [
    skipYaml + '\nitems: []',
    skipYaml.replace('items: []\nused: []', 'items: &items []\nused: *items'),
    skipYaml + '\n---\n' + skipYaml,
    skipYaml.replace('reason: 本轮没有新的可复用事实。', 'reason: !custom 本轮没有新的可复用事实。'),
  ]) assert.throws(() => parseDeclaration(fenced('yaml', content)), content)
  assert.throws(() => parseDeclaration(fenced('json', JSON.stringify(skipped).replace('"items":[]', '"items":[],"items":[]'))), /unique/)
  assert.throws(() => parseDeclaration(fenced('json', skipYaml)))
})

test('the original 8192-byte limit covers the whole declaration, not ordinary reply text', () => {
  const declaration = fenced('yaml', skipYaml + '\n# ')
  const remainingBytes = 8192 - Buffer.byteLength(declaration)
  const bounded = declaration.replace('\n# \n', '\n# ' + 'x'.repeat(remainingBytes) + '\n')
  assert.equal(Buffer.byteLength(bounded), 8192)
  assert.deepEqual(parseDeclaration('正文'.repeat(10_000) + '\n' + bounded), skipped)
  assert.throws(() => parseDeclaration(bounded.replace('\n# ', '\n# 多')), /8192/)
  assert.throws(() => parseDeclaration(`<!-- jth-memory ${JSON.stringify(skipped)}${' '.repeat(8192)} -->`), /8192/)
})
