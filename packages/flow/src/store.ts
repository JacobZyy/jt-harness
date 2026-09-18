import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { checkpointSchema, createTaskSchema, settingsSchema, taskSchema } from './contracts.ts'
import type { Binding, FlowSettings, FlowTask, Verification } from './contracts.ts'
import type { z } from 'zod'

export const flowPath = (workspace: string) => resolve(workspace, '.jth/flow.sqlite')
export function findFlowWorkspace(start: string) {
  let path = realpathSync(start)
  while (!existsSync(flowPath(path))) {
    const parent = dirname(path)
    if (parent === path) throw new Error('当前项目尚未安装流程控制；运行 jth flow install --project <id>')
    path = parent
  }
  return path
}
export function memoryKey(task: FlowTask) {
  return createHash('sha256').update(JSON.stringify([task.goal, task.constraints])).digest('hex')
}

/** SQLite owns atomic task updates and per-session bindings; hooks need no network connection. */
export class FlowStore {
  private db: DatabaseSync
  readonly workspace: string
  constructor(workspace: string, initialize = false) {
    this.workspace = workspace
    const path = flowPath(workspace)
    if (!initialize && !existsSync(path)) throw new Error('流程控制未安装')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    if (initialize) this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), role TEXT NOT NULL CHECK(role IN ('owner','observer')),
        parent_session_id TEXT, last_event TEXT NOT NULL, last_seen_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_owner_per_task ON sessions(task_id) WHERE role='owner';
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
    `)
  }
  close() { this.db.close() }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  settings(): FlowSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id=1').get()
    if (!row) throw new Error('流程安装配置缺失')
    return settingsSchema.parse(JSON.parse(String(row.value)))
  }
  install(settings: FlowSettings) {
    const value = settingsSchema.parse(settings)
    this.transaction(() => {
      const row = this.db.prepare('SELECT value FROM settings WHERE id=1').get()
      if (row) {
        const old = settingsSchema.parse(JSON.parse(String(row.value)))
        if (old.workspace !== value.workspace || old.envFile !== value.envFile || JSON.stringify([old.projectIds, old.businessIds]) !== JSON.stringify([value.projectIds, value.businessIds])) throw new Error('已有流程绑定其他项目或记忆配置；不能覆盖任务范围')
        return
      }
      this.db.prepare('INSERT INTO settings VALUES (1,?)').run(JSON.stringify(value))
    })
  }
  task(id: string): FlowTask {
    const row = this.db.prepare('SELECT value FROM tasks WHERE id=?').get(id)
    if (!row) throw new Error('任务不存在')
    return taskSchema.parse(JSON.parse(String(row.value)))
  }
  tasks() { return this.db.prepare('SELECT value FROM tasks ORDER BY rowid DESC').all().map(row => taskSchema.parse(JSON.parse(String(row.value)))) }
  binding(sessionId: string): Binding | null {
    const row = this.db.prepare('SELECT session_id AS sessionId,task_id AS taskId,role,parent_session_id AS parentSessionId,last_event AS lastEvent,last_seen_at AS lastSeenAt FROM sessions WHERE session_id=?').get(sessionId)
    return row ? row as unknown as Binding : null
  }
  current(sessionId: string): FlowTask | null { const id = this.binding(sessionId)?.taskId; return id ? this.task(id) : null }
  bindings(taskId: string) { return this.db.prepare('SELECT session_id AS sessionId,role,last_event AS lastEvent,last_seen_at AS lastSeenAt FROM sessions WHERE task_id=?').all(taskId) }
  history(taskId: string) { return this.db.prepare('SELECT sequence,at,kind,detail FROM events WHERE task_id=? ORDER BY sequence DESC LIMIT 30').all(taskId).map(row => ({ sequence: row.sequence, at: String(row.at), kind: String(row.kind), detail: JSON.parse(String(row.detail)) })) }
  private write(task: FlowTask, kind: string, detail: unknown) {
    const value = taskSchema.parse({ ...task, updatedAt: new Date().toISOString() })
    this.db.prepare('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value))
    this.db.prepare('INSERT INTO events(task_id,at,kind,detail) VALUES (?,?,?,?)').run(value.id, value.updatedAt, kind, JSON.stringify(detail))
    return value
  }
  private assertOwner(taskId: string, sessionId: string | undefined) {
    if (!sessionId) return // Explicit task IDs in a human terminal are the local operator surface.
    const binding = this.binding(sessionId)
    if (binding?.taskId !== taskId || binding.role !== 'owner') throw new Error('当前会话不是任务主控；子 Agent 只读取上下文并向主控汇报')
  }
  start(input: z.input<typeof createTaskSchema>, baseline: Record<string, string>, sessionId?: string) {
    const draft = createTaskSchema.parse(input)
    return this.transaction(() => {
      if (sessionId && this.binding(sessionId)?.parentSessionId) throw new Error('子 Agent 只接收主任务上下文，不另建主任务')
      const current = sessionId ? this.current(sessionId) : null
      if (current && current.phase !== 'completed') throw new Error('当前会话已有未完成任务；新增约束用 checkpoint，明确切换任务用 resume')
      const at = new Date().toISOString()
      const task = this.write(taskSchema.parse({ ...draft, id: randomUUID(), initialGoal: draft.goal, contractVersion: 1, createdAt: at, updatedAt: at,
        decisions: [], questions: [], progress: [], next: '', blocked: null, summary: null, baseline, verification: null, memory: null }), 'created', { goal: draft.goal, acceptance: draft.acceptance })
      if (sessionId) this.bind(task.id, sessionId, true)
      return task
    })
  }
  private bind(taskId: string, sessionId: string, takeover: boolean) {
    const owner = this.db.prepare("SELECT session_id FROM sessions WHERE task_id=? AND role='owner'").get(taskId)
    if (owner && owner.session_id !== sessionId && !takeover) throw new Error('任务已有主控会话；确需接管时使用 --takeover，原会话将转为只读')
    if (owner && owner.session_id !== sessionId) this.db.prepare("UPDATE sessions SET role='observer' WHERE session_id=?").run(owner.session_id)
    this.db.prepare(`INSERT INTO sessions(session_id,task_id,role,parent_session_id,last_event,last_seen_at) VALUES (?,?,'owner',NULL,'resume',?)
      ON CONFLICT(session_id) DO UPDATE SET task_id=excluded.task_id,role='owner',parent_session_id=NULL,last_event='resume',last_seen_at=excluded.last_seen_at`).run(sessionId, taskId, new Date().toISOString())
  }
  resume(taskId: string, sessionId: string, takeover = false) {
    return this.transaction(() => {
      const task = this.task(taskId)
      if (this.binding(sessionId)?.parentSessionId) throw new Error('子 Agent 不能接管主任务')
      if (task.phase === 'completed') throw new Error('任务已经完成；新目标请创建新任务')
      this.bind(taskId, sessionId, takeover)
      return this.write(task, 'resumed', { sessionId, takeover })
    })
  }
  pause(taskId: string, reason: string, sessionId?: string) {
    if (!reason.trim()) throw new Error('暂停或切换任务必须记录原因')
    return this.transaction(() => {
      this.assertOwner(taskId, sessionId)
      const task = this.task(taskId)
      if (task.phase === 'completed') throw new Error('已完成任务不需要暂停')
      this.db.prepare("UPDATE sessions SET task_id=NULL,role='observer' WHERE task_id=? AND role='owner'").run(taskId)
      return this.write(task, 'paused', { reason })
    })
  }
  observe(sessionId: string, event: string, parentSessionId?: string) {
    if (sessionId === parentSessionId) throw new Error('子会话不能与主会话相同')
    return this.transaction(() => {
      const existing = this.binding(sessionId)
      const parent = parentSessionId ? this.binding(parentSessionId) : null
      if (parentSessionId && existing?.role === 'owner') throw new Error('主控会话不能被子 Agent 事件重新绑定')
      this.db.prepare(`INSERT INTO sessions(session_id,task_id,role,parent_session_id,last_event,last_seen_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET task_id=excluded.task_id,role=excluded.role,parent_session_id=excluded.parent_session_id,last_event=excluded.last_event,last_seen_at=excluded.last_seen_at`).run(
        sessionId, existing?.taskId ?? parent?.taskId ?? null, parentSessionId ? 'observer' : existing?.role ?? 'observer', parentSessionId ?? existing?.parentSessionId ?? null, event, new Date().toISOString())
      return this.current(sessionId)
    })
  }
  checkpoint(taskId: string, input: z.input<typeof checkpointSchema>, sessionId?: string) {
    const change = checkpointSchema.parse(input)
    return this.transaction(() => {
      this.assertOwner(taskId, sessionId)
      const task = this.task(taskId)
      if (task.phase === 'completed') throw new Error('已完成任务不能继续追加进展；请创建新任务')
      if (change.phase && change.phase !== task.phase && !change.reason) throw new Error('改变阶段必须说明用户授权或恢复依据（--reason）')
      if (change.resolve.some(id => !task.questions.some(note => note.id === id))) throw new Error('待解决问题 ID 不存在')
      const at = new Date().toISOString(), notes = (items: string[]) => items.map(text => ({ id: randomUUID(), text, at }))
      const constraints = [...new Set([...task.constraints, ...change.constraint])], checks = [...new Set([...task.checks, ...change.check])]
      const contractChanged = constraints.length !== task.constraints.length || checks.length !== task.checks.length || (change.phase !== undefined && change.phase !== task.phase)
      return this.write({ ...task, constraints, checks,
        contextFiles: [...new Set([...task.contextFiles, ...change.context])], decisions: [...task.decisions, ...notes(change.decision)].slice(-64),
        questions: [...task.questions.filter(note => !change.resolve.includes(note.id)), ...notes(change.question)], progress: [...task.progress, ...notes(change.done)].slice(-64),
        next: change.next ?? task.next, blocked: change.blocked === undefined ? task.blocked : change.blocked || null,
        phase: change.phase ?? task.phase, contractVersion: task.contractVersion + Number(contractChanged), memory: constraints.length !== task.constraints.length ? null : task.memory,
      }, 'checkpoint', change)
    })
  }
  revise(taskId: string, goal: string, reason: string, sessionId?: string) {
    createTaskSchema.shape.goal.parse(goal)
    if (!reason.trim()) throw new Error('修改目标必须说明用户明确变更目标的依据')
    return this.transaction(() => {
      this.assertOwner(taskId, sessionId)
      const task = this.task(taskId)
      if (task.phase === 'completed') throw new Error('已完成任务不能改写目标')
      return this.write({ ...task, goal, contractVersion: task.contractVersion + 1, verification: null, memory: null }, 'goal-revised', { previousGoal: task.goal, goal, reason })
    })
  }
  saveVerification(taskId: string, verification: Verification, sessionId?: string) {
    return this.transaction(() => {
      this.assertOwner(taskId, sessionId)
      const task = this.task(taskId)
      if (task.contractVersion !== verification.contractVersion || task.phase === 'completed') throw new Error('验证期间任务目标或约束已变化；结果未授予完成资格')
      return this.write({ ...task, verification, phase: verification.passed ? 'verification' : task.phase }, 'verified', { id: verification.id, passed: verification.passed })
    })
  }
  finish(taskId: string, summary: string, snapshot: Record<string, string>, sessionId?: string, evidence?: string) {
    if (!summary.trim()) throw new Error('完成时必须说明目标达成结果')
    return this.transaction(() => {
      this.assertOwner(taskId, sessionId)
      const task = this.task(taskId)
      if (task.blocked) throw new Error('任务仍有阻塞项，请先 checkpoint --blocked "" 记录解除')
      if (task.phase === 'completed') return task
      if (task.questions.length) throw new Error('任务仍有未决问题；请记录结论并用 checkpoint --resolve <id> 关闭')
      if (task.checks.length) {
        if (!task.verification?.passed || task.verification.contractVersion !== task.contractVersion) throw new Error('任务尚未通过当前验收命令；运行 jth flow verify')
        if (JSON.stringify(task.verification.snapshot) !== JSON.stringify(snapshot)) throw new Error('验证后的文件状态已变化；请重新验证')
      } else if (task.phase !== 'discussion' && !evidence) throw new Error('实施任务需要验收命令，或 --evidence 指向可检查的交付文件')
      const changed = Object.keys({ ...task.baseline, ...snapshot }).filter(path => task.baseline[path] !== snapshot[path])
      const outside = changed.filter(path => !task.scope.some(scope => scope === '.' || path === scope || path.startsWith(scope.replace(/\/$/, '') + '/')))
      if (outside.length) throw new Error('存在任务范围以外的变更：' + outside.join(', '))
      return this.write({ ...task, phase: 'completed', summary, next: '' }, 'completed', { summary, evidence, verificationId: task.verification?.id ?? null, changed })
    })
  }
  claimRecall(taskId: string, force = false) {
    return this.transaction(() => {
      const task = this.task(taskId), key = memoryKey(task), now = Date.now(), memory = task.memory
      if (task.phase === 'completed') return null
      if (memory?.key === key && memory.status === 'refreshing' && now - Date.parse(memory.requestedAt) < 90000) return null
      if (!force && memory?.key === key && memory.refreshedAt && now - Date.parse(memory.refreshedAt) < 300000) return null
      const requestedAt = new Date().toISOString()
      this.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify({ ...task, memory: { key, requestedAt, refreshedAt: memory?.refreshedAt ?? null,
        status: 'refreshing', error: null, entries: memory?.key === key ? memory.entries : [] } }), task.id)
      return requestedAt
    })
  }
  saveRecall(taskId: string, key: string, requestedAt: string, entries: NonNullable<FlowTask['memory']>['entries'], error?: string) {
    return this.transaction(() => {
      const task = this.task(taskId)
      if (memoryKey(task) !== key || task.memory?.requestedAt !== requestedAt) return false
      const memory: FlowTask['memory'] = { key, requestedAt, refreshedAt: new Date().toISOString(), status: error ? 'failed' : 'ready', error: error ?? null, entries }
      this.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(taskSchema.parse({ ...task, memory })), task.id)
      return true
    })
  }
}
