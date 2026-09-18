import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { checkpointSchema, createTaskSchema, settingsSchema, taskSchema } from './contracts.ts'
import type { Binding, FlowSettings, FlowTask, Verification } from './contracts.ts'
import type { z } from 'zod'

export const flowPath = (workspace: string) => resolve(workspace, '.jth/flow.json')
export const legacyFlowPath = (workspace: string) => resolve(workspace, '.jth/flow.sqlite')
export function findFlowWorkspace(start: string) {
  let path = realpathSync(start)
  while (!existsSync(flowPath(path)) && !existsSync(legacyFlowPath(path))) {
    const parent = dirname(path)
    if (parent === path) throw new Error('当前项目尚未安装流程控制；运行 jth flow install --project <id>')
    path = parent
  }
  return path
}
export function memoryKey(task: FlowTask) { return createHash('sha256').update(JSON.stringify([task.goal, task.constraints])).digest('hex') }

export async function prepareFlowDatabase(pool: Pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('jt_flow:schema',0))")
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS jt_flow;
      CREATE TABLE IF NOT EXISTS jt_flow.projects (workspace text PRIMARY KEY, value jsonb NOT NULL, migrated_hash text);
      CREATE TABLE IF NOT EXISTS jt_flow.tasks (workspace text NOT NULL REFERENCES jt_flow.projects(workspace), id uuid NOT NULL, value jsonb NOT NULL, PRIMARY KEY(workspace,id));
      CREATE TABLE IF NOT EXISTS jt_flow.sessions (workspace text NOT NULL REFERENCES jt_flow.projects(workspace), session_id text NOT NULL, task_id uuid,
        role text NOT NULL CHECK(role IN ('owner','observer')), parent_session_id text, last_event text NOT NULL, last_seen_at text NOT NULL,
        PRIMARY KEY(workspace,session_id), FOREIGN KEY(workspace,task_id) REFERENCES jt_flow.tasks(workspace,id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_owner_per_task ON jt_flow.sessions(workspace,task_id) WHERE role='owner';
      CREATE TABLE IF NOT EXISTS jt_flow.events (workspace text NOT NULL, sequence bigint NOT NULL, task_id uuid NOT NULL, at text NOT NULL, kind text NOT NULL, detail jsonb NOT NULL,
        PRIMARY KEY(workspace,sequence), FOREIGN KEY(workspace,task_id) REFERENCES jt_flow.tasks(workspace,id));
    `)
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** PostgreSQL is the sole task owner. Transactions serialize mutations within one workspace. */
export class FlowStore {
  readonly workspace: string
  private pool: Pool
  private transactionClient = new AsyncLocalStorage<PoolClient>()
  constructor(workspace: string, pool: Pool) { this.workspace = workspace; this.pool = pool }
  close() { return this.pool.end() }
  private get db() { return this.transactionClient.getStore() ?? this.pool }
  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('jt_flow:' || $1,0))", [this.workspace])
      const result = await this.transactionClient.run(client, operation)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async settings(): Promise<FlowSettings> {
    const row = (await this.db.query('SELECT value FROM jt_flow.projects WHERE workspace=$1', [this.workspace])).rows[0]
    if (!row) throw new Error('流程配置未入库；运行 jth flow install 或 migrate')
    return settingsSchema.parse(row.value)
  }
  async install(settings: FlowSettings) {
    const value = settingsSchema.parse(settings)
    if (value.workspace !== this.workspace) throw new Error('流程配置的工作区不一致')
    await this.transaction(async () => {
      const row = (await this.db.query('SELECT value FROM jt_flow.projects WHERE workspace=$1', [this.workspace])).rows[0]
      if (row) {
        const old = settingsSchema.parse(row.value)
        if (old.envFile !== value.envFile || !isDeepStrictEqual([old.projectIds, old.businessIds], [value.projectIds, value.businessIds])) throw new Error('已有流程绑定其他项目或记忆配置；不能覆盖任务范围')
        return
      }
      await this.db.query('INSERT INTO jt_flow.projects(workspace,value) VALUES ($1,$2)', [this.workspace, value])
    })
  }
  async task(id: string): Promise<FlowTask> {
    const row = (await this.db.query('SELECT value FROM jt_flow.tasks WHERE workspace=$1 AND id=$2', [this.workspace, id])).rows[0]
    if (!row) throw new Error('任务不存在')
    return taskSchema.parse(row.value)
  }
  async tasks() { return (await this.db.query("SELECT value FROM jt_flow.tasks WHERE workspace=$1 ORDER BY value->>'createdAt' DESC,id", [this.workspace])).rows.map(row => taskSchema.parse(row.value)) }
  async binding(sessionId: string): Promise<Binding | null> {
    const rows = (await this.db.query<Binding>('SELECT session_id AS "sessionId",task_id AS "taskId",role,parent_session_id AS "parentSessionId",last_event AS "lastEvent",last_seen_at AS "lastSeenAt" FROM jt_flow.sessions WHERE workspace=$1 AND session_id=$2', [this.workspace, sessionId])).rows
    return rows[0] ?? null
  }
  async current(sessionId: string): Promise<FlowTask | null> { const id = (await this.binding(sessionId))?.taskId; return id ? this.task(id) : null }
  async bindings(taskId: string) { return (await this.db.query('SELECT session_id AS "sessionId",role,last_event AS "lastEvent",last_seen_at AS "lastSeenAt" FROM jt_flow.sessions WHERE workspace=$1 AND task_id=$2', [this.workspace, taskId])).rows }
  async history(taskId: string) { return (await this.db.query('SELECT sequence,at,kind,detail FROM jt_flow.events WHERE workspace=$1 AND task_id=$2 ORDER BY sequence DESC LIMIT 30', [this.workspace, taskId])).rows }
  private async write(task: FlowTask, kind: string, detail: unknown) {
    const value = taskSchema.parse({ ...task, updatedAt: new Date().toISOString() })
    await this.db.query('INSERT INTO jt_flow.tasks(workspace,id,value) VALUES ($1,$2,$3) ON CONFLICT(workspace,id) DO UPDATE SET value=excluded.value', [this.workspace, value.id, value])
    await this.db.query('INSERT INTO jt_flow.events(workspace,sequence,task_id,at,kind,detail) SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3,$4,$5 FROM jt_flow.events WHERE workspace=$1', [this.workspace, value.id, value.updatedAt, kind, JSON.stringify(detail)])
    return value
  }
  private async assertOwner(taskId: string, sessionId: string | undefined) {
    if (!sessionId) return
    const binding = await this.binding(sessionId)
    if (binding?.taskId !== taskId || binding.role !== 'owner') throw new Error('当前会话不是任务主控；子 Agent 只读取上下文并向主控汇报')
  }
  async start(input: z.input<typeof createTaskSchema>, baseline: Record<string, string>, sessionId?: string) {
    const draft = createTaskSchema.parse(input)
    return this.transaction(async () => {
      if (sessionId && (await this.binding(sessionId))?.parentSessionId) throw new Error('子 Agent 只接收主任务上下文，不另建主任务')
      const current = sessionId ? await this.current(sessionId) : null
      if (current && current.phase !== 'completed') throw new Error('当前会话已有未完成任务；新增约束用 checkpoint，明确切换任务用 resume')
      const at = new Date().toISOString()
      const task = await this.write(taskSchema.parse({ ...draft, id: randomUUID(), initialGoal: draft.goal, contractVersion: 1, createdAt: at, updatedAt: at,
        steps: draft.steps.map(title => ({ title, completedAt: null, evidence: [] })),
        decisions: [], questions: [], progress: [], next: '', blocked: null, summary: null, baseline, verification: null, memory: null }), 'created', { goal: draft.goal, acceptance: draft.acceptance })
      if (sessionId) await this.bind(task.id, sessionId, true)
      return task
    })
  }
  private async bind(taskId: string, sessionId: string, takeover: boolean) {
    const owner = (await this.db.query("SELECT session_id FROM jt_flow.sessions WHERE workspace=$1 AND task_id=$2 AND role='owner'", [this.workspace, taskId])).rows[0]
    if (owner && owner.session_id !== sessionId && !takeover) throw new Error('任务已有主控会话；确需接管时使用 --takeover，原会话将转为只读')
    if (owner && owner.session_id !== sessionId) await this.db.query("UPDATE jt_flow.sessions SET role='observer' WHERE workspace=$1 AND session_id=$2", [this.workspace, owner.session_id])
    await this.db.query(`INSERT INTO jt_flow.sessions(workspace,session_id,task_id,role,parent_session_id,last_event,last_seen_at) VALUES ($1,$2,$3,'owner',NULL,'resume',$4)
      ON CONFLICT(workspace,session_id) DO UPDATE SET task_id=excluded.task_id,role='owner',parent_session_id=NULL,last_event='resume',last_seen_at=excluded.last_seen_at`, [this.workspace, sessionId, taskId, new Date().toISOString()])
  }
  async resume(taskId: string, sessionId: string, takeover = false) {
    return this.transaction(async () => {
      const task = await this.task(taskId)
      if ((await this.binding(sessionId))?.parentSessionId) throw new Error('子 Agent 不能接管主任务')
      if (task.phase === 'completed') throw new Error('任务已经完成；新目标请创建新任务')
      await this.bind(taskId, sessionId, takeover)
      return this.write(task, 'resumed', { sessionId, takeover })
    })
  }
  async pause(taskId: string, reason: string, sessionId?: string) {
    if (!reason.trim()) throw new Error('暂停或切换任务必须记录原因')
    return this.transaction(async () => {
      await this.assertOwner(taskId, sessionId)
      const task = await this.task(taskId)
      if (task.phase === 'completed') throw new Error('已完成任务不需要暂停')
      await this.db.query("UPDATE jt_flow.sessions SET task_id=NULL,role='observer' WHERE workspace=$1 AND task_id=$2 AND role='owner'", [this.workspace, taskId])
      return this.write(task, 'paused', { reason })
    })
  }
  async observe(sessionId: string, event: string, parentSessionId?: string, at = new Date().toISOString()) {
    if (sessionId === parentSessionId) throw new Error('子会话不能与主会话相同')
    return this.transaction(async () => {
      const existing = await this.binding(sessionId)
      const parent = parentSessionId ? await this.binding(parentSessionId) : null
      if (parentSessionId && existing?.role === 'owner') throw new Error('主控会话不能被子 Agent 事件重新绑定')
      if (existing && existing.lastSeenAt > at) return this.current(sessionId)
      await this.db.query(`INSERT INTO jt_flow.sessions(workspace,session_id,task_id,role,parent_session_id,last_event,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(workspace,session_id) DO UPDATE SET task_id=excluded.task_id,role=excluded.role,parent_session_id=excluded.parent_session_id,last_event=excluded.last_event,last_seen_at=excluded.last_seen_at`, [
        this.workspace, sessionId, existing?.taskId ?? parent?.taskId ?? null, parentSessionId ? 'observer' : existing?.role ?? 'observer', parentSessionId ?? existing?.parentSessionId ?? null, event, at])
      return this.current(sessionId)
    })
  }
  async checkpoint(taskId: string, input: z.input<typeof checkpointSchema>, sessionId?: string) {
    const change = checkpointSchema.parse(input)
    return this.transaction(async () => {
      await this.assertOwner(taskId, sessionId)
      const task = await this.task(taskId)
      if (task.phase === 'completed') throw new Error('已完成任务不能继续追加进展；请创建新任务')
      if (change.phase && change.phase !== task.phase && !change.reason) throw new Error('改变阶段必须说明用户授权或恢复依据（--reason）')
      if (change.resolve.some(id => !task.questions.some(note => note.id === id))) throw new Error('待解决问题 ID 不存在')
      const at = new Date().toISOString(), notes = (items: string[]) => items.map(text => ({ id: randomUUID(), text, at }))
      const steps = [...task.steps, ...change.step.map(title => ({ title, completedAt: null, evidence: [] }))]
      if (change.completeStep !== undefined) {
        const current = steps.findIndex(step => !step.completedAt)
        if (current < 0 || change.completeStep !== current + 1) throw new Error('只能完成当前未完成步骤；用 status 查看阶段计划')
        if (!change.done.length) throw new Error('完成步骤需要 --done 记录实际结果与证据')
        steps[current] = { ...steps[current], completedAt: at, evidence: change.done }
      }
      const constraints = [...new Set([...task.constraints, ...change.constraint])], checks = [...new Set([...task.checks, ...change.check])]
      const contractChanged = steps.length !== task.steps.length || constraints.length !== task.constraints.length || checks.length !== task.checks.length || (change.phase !== undefined && change.phase !== task.phase)
      return this.write({ ...task, constraints, checks, steps,
        contextFiles: [...new Set([...task.contextFiles, ...change.context])], decisions: [...task.decisions, ...notes(change.decision)].slice(-64),
        questions: [...task.questions.filter(note => !change.resolve.includes(note.id)), ...notes(change.question)], progress: [...task.progress, ...notes(change.done)].slice(-64),
        next: change.next ?? task.next, blocked: change.blocked === undefined ? task.blocked : change.blocked || null,
        phase: change.phase ?? task.phase, contractVersion: task.contractVersion + Number(contractChanged), memory: constraints.length !== task.constraints.length ? null : task.memory,
      }, 'checkpoint', change)
    })
  }
  async revise(taskId: string, goal: string, reason: string, sessionId?: string) {
    createTaskSchema.shape.goal.parse(goal)
    if (!reason.trim()) throw new Error('修改目标必须说明用户明确变更目标的依据')
    return this.transaction(async () => {
      await this.assertOwner(taskId, sessionId)
      const task = await this.task(taskId)
      if (task.phase === 'completed') throw new Error('已完成任务不能改写目标')
      return this.write({ ...task, goal, contractVersion: task.contractVersion + 1, verification: null, memory: null }, 'goal-revised', { previousGoal: task.goal, goal, reason })
    })
  }
  async saveVerification(taskId: string, verification: Verification, sessionId?: string) {
    return this.transaction(async () => {
      await this.assertOwner(taskId, sessionId)
      const task = await this.task(taskId)
      if (task.contractVersion !== verification.contractVersion || task.phase === 'completed') throw new Error('验证期间任务目标或约束已变化；结果未授予完成资格')
      return this.write({ ...task, verification, phase: verification.passed ? 'verification' : task.phase }, 'verified', { id: verification.id, passed: verification.passed })
    })
  }
  async finish(taskId: string, summary: string, snapshot: Record<string, string>, sessionId?: string, evidence?: string) {
    if (!summary.trim()) throw new Error('完成时必须说明目标达成结果')
    return this.transaction(async () => {
      await this.assertOwner(taskId, sessionId)
      const task = await this.task(taskId)
      if (task.blocked) throw new Error('任务仍有阻塞项，请先 checkpoint --blocked "" 记录解除')
      if (task.phase === 'completed') return task
      if (task.steps.some(step => !step.completedAt)) throw new Error('阶段计划仍有未完成步骤；阶段完成不等于总目标达成')
      if (task.questions.length) throw new Error('任务仍有未决问题；请记录结论并用 checkpoint --resolve <id> 关闭')
      if (task.checks.length) {
        if (!task.verification?.passed || task.verification.contractVersion !== task.contractVersion) throw new Error('任务尚未通过当前验收命令；运行 jth flow verify')
        if (!isDeepStrictEqual(task.verification.snapshot, snapshot)) throw new Error('验证后的文件状态已变化；请重新验证')
      } else if (task.phase !== 'discussion' && !evidence) throw new Error('实施任务需要验收命令，或 --evidence 指向可检查的交付文件')
      const changed = Object.keys({ ...task.baseline, ...snapshot }).filter(path => task.baseline[path] !== snapshot[path])
      const outside = changed.filter(path => !task.scope.some(scope => scope === '.' || path === scope || path.startsWith(scope.replace(/\/$/, '') + '/')))
      if (outside.length) throw new Error('存在任务范围以外的变更：' + outside.join(', '))
      return this.write({ ...task, phase: 'completed', summary, next: '' }, 'completed', { summary, evidence, verificationId: task.verification?.id ?? null, changed })
    })
  }
  async claimRecall(taskId: string, force = false) {
    return this.transaction(async () => {
      const task = await this.task(taskId), key = memoryKey(task), now = Date.now(), memory = task.memory
      if (task.phase === 'completed') return null
      if (memory?.key === key && memory.status === 'refreshing' && now - Date.parse(memory.requestedAt) < 90000) return null
      if (!force && memory?.key === key && memory.refreshedAt && now - Date.parse(memory.refreshedAt) < 300000) return null
      const requestedAt = new Date().toISOString()
      await this.db.query('UPDATE jt_flow.tasks SET value=$3 WHERE workspace=$1 AND id=$2', [this.workspace, task.id, { ...task, memory: { key, requestedAt, refreshedAt: memory?.refreshedAt ?? null,
        status: 'refreshing', error: null, entries: memory?.key === key ? memory.entries : [] } }])
      return requestedAt
    })
  }
  async saveRecall(taskId: string, key: string, requestedAt: string, entries: NonNullable<FlowTask['memory']>['entries'], error?: string) {
    return this.transaction(async () => {
      const task = await this.task(taskId)
      if (memoryKey(task) !== key || task.memory?.requestedAt !== requestedAt) return false
      const memory: FlowTask['memory'] = { key, requestedAt, refreshedAt: new Date().toISOString(), status: error ? 'failed' : 'ready', error: error ?? null, entries }
      await this.db.query('UPDATE jt_flow.tasks SET value=$3 WHERE workspace=$1 AND id=$2', [this.workspace, task.id, taskSchema.parse({ ...task, memory })])
      return true
    })
  }
}
