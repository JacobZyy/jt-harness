import type { DatabaseSync } from 'node:sqlite'
import { mkdir, chmod } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Pool } from 'pg'
import { settingsSchema, taskSchema } from './contracts.ts'
import { legacyFlowPath, prepareFlowDatabase } from './store.ts'

const bun = 'bun' in process.versions
const require = createRequire(import.meta.url)
const sqlite = bun ? require('bun:sqlite') : require('node:sqlite')
const openLegacy = (path: string): DatabaseSync => bun
  ? new sqlite.Database(path, { readonly: true })
  : new sqlite.DatabaseSync(path, { readOnly: true })

export function legacySettings(workspace: string) {
  const db = openLegacy(legacyFlowPath(workspace))
  try { return settingsSchema.parse(JSON.parse(String(db.prepare('SELECT value FROM settings WHERE id=1').get()?.value))) } finally { db.close() }
}

/** SQLite is read only here. PostgreSQL commits the entire snapshot before the caller changes its locator. */
export async function migrateFlow(workspace: string, pool: Pool) {
  const directory = resolve(workspace, '.jth/backups')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = resolve(directory, `flow-${Date.now()}.sqlite`)
  const source = openLegacy(legacyFlowPath(workspace))
  try {
    if (bun) source.prepare('VACUUM main INTO ?').run(path)
    else await sqlite.backup(source, path)
  } finally { source.close() }
  await chmod(path, 0o600)
  const db = openLegacy(path)
  let snapshot
  try {
    const settings = settingsSchema.parse(JSON.parse(String(db.prepare('SELECT value FROM settings WHERE id=1').get()?.value)))
    if (settings.workspace !== workspace) throw new Error('SQLite 的工作区与迁移目标不同')
    snapshot = { settings,
      tasks: db.prepare('SELECT value FROM tasks ORDER BY id').all().map(row => taskSchema.parse(JSON.parse(String(row.value)))),
      sessions: db.prepare('SELECT session_id,task_id,role,parent_session_id,last_event,last_seen_at FROM sessions ORDER BY session_id').all(),
      events: db.prepare('SELECT sequence,task_id,at,kind,detail FROM events ORDER BY sequence').all().map(row => ({ sequence: row.sequence, task_id: row.task_id, at: row.at, kind: row.kind, detail: JSON.parse(String(row.detail)) })),
    }
  } finally { db.close() }
  await prepareFlowDatabase(pool)
  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('jt_flow:' || $1,0))", [workspace])
    const previous = (await client.query('SELECT migrated_hash FROM jt_flow.projects WHERE workspace=$1', [workspace])).rows[0]
    if (previous && previous.migrated_hash !== hash) throw new Error('PostgreSQL 已有不同流程数据；拒绝覆盖，SQLite 备份已保留')
    if (!previous) {
      await client.query('INSERT INTO jt_flow.projects(workspace,value,migrated_hash) VALUES ($1,$2,$3)', [workspace, snapshot.settings, hash])
      for (const task of snapshot.tasks) await client.query('INSERT INTO jt_flow.tasks(workspace,id,value) VALUES ($1,$2,$3)', [workspace, task.id, task])
      for (const session of snapshot.sessions) await client.query('INSERT INTO jt_flow.sessions(workspace,session_id,task_id,role,parent_session_id,last_event,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [workspace, session.session_id, session.task_id, session.role, session.parent_session_id, session.last_event, session.last_seen_at])
      for (const event of snapshot.events) await client.query('INSERT INTO jt_flow.events(workspace,sequence,task_id,at,kind,detail) VALUES ($1,$2,$3,$4,$5,$6)', [workspace, event.sequence, event.task_id, event.at, event.kind, event.detail])
    }
    await client.query('COMMIT')
    return { status: previous ? 'already-migrated' : 'migrated', workspace, backup: path, hash, tasks: snapshot.tasks.length, sessions: snapshot.sessions.length, events: snapshot.events.length }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
