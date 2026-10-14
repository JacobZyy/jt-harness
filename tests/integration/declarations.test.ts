import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Pool } from 'pg'
import { loadConfig, prepareDatabase, MemoStorage, runIndexWorker, retryJob, enqueue, executionProfile, storageDoctor, recordDeclaration } from '@jt-harness/memo'
import type { Evidence, MemoryDeclaration, RecordDraft } from '@jt-harness/memo/contracts'
import { captureDeclaration, rememberEntryRead } from '@jt-harness/codex-hooks'
import type { CaptureSettings } from '@jt-harness/codex-hooks'
import { receiveRecords } from '../../packages/cli/src/ingest.ts'
import { ensureUserConfig } from '../../packages/cli/src/configuration.ts'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

test('installed declaration CLI persists a cross-turn approval with both sources, defaults to index-only and stays idempotent', { skip: !process.env.JTH_TEST_DATABASE_URL, timeout: 20000 }, async () => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-declaration-cli-')))
  const home = resolve(directory, 'codex'), source = resolve(home, 'sessions/rollout-declaration-cli-session.jsonl'), envFile = resolve(directory, '.env')
  const root = fileURLToPath(new URL('../../', import.meta.url)), execute = promisify(execFile)
  let calls = 0
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(request.url, '/v1/embeddings')
    assert.deepEqual(body.input, ['项目已决定使用 pnpm，待实施。'])
    calls++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ model: 'declaration-cli', data: [{ index: 0, embedding: [1, 0] }] }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string')
  await mkdir(resolve(home, 'sessions'), { recursive: true })
  await writeFile(envFile, `JTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\nJTH_DATA_DIR=${directory}/data\nEMBEDDING_API_KEY=test\nEMBEDDING_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBEDDING_MODEL=declaration-cli\nEMBEDDING_DIMENSIONS=2\nJTH_DSH_BIN=/must-not-run-dsh\n`)
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(JTH_|EMBEDDING_|CODEX_)/.test(name))),
    HOME: directory, CODEX_HOME: home, CODEX_THREAD_ID: 'declaration-cli-session', JTH_CONFIG_DIR: resolve(directory, 'user-config'),
    JTH_DATABASE_URL: process.env.JTH_TEST_DATABASE_URL, JTH_DATA_DIR: resolve(directory, 'data'), JTH_PG_DATA_DIR: '', JTH_PG_BIN_DIR: '',
    EMBEDDING_API_KEY: 'test', EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}/v1`, EMBEDDING_MODEL: 'declaration-cli', EMBEDDING_DIMENSIONS: '2', JTH_DSH_BIN: '/must-not-run-dsh' }
  const cli = (...args: string[]) => execute(process.execPath, [resolve(root, 'bin/jth.ts'), 'memo', ...args, '--env-file', envFile], { cwd: directory, env: environment })
  let hookCommand = ''
  const hook = (text: string) => new Promise<void>((done, reject) => {
    const child = execFile('/bin/sh', ['-c', hookCommand], { cwd: directory, env: { ...environment, PATH: `${resolve(directory, 'bin')}:${process.env.PATH}` } }, (error, stdout, stderr) => {
      if (error) { reject(error); return }
      try { assert.equal(stdout, ''); assert.equal(stderr, ''); done() } catch (failure) { reject(failure) }
    })
    child.stdin!.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'declaration-cli-session', cwd: directory, transcript_path: source, last_assistant_message: text }))
  })
  try {
    await mkdir(resolve(directory, 'bin'))
    await symlink(resolve(root, 'bin/jth.ts'), resolve(directory, 'bin/jth'))
    await prepareDatabase(pool, true)
    const installed = JSON.parse((await cli('codex', 'install', '--workspace', directory, '--codex-home', home, '--project', 'declaration-cli')).stdout)
    assert.equal(installed.mode, 'user-declaration')
    assert.equal(installed.hooks_path, resolve(home, 'hooks.json'))
    const hooks = JSON.parse(await readFile(resolve(home, 'hooks.json'), 'utf8')).hooks
    assert.deepEqual(new Set(Object.keys(hooks)), new Set(['Stop', 'SessionStart', 'UserPromptSubmit']))
    hookCommand = hooks.Stop.flatMap((group: { hooks: { command: string, statusMessage: string }[] }) => group.hooks)
      .find((handler: { statusMessage: string }) => handler.statusMessage === 'jth memo declaration').command
    const row = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n'
    const text = '<!-- jth-memory {"items":[{"text":"项目已决定使用 pnpm，待实施。","scope":"project","basis":"user_confirmed","quote":"建议项目使用 pnpm。","confirmation_quote":"可以，你做吧。"}]} -->'
    await writeFile(source, row('session_meta', { id: 'declaration-cli-session', cwd: directory, runtime_workspace_roots: [directory] })
      + row('event_msg', { type: 'item_completed', thread_id: 'declaration-cli-session', item: { id: 'proposal', type: 'AgentMessage', content: [{ type: 'text', text: '建议项目使用 pnpm。' }] } })
      + row('event_msg', { type: 'item_completed', thread_id: 'declaration-cli-session', item: { id: 'u', type: 'UserMessage', content: [{ type: 'text', text: '可以，你做吧。' }] } })
      + row('event_msg', { type: 'item_completed', thread_id: 'declaration-cli-session', item: { id: 'a', type: 'AgentMessage', content: [{ type: 'text', text }] } }))
    await hook('普通回复。')
    assert.equal(calls, 0)
    await hook(text)
    let entryId = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = (await pool.query("SELECT e.id,e.state FROM jt_memo.entry_states e WHERE e.project_ids @> ARRAY['declaration-cli'] AND e.state='active'")).rows
      if (rows.length) { entryId = rows[0].id; break }
      await delay(50)
    }
    if (!entryId) {
      const worker = await readFile(resolve(directory, 'data/worker.log'), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'worker log absent'; throw error })
      const status = JSON.parse((await cli('codex', 'status')).stdout)
      assert.fail(`The detached worker must publish the declared fact: ${JSON.stringify({ worker, status })}`)
    }
    assert.equal(calls, 1)
    const entry = await new MemoStorage(pool).getEntry(entryId)
    assert.equal(entry.basis, 'user_confirmed')
    assert.deepEqual(entry.messages.map(message => [message.role, message.text]), [['assistant', '建议项目使用 pnpm。'], ['user', '可以，你做吧。']])
    await hook(text)
    await cli('work')
    assert.equal(calls, 1)
    await cli('read', entryId, '--source-session', 'declaration-cli-session')
    const status = JSON.parse((await cli('codex', 'status')).stdout)
    assert.equal(status.mode, 'declaration')
    await assert.rejects(cli('send', source), /--legacy/)
    await cli('codex', 'uninstall')
    const remaining = JSON.parse(await readFile(resolve(home, 'hooks.json'), 'utf8')).hooks
    assert(!JSON.stringify(remaining).includes('jth memo declaration'))
  } finally { await pool.end(); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }) }
})

test('declarations preserve source, deduplicate across turns, apply explicit revisions and retry only Embedding', { skip: !process.env.JTH_TEST_DATABASE_URL }, async t => {
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL, max: 5 })
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'jth_test')
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-declaration-db-')), home = resolve(directory, 'codex')
  const envFile = resolve(directory, '.env'), sourceFile = resolve(home, 'sessions/parent.jsonl')
  await mkdir(resolve(home, 'sessions'), { recursive: true })
  await writeFile(envFile, `JTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\nJTH_DATA_DIR=${directory}/data\nEMBEDDING_API_KEY=test\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=declaration-test\nEMBEDDING_DIMENSIONS=2\nJTH_DSH_BIN=/must-not-run-dsh\n`)
  const environment = { JTH_CONFIG_DIR: resolve(directory, 'user-config') }
  let config = await loadConfig(process.cwd(), envFile, environment)
  const storage = new MemoStorage(pool)
  const settings = { workspace: directory, codex_home: home, env_file: envFile, enabled_at: '2026-01-01T00:00:00Z', scope: { project_ids: ['declaration-test'], business_ids: [] } }
  const row = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n'
  await writeFile(sourceFile, row('session_meta', { id: 'declaration-session' }))
  let calls = 0, fail = false, turn = 0
  const api = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(url), 'https://example.invalid/v1/embeddings')
    const body = JSON.parse(String(init?.body))
    assert(body.input.every((text: string) => text.length < 500), 'Only short memory bodies may leave the machine')
    calls++
    return fail ? Response.json({}, { status: 503 }) : Response.json({ model: 'declaration-test', data: [{ index: 0, embedding: [1, 0] }] })
  })
  const capture = (text: string) => captureDeclaration({ hook_event_name: 'Stop', session_id: 'declaration-session', cwd: directory, transcript_path: sourceFile, last_assistant_message: text }, settings, config)
  const declare = async (text: string, change?: object) => {
    turn++
    const output = `完成。\n<!-- jth-memory ${JSON.stringify({ items: [{ text, scope: 'project', basis: 'user_statement', quote: text, ...(change ? { change } : {}) }] })} -->`
    await appendFile(sourceFile, row('event_msg', { type: 'item_completed', thread_id: 'declaration-session', item: { id: `u${turn}`, type: 'UserMessage', content: [{ type: 'text', text }] } })
      + row('event_msg', { type: 'item_completed', thread_id: 'declaration-session', item: { id: `a${turn}`, type: 'AgentMessage', content: [{ type: 'text', text: output }] } }))
    await capture(output)
    return output
  }
  const accept = async () => {
    const result = await receiveRecords(pool, config)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.declaration_errors, [])
    return result.accepted as { declaration_id: string, submission_id: string | null, entry_ids: string[], new_facts: number, linked_sources: number }[]
  }
  const work = () => runIndexWorker(pool, file => loadConfig(process.cwd(), file, environment))
  try {
    await prepareDatabase(pool, true)
    const beforeJobs = (await pool.query('SELECT count(*)::int AS count FROM jt_memo.jobs')).rows[0].count
    assert.equal(await capture('没有新增结论。'), null)
    assert.equal((await accept()).length, 0)
    assert.equal(calls, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM jt_memo.jobs')).rows[0].count, beforeJobs)

    const first = await declare('项目使用 pnpm。')
    await capture(first)
    const [initial] = await accept()
    assert.equal(initial.new_facts, 1)
    assert.equal(calls, 0)
    const original = await storage.getSubmission(initial.submission_id!)
    assert(original.submission.messages.some(message => message.text === '项目使用 pnpm。'))
    const legacyId = 'declaration-legacy-must-not-run'
    await enqueue(pool, { ...original.submission, submission_id: legacyId }, executionProfile(config))

    const oldConfigPath = config.envFile
    const migrated = await ensureUserConfig(process.cwd(), envFile, environment)
    await rename(envFile, `${envFile}.retained`)
    config = await loadConfig(process.cwd(), oldConfigPath, environment)
    assert.equal(config.envFile, migrated.envFile)
    assert.equal((await pool.query('SELECT execution FROM jt_memo.jobs WHERE id=$1', [initial.submission_id])).rows[0].execution.envFile, oldConfigPath)

    await declare('项目使用 pnpm。')
    const [pendingDuplicate] = await accept()
    assert.equal(pendingDuplicate.new_facts, 0, 'An accepted but unindexed fact must already deduplicate')
    assert.deepEqual(pendingDuplicate.entry_ids, initial.entry_ids)
    const firstWork = await work()
    assert.equal(firstWork.completed, 1, JSON.stringify({ firstWork, jobs: (await pool.query("SELECT id,status,error FROM jt_memo.jobs WHERE kind='index' AND status<>'complete'")).rows }))
    assert.equal(calls, 1)
    await declare('项目使用 pnpm。')
    const [duplicate] = await accept()
    assert.equal(duplicate.submission_id, null)
    assert.equal(duplicate.linked_sources, 1)
    assert.equal((await work()).completed, 0)
    assert.equal(calls, 1)
    const old = await storage.getEntry(initial.entry_ids[0])
    assert.equal(old.additional_sources.length, 2)
    assert.equal(old.state, 'active')

    await rememberEntryRead(config, 'declaration-session', old.id, old.version!)
    await declare('明确更正：项目改用 npm，旧 pnpm 约定作废。', { kind: 'correction', target: old.id })
    const [correction] = await accept()
    assert.equal((await work()).completed, 1)
    assert.equal((await storage.getEntry(old.id)).state, 'superseded')
    assert.equal((await storage.getEntry(correction.entry_ids[0])).state, 'active')

    await declare('请求超时为 17 秒。')
    const [recovery] = await accept()
    const sourceBefore = (await storage.getSubmission(recovery.submission_id!)).submission
    fail = true
    assert.equal((await work()).failed, 1)
    fail = false
    await retryJob(pool, recovery.submission_id!)
    assert.equal((await work()).completed, 1)
    assert.deepEqual((await storage.getSubmission(recovery.submission_id!)).submission, sourceBefore)
    assert.equal((await pool.query('SELECT status FROM jt_memo.jobs WHERE id=$1', [legacyId])).rows[0].status, 'queued')
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM jt_memo.agent_outputs WHERE submission_id LIKE 'record-%'")).rows[0].count, 0)
    assert.equal((await storageDoctor(pool)).ok, true)

    const receipt = (await pool.query('SELECT draft,evidence FROM jt_memo.declaration_receipts WHERE id=$1', [duplicate.declaration_id])).rows[0] as { draft: RecordDraft, evidence: Evidence }
    const changedScope = structuredClone(receipt.evidence)
    changedScope.submission.scope.project_ids = ['declaration-other-project']
    changedScope.id = 'evidence-' + '1'.repeat(64)
    changedScope.submission.submission_id = changedScope.id
    const other = await recordDeclaration(pool, { ...receipt.draft, evidence_id: changedScope.id }, changedScope, config)
    assert.equal(other.new_facts, 1, 'Equal text in another scope is independent')
    await work()
  } finally { api.mock.restore(); await pool.end(); await rm(directory, { recursive: true, force: true }) }
})

test('workspace declarations keep independent facts, shared facts, primary defaults and legacy scopes distinct', { skip: !process.env.JTH_TEST_DATABASE_URL }, async t => {
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL, max: 4 })
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-workspace-declaration-')))
  const home = resolve(directory, 'codex'), envFile = resolve(directory, '.env'), sourceFile = resolve(home, 'sessions/parent.jsonl')
  const a = resolve(directory, 'a'), b = resolve(directory, 'b')
  await Promise.all([mkdir(resolve(home, 'sessions'), { recursive: true }), mkdir(a), mkdir(b)])
  await writeFile(envFile, `JTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\nJTH_DATA_DIR=${directory}/data\nEMBEDDING_API_KEY=test\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=workspace-declaration-test\nEMBEDDING_DIMENSIONS=2\nJTH_DSH_BIN=/must-not-run-dsh\n`)
  const config = await loadConfig(process.cwd(), envFile, {})
  const storage = new MemoStorage(pool)
  const settings: CaptureSettings = {
    workspace: a, codex_home: home, env_file: envFile, enabled_at: '2026-01-01T00:00:00Z',
    scope: { project_ids: ['workspace-a', 'workspace-b'], business_ids: [] },
    workspaces: [
      { path: a, project_ids: ['workspace-a'], business_ids: [] },
      { path: b, project_ids: ['workspace-b'], business_ids: [] },
    ],
  }
  const row = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n'
  await writeFile(sourceFile, row('session_meta', { id: 'workspace-declaration-session' }))
  const api = t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    return Response.json({ model: 'workspace-declaration-test', data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) })
  })
  let turn = 0
  const declare = async (items: MemoryDeclaration['items'], captureSettings = settings) => {
    turn++
    const output = `完成。\n<!-- jth-memory ${JSON.stringify({ items })} -->`
    await appendFile(sourceFile, items.map((item, index) => row('event_msg', {
      type: 'item_completed', thread_id: 'workspace-declaration-session', item: {
        id: `source-${turn}-${index}`, type: ['assistant_proposal', 'agent_inference'].includes(item.basis) ? 'AgentMessage' : 'UserMessage',
        content: [{ type: 'text', text: item.quote }],
      },
    })).join('') + row('event_msg', { type: 'item_completed', thread_id: 'workspace-declaration-session', item: { id: `answer-${turn}`, type: 'AgentMessage', content: [{ type: 'text', text: output }] } }))
    await captureDeclaration({ hook_event_name: 'Stop', session_id: 'workspace-declaration-session', cwd: captureSettings.workspace, transcript_path: sourceFile, last_assistant_message: output }, captureSettings, config)
    const received = await receiveRecords(pool, config)
    assert.deepEqual(received.declaration_errors, [])
    assert.deepEqual(received.errors, [])
    return received.accepted as { entry_ids: string[], new_facts: number }[]
  }
  const fact = (text: string, workspaces?: string[]): MemoryDeclaration['items'][number] => ({ text, quote: text, scope: 'project', basis: 'user_statement', ...(workspaces ? { workspaces } : {}) })
  const work = () => runIndexWorker(pool, async () => config)
  try {
    await prepareDatabase(pool, true)
    const receipts = await declare([fact('目录 A 使用 pnpm。', [a]), fact('目录 B 使用 npm。', [b]), fact('两个目录共同使用接口 v2。', [a, b])])
    assert.equal(receipts.length, 3)
    assert.equal(receipts.reduce((count, receipt) => count + receipt.new_facts, 0), 3)
    assert.equal((await work()).completed, 3)
    const entries = await Promise.all(receipts.flatMap(receipt => receipt.entry_ids).map(id => storage.getEntry(id)))
    const entryA = entries.find(entry => entry.content === '目录 A 使用 pnpm。')!
    const entryB = entries.find(entry => entry.content === '目录 B 使用 npm。')!
    const shared = entries.find(entry => entry.content === '两个目录共同使用接口 v2。')!
    assert.deepEqual(entryA.project_ids, ['workspace-a'])
    assert.deepEqual(entryB.project_ids, ['workspace-b'])
    assert.deepEqual(shared.project_ids, ['workspace-a', 'workspace-b'])
    assert.deepEqual(shared.messages.map(message => message.text), ['两个目录共同使用接口 v2。'])
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM jt_memo.entries WHERE content=$1', [shared.content])).rows[0].count, 1)
    const retrieve = (project_ids: string[]) => storage.retrieve({ scope: { kind: 'project', project_ids }, query: '目录', mode: 'keyword' })
    assert.deepEqual((await retrieve(['workspace-a'])).entries.map(entry => entry.id), [entryA.id])
    assert.deepEqual((await retrieve(['workspace-b'])).entries.map(entry => entry.id), [entryB.id])
    assert.deepEqual(new Set((await retrieve(['workspace-a', 'workspace-b'])).entries.map(entry => entry.id)), new Set(entries.map(entry => entry.id)))

    const [primary] = await declare([fact('省略目录归入主目录。')])
    assert.deepEqual((await storage.getEntry(primary.entry_ids[0])).project_ids, ['workspace-a'])
    const defaultSettings: CaptureSettings = { ...settings, workspace: directory, scope: { project_ids: ['default'], business_ids: [] }, workspaces: [{ path: directory, project_ids: ['default'], business_ids: [] }] }
    const [fallback] = await declare([fact('无绑定目录归入默认组。')], defaultSettings)
    const fallbackEntry = await storage.getEntry(fallback.entry_ids[0])
    assert.equal(fallbackEntry.scope, 'project')
    assert.deepEqual(fallbackEntry.project_ids, ['default'])
    const [legacy] = await declare([fact('旧声明继续沿用旧项目范围。')], { ...settings, workspaces: undefined, scope: { project_ids: ['legacy-project'], business_ids: [] } })
    assert.deepEqual((await storage.getEntry(legacy.entry_ids[0])).project_ids, ['legacy-project'])
    assert.equal((await work()).completed, 3)

    await rememberEntryRead(config, 'workspace-declaration-session', shared.id, shared.version!, 'evidence')
    const [derived] = await declare([{ ...fact('建议两个目录共同升级接口。', [a, b]), basis: 'assistant_proposal', derived_from: [shared.id] }])
    assert.equal((await work()).completed, 1)
    const derivedEntry = await storage.getEntry(derived.entry_ids[0])
    assert.deepEqual(derivedEntry.project_ids, ['workspace-a', 'workspace-b'])
    assert.deepEqual(derivedEntry.derivation?.sources.map(source => source.read_version), [shared.version])
    await rememberEntryRead(config, 'workspace-declaration-session', shared.id, shared.version!, 'full')
    const [correction] = await declare([{ ...fact('明确更正：两个目录共同使用接口 v3。', [a, b]), change: { kind: 'correction', target: shared.id } }])
    assert.equal((await work()).completed, 1)
    assert.equal((await storage.getEntry(shared.id)).state, 'superseded')
    assert.deepEqual((await storage.getEntry(correction.entry_ids[0])).project_ids, ['workspace-a', 'workspace-b'])
    assert.equal((await storage.getEntry(derived.entry_ids[0])).derivation?.stale, true)
    assert.equal((await storageDoctor(pool)).ok, true)
  } finally { api.mock.restore(); await pool.end(); await rm(directory, { recursive: true, force: true }) }
})
