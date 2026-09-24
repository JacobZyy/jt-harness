import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { FlowStore, prepareFlowDatabase, taskSchema, createTaskSchema, flowPath } from '@jt-harness/flow'
import { migrateFlow } from '@jt-harness/flow/migrate'
import { loadConfig } from '@jt-harness/memo'
import { postgresStatus, startPostgres } from '../../packages/cli/src/postgres.ts'

const sqlite = 'bun' in process.versions ? await import('bun:sqlite' as string) : await import('node:sqlite')
const DatabaseSync = sqlite.DatabaseSync ?? sqlite.Database
const execute = promisify(execFile), root = process.cwd(), databaseUrl = process.env.JTH_TEST_DATABASE_URL

test('SQLite migration preserves tasks, ownership and event sequence; PG serializes concurrent updates and isolates workspaces', { skip: !databaseUrl }, async () => {
  const workspace = await realpath(await mkdtemp('/tmp/jth-migration-'))
  await mkdir(resolve(workspace, '.jth'))
  const pool = new Pool({ connectionString: databaseUrl }), store = new FlowStore(workspace, pool)
  const otherPool = new Pool({ connectionString: databaseUrl }), other = new FlowStore(workspace, otherPool)
  const source = new DatabaseSync(resolve(workspace, '.jth/flow.sqlite'))
  const id = randomUUID(), at = new Date().toISOString()
  const settings = { version: 1, workspace, envFile: resolve(workspace, '.env'), projectIds: ['migration'], businessIds: [], installedAt: at }
  const task = taskSchema.parse({ ...createTaskSchema.parse({ goal: '保留原目标与历史', acceptance: ['迁移完整'] }), id, initialGoal: '保留原目标与历史', contractVersion: 1,
    createdAt: at, updatedAt: at, decisions: [], questions: [], progress: [], next: '验证迁移', blocked: null, summary: null,
    baseline: { 'z.ts': 'old-z', 'a.ts': 'old-a' }, verification: null, memory: null })
  try {
    source.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY,value TEXT);CREATE TABLE tasks(id TEXT PRIMARY KEY,value TEXT);CREATE TABLE sessions(session_id TEXT PRIMARY KEY,task_id TEXT,role TEXT,parent_session_id TEXT,last_event TEXT,last_seen_at TEXT);CREATE TABLE events(sequence INTEGER PRIMARY KEY,task_id TEXT,at TEXT,kind TEXT,detail TEXT);')
    source.prepare('INSERT INTO settings VALUES (1,?)').run(JSON.stringify(settings))
    source.prepare('INSERT INTO tasks VALUES (?,?)').run(id, JSON.stringify(task))
    source.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('parent', id, 'owner', null, 'SessionStart', at)
    source.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('child', id, 'observer', 'parent', 'SubagentStart', at)
    source.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(7, id, at, 'created', JSON.stringify({ original: true }))
    const receipt = await migrateFlow(workspace, pool)
    assert.equal(receipt.status, 'migrated')
    assert.deepEqual([receipt.tasks, receipt.sessions, receipt.events], [1, 2, 1])
    assert.equal((await stat(receipt.backup)).mode & 0o777, 0o600)
    assert.deepEqual(await store.task(id), task)
    assert.deepEqual(await store.settings(), settings)
    assert.equal((await store.binding('child'))!.role, 'observer')
    assert.equal((await store.history(id))[0].sequence, '7')
    assert.equal((await migrateFlow(workspace, pool)).status, 'already-migrated')
    await Promise.all([store.checkpoint(id, { done: ['并发进展 A'] }, 'parent'), other.checkpoint(id, { done: ['并发进展 B'] }, 'parent')])
    assert.equal((await store.task(id)).progress.length, 2)
    await store.pause(id, '交接验证', 'parent')
    const owners = await Promise.allSettled([store.resume(id, 'one'), other.resume(id, 'two')])
    assert.equal(owners.filter(result => result.status === 'fulfilled').length, 1)
    const separate = new FlowStore(workspace + '-other', new Pool({ connectionString: databaseUrl }))
    try {
      await separate.install({ ...settings, version: 1, workspace: workspace + '-other' })
      const unrelated = await separate.start({ goal: '另一个项目', acceptance: ['独立绑定'] }, {}, 'child')
      assert.equal((await separate.current('child'))!.id, unrelated.id)
      assert.equal((await store.current('child'))!.id, id)
    } finally { await separate.close() }
    source.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify({ ...task, goal: '较晚的 SQLite 写入' }), id)
    await assert.rejects(migrateFlow(workspace, pool), /拒绝覆盖/)
    assert.equal((await store.task(id)).progress.length, 2)
  } finally { source.close(); await store.close(); await other.close(); await rm(workspace, { recursive: true, force: true }) }
})

test('managed PG starts once under contention; cold hooks return promptly and replay durable events', { skip: !databaseUrl || !process.env.JTH_TEST_PG_DATA_DIR }, async () => {
  const workspace = await realpath(await mkdtemp('/tmp/jth-managed-pg-'))
  const envFile = resolve(workspace, '.env'), binary = process.env.JTH_TEST_PG_BIN_DIR!, data = process.env.JTH_TEST_PG_DATA_DIR!
  await mkdir(resolve(workspace, '.jth'))
  await writeFile(envFile, `JTH_DATABASE_URL=${databaseUrl}\nJTH_DATA_DIR=${workspace}/.jth/memo\nJTH_PG_DATA_DIR=${data}\nJTH_PG_BIN_DIR=${binary}\n`)
  await writeFile(flowPath(workspace), JSON.stringify({ version: 2, workspace, envFile }))
  const config = await loadConfig(root, envFile, {})
  const pool = new Pool({ connectionString: databaseUrl }), store = new FlowStore(workspace, pool)
  await prepareFlowDatabase(pool)
  await store.install({ version: 1, workspace, envFile, projectIds: ['cold'], businessIds: [], installedAt: new Date().toISOString() })
  const task = await store.start({ goal: '冷启动后恢复原目标', acceptance: ['Hook 不等待 PG 启动'] }, {}, 'cold-session')
  await store.close()
  const stop = () => execute(resolve(binary, 'pg_ctl'), ['-D', data, 'stop', '-m', 'fast', '-w'])
  try {
    await stop()
    assert.equal((await postgresStatus(config)).status, 'stopped')
    await Promise.all([startPostgres(config), startPostgres(config), startPostgres(config)])
    assert.equal((await postgresStatus(config)).status, 'running')
    await assert.rejects(startPostgres({ ...config, databaseUrl: 'postgresql://remote.invalid/jth' }), /本地地址/)
    await stop()
    const started = performance.now()
    const result = await new Promise<{ stdout: string, stderr: string }>((done, reject) => {
      const child = execFile(process.execPath, [resolve(root, 'bin/jth.mjs'), 'flow', 'legacy', 'hook', '--workspace', workspace], (error, stdout, stderr) => error ? reject(error) : done({ stdout, stderr }))
      child.stdin!.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cold-session', cwd: workspace }))
    })
    assert(performance.now() - started < 2000, 'Hook must return before its native three-second timeout')
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /数据库暂不可用/)
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readdir(resolve(workspace, '.jth/flow-events'))).length === 0) break
      await delay(100)
    }
    assert.equal((await postgresStatus(config)).status, 'running')
    assert.equal((await readdir(resolve(workspace, '.jth/flow-events'))).length, 0)
    const resumed = new FlowStore(workspace, new Pool({ connectionString: databaseUrl }))
    try {
      assert.equal((await resumed.current('cold-session'))!.goal, task.goal)
      assert.equal((await resumed.binding('cold-session'))!.lastEvent, 'UserPromptSubmit')
      assert.equal((await resumed.current('cold-session'))!.phase, 'discussion')
    } finally { await resumed.close() }
    const unavailable = await loadConfig(root, envFile, { JTH_PG_DATA_DIR: resolve(workspace, 'missing') })
    await assert.rejects(startPostgres(unavailable), /ENOENT/)
  } finally {
    await startPostgres(config)
    // Background recall sees an empty Embedding configuration and exits without model/API work.
    await delay(200)
    await rm(workspace, { recursive: true, force: true })
  }
})
