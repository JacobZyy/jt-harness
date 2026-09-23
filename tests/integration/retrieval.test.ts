import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, appendFile, readdir, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { MemoStorage, prepareDatabase, readMemory, recordDeclaration, loadConfig, memoryUses, manageEntry } from '@jt-harness/memo'
import { memoryCues, rememberEntryRead, captureDeclaration, collectDeclarations, readEvidence } from '@jt-harness/codex-hooks'

test('retrieval, evidence levels, lifecycle cues and usage feedback preserve scope and stored facts', { skip: !process.env.JTH_TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.JTH_TEST_DATABASE_URL })
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-retrieval-')), home = resolve(directory, 'codex')
  const workspace = await realpath(directory)
  const envFile = resolve(directory, '.env'), source = resolve(home, 'sessions/parent.jsonl'), session = 'retrieval-session'
  const project = `retrieval-${randomUUID()}`, otherProject = `other-${randomUUID()}`
  const execute = promisify(execFile)
  const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, ['bin/jth.mjs', 'memo', ...args, '--env-file', envFile], { cwd: process.cwd() })).stdout)
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'jth_test')
    await prepareDatabase(pool, true)
    await mkdir(resolve(home, 'sessions'), { recursive: true })
    await writeFile(envFile, `JTH_DATABASE_URL=${process.env.JTH_TEST_DATABASE_URL}\nJTH_DATA_DIR=${directory}/data\n`)
    const config = await loadConfig(process.cwd(), envFile)
    const storage = new MemoStorage(pool)
    const space = { id: `space-${project}`, provider: 'https://example.invalid/v1', model: 'fixture', dimensions: 2, input_version: 'content-v1' as const }
    const add = async (content: string, projects: string[], vector: number[]) => {
      const id = randomUUID(), text = '上下文。'.repeat(300) + content
      const stored = await storage.store({ submission: { schema_version: 1, submission_id: id,
        source: { provider: 'codex', session_id: session }, scope: { project_ids: projects, business_ids: [] },
        messages: [{ message_id: 'u', role: 'user', text, occurred_at: '2026-01-01T00:00:00Z' }] },
        extraction: { schema_version: 1, memories: [{ content, basis: 'user_statement', scope: 'project', source_message_ids: ['u'] }], proposals: [], revisions: [] },
        run: { session_id: 'fixture', provider: 'fixture', model: 'fixture' } })
      const entry = (await storage.getSubmission(id)).entries[0]
      await storage.index({ submission_id: id, space, embeddings: [{ entry_id: entry.id, content_sha256: entry.content_sha256, vector }] })
      return stored.entry_ids[0]
    }
    const exact = await add('saveSegmentQcDraft 使用 operatorAuthUid。', [project], [0, 1])
    const meaning = await add('草稿保存采用当前操作人的标识。', [project], [1, 0])
    await add('saveSegmentQcDraft 其他项目规则。', [otherProject], [1, 0])
    await add('saveSegmentQcDraft 同时属于两个项目。', [project, otherProject], [1, 0])
    const input = { query: 'saveSegmentQcDraft', scope: { kind: 'project' as const, project_ids: [project] } }
    const found = await storage.retrieve({ ...input, vector: [1, 0], space_id: space.id })
    assert.deepEqual(found.entries.map(entry => entry.id), [exact, meaning])
    assert.deepEqual((await cli('recall', input.query, '--project', project)).entries.map((entry: { id: string }) => entry.id), [exact])
    assert.deepEqual((await cli('search', input.query, '--mode', 'keyword', '--project', project)).entries.map((entry: { id: string }) => entry.id), [exact])
    assert.deepEqual((await storage.retrieve({ ...input, mode: 'keyword', query: '火星完全无关资料' })).entries, [])
    const full = await storage.getEntry(exact)
    const summary = readMemory(full, 'summary'), evidence = readMemory(full, 'evidence')
    assert(!Object.hasOwn(summary, 'messages'))
    assert('messages' in evidence && 'preview' in evidence.messages[0])
    assert(evidence.messages[0].preview.includes(full.content))
    assert(evidence.messages[0].truncated)
    assert.deepEqual(readMemory(full, 'full'), full)
    assert(!Object.hasOwn(evidence.messages[0], 'text'))
    const paraphrased = readMemory({ ...full, content: '操作人必须传 operatorAuthUid，接口为 saveSegmentQcDraft。' }, 'evidence')
    assert('messages' in paraphrased && 'preview' in paraphrased.messages[0])
    assert(paraphrased.messages[0].preview.includes(full.content), 'Paraphrased facts should locate matching source terms beyond the log header')
    const settings = { workspace, codex_home: home, env_file: envFile, enabled_at: '2026-01-01T00:00:00Z', scope: { project_ids: [project], business_ids: [] } }
    const event = { hook_event_name: 'UserPromptSubmit', cwd: workspace, session_id: session, turn_id: 'one', prompt: input.query }
    const cue = await memoryCues(event, settings, config, storage)
    assert(cue.hookSpecificOutput)
    assert(cue.hookSpecificOutput.additionalContext.includes(exact))
    assert(cue.hookSpecificOutput.additionalContext.length < 1600)
    assert(!cue.hookSpecificOutput.additionalContext.includes(meaning))
    const repeated = await memoryCues({ ...event, turn_id: 'two' }, settings, config, storage)
    assert(repeated.hookSpecificOutput)
    assert(repeated.hookSpecificOutput.additionalContext.includes('jth-memo Skill'))
    assert(!repeated.hookSpecificOutput.additionalContext.includes(exact))
    await memoryCues({ ...event, hook_event_name: 'SessionStart' }, settings, config, storage)
    assert('hookSpecificOutput' in await memoryCues({ ...event, turn_id: 'three' }, settings, config, storage))
    assert.deepEqual(await memoryCues({ ...event, agent_id: 'child' }, settings, config, storage), {})
    const row = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type, payload }) + '\n'
    await writeFile(source, row('session_meta', { id: session }))
    const text = `<!-- jth-memory ${JSON.stringify({ items: [], used: [exact] })} -->`
    await appendFile(source, row('event_msg', { type: 'item_completed', thread_id: session, item: { type: 'AgentMessage', id: 'answer', content: [{ type: 'text', text }] } }))
    await rememberEntryRead(config, session, exact, full.version!, 'evidence')
    await captureDeclaration({ hook_event_name: 'Stop', session_id: session, cwd: workspace, transcript_path: source, last_assistant_message: text }, settings, config)
    assert.equal((await collectDeclarations(config)).received, 1)
    const staged = JSON.parse(await readFile(resolve(config.dataDir, 'codex/records', (await readdir(resolve(config.dataDir, 'codex/records')))[0]), 'utf8'))
    const beforeJobs = (await pool.query('SELECT count(*)::int AS count FROM jt_memo.jobs')).rows[0].count
    const sourceEvidence = await readEvidence(config, staged.evidence_id)
    const used = await recordDeclaration(pool, staged.draft, sourceEvidence, config)
    assert.equal(used.new_facts, 0)
    assert.equal(used.submission_id, null)
    assert.deepEqual(used.used_memory_ids, [exact])
    assert.equal((await recordDeclaration(pool, staged.draft, sourceEvidence, config)).duplicate, true)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM jt_memo.jobs')).rows[0].count, beforeJobs)
    assert.equal((await memoryUses(pool, input.scope)).uses.length, 1)
    assert.equal((await memoryUses(pool, { kind: 'project', project_ids: [otherProject] })).uses.length, 0)
    assert.equal((await cli('usage', '--session', session)).uses.length, 1)
    assert.deepEqual(await storage.getEntry(exact), full)
    await manageEntry(pool, { action: 'archive', entry_id: exact, reason: 'fixture retirement' })
    assert.equal((await storage.retrieve({ ...input, mode: 'keyword' })).entries.length, 0)
    assert.equal((await storage.retrieve({ ...input, mode: 'keyword', include_archived: true })).entries.length, 1)
  } finally { await pool.end(); await rm(directory, { recursive: true, force: true }) }
})
