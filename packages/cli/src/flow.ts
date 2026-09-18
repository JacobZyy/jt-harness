import { realpath, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, relative, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { FlowStore, findFlowWorkspace, renderFlowContext, taskView, verifyTask, workspaceSnapshot, flowPath, legacyFlowPath, locatorSchema, prepareFlowDatabase } from '@jt-harness/flow'
import { configureFlowHooks, configureHooks, flowHook, stageFlowEvent, drainFlowEvents, readJson, writeJson } from '@jt-harness/codex-hooks'
import { openDatabase } from '@jt-harness/memo'
import { loadConfig, safeError } from '@jt-harness/memo/config'
import { recallTask, scheduleRecall } from './flow-memory.ts'
import { connectDatabase } from './postgres.ts'
import { startBackground } from './background.ts'

const help = `jth flow install --project <id> [--business <id>] [--env-file <path>]
jth flow migrate  将原 SQLite 任务完整迁入 PostgreSQL，保留备份
jth flow start <目标> --accept <完成条件> [--step <阶段交付>] [--phase discussion|execution] [--scope <相对路径>] [--check <命令>]
jth flow status [--all] [--history] | context
jth flow checkpoint [--done <进展>] [--next <下一步>] [--constraint <约束>] [--decision <结论>] [--question <问题>] [--resolve <问题ID>]
                    [--phase discussion|execution --reason <授权依据>] [--blocked <原因或空字符串>] [--check <命令>] [--context <相对路径>]
                    [--step <追加阶段>] [--complete-step <当前步骤序号> --done <结果与证据>]
jth flow revise <新目标> --reason <用户变更依据>
jth flow resume <任务ID> [--takeover]
jth flow pause --reason <暂停或切换依据>
jth flow recall
jth flow verify [--timeout-ms <每项超时>]
jth flow finish --summary <达成结果> [--evidence <相对文件>]
jth flow uninstall
通用：--workspace <项目目录>。任务命令可用 --task <ID>；Codex 内默认绑定 CODEX_THREAD_ID，终端用 --session <ID> 或明确任务 ID。
accept、scope、check、context、constraint、done、decision、question、resolve、step 可重复。hook 是内部入口。
`

export async function flowMain(root: string, args: string[]) {
  let store: FlowStore | undefined
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      workspace: { type: 'string' }, session: { type: 'string' }, task: { type: 'string' }, 'env-file': { type: 'string' },
      project: { type: 'string', multiple: true }, business: { type: 'string', multiple: true },
      accept: { type: 'string', multiple: true }, scope: { type: 'string', multiple: true }, check: { type: 'string', multiple: true }, context: { type: 'string', multiple: true },
      phase: { type: 'string' }, constraint: { type: 'string', multiple: true }, done: { type: 'string', multiple: true },
      decision: { type: 'string', multiple: true }, question: { type: 'string', multiple: true }, resolve: { type: 'string', multiple: true },
      next: { type: 'string' }, reason: { type: 'string' }, blocked: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'string' },
      step: { type: 'string', multiple: true }, 'complete-step': { type: 'string' },
      all: { type: 'boolean' }, history: { type: 'boolean' }, takeover: { type: 'boolean' }, 'timeout-ms': { type: 'string' }, request: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } })
    const [command, operand] = positionals
    if (values.help || !command) { process.stdout.write(help); return }
    const allowed: Record<string, string[]> = {
      install: ['project', 'business', 'env-file'], uninstall: [], start: ['accept', 'scope', 'check', 'context', 'phase', 'constraint', 'step'],
      status: ['all', 'history'], context: [], checkpoint: ['constraint', 'done', 'decision', 'question', 'resolve', 'next', 'phase', 'reason', 'blocked', 'check', 'context', 'step', 'complete-step'],
      revise: ['reason'], resume: ['takeover'], pause: ['reason'], verify: ['timeout-ms'], finish: ['summary', 'evidence'], recall: ['request'], hook: [], sync: [], migrate: [],
    }
    if (!Object.hasOwn(allowed, command)) throw new Error('未知 flow 命令；使用 jth flow --help')
    const invalid = Object.keys(values).filter(key => !['workspace', 'session', 'task', 'help', ...allowed[command]].includes(key))
    if (invalid.length) throw new Error(command + ' 不支持：' + invalid.join(', '))
    if (positionals.length !== (['start', 'revise', 'resume'].includes(command) ? 2 : 1)) throw new Error('命令参数数量不符；使用 jth flow --help')
    const workspace = command === 'install' ? await realpath(resolve(values.workspace ?? process.cwd())) : findFlowWorkspace(values.workspace ?? process.cwd())
    const sessionId = values.session ?? process.env.CODEX_THREAD_ID
    const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
    if (command === 'migrate') {
      const { legacySettings, migrateFlow } = await import('@jt-harness/flow/migrate')
      const settings = legacySettings(workspace), config = await loadConfig(root, settings.envFile)
      const pool = await connectDatabase(config)
      store = new FlowStore(workspace, pool)
      const result = await migrateFlow(workspace, pool)
      await writeJson(flowPath(workspace), { version: 2, workspace, envFile: config.envFile })
      output(result)
      return
    }
    if (command === 'install') {
      if (existsSync(legacyFlowPath(workspace)) && !existsSync(flowPath(workspace))) throw new Error('检测到旧 SQLite；先运行 jth flow migrate，保留原任务')
      const config = await loadConfig(root, values['env-file'])
      const pool = await connectDatabase(config)
      store = new FlowStore(workspace, pool)
      await prepareFlowDatabase(pool)
      await store.install({ version: 1, workspace, envFile: config.envFile, projectIds: values.project ?? [], businessIds: values.business ?? [], installedAt: new Date().toISOString() })
      const memo = await configureHooks(root, config, workspace, { project_ids: values.project ?? [], business_ids: values.business ?? [] }, resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex')))
      await writeJson(flowPath(workspace), { version: 2, workspace, envFile: config.envFile })
      output({ ...await configureFlowHooks(root, workspace), memo, state: 'PostgreSQL jt_flow', locator: flowPath(workspace) })
      return
    }
    if (command === 'hook') {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of process.stdin) {
        bytes += chunk.length
        if (bytes > 512000) throw new Error('Hook 输入超过 512000 字节')
        chunks.push(Buffer.from(chunk))
      }
      const staged = await stageFlowEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')), workspace)
      if (!staged) { output({}); return }
      let hook
      try {
        const location = locatorSchema.parse(await readJson(flowPath(workspace)))
        if (location.workspace !== workspace) throw new Error('流程连接配置的工作区不一致')
        const config = await loadConfig(root, location.envFile)
        store = new FlowStore(workspace, openDatabase(config, true))
        hook = await flowHook(staged.event, store)
        await unlink(staged.file)
      } catch (error) {
        process.stderr.write(JSON.stringify({ error: safeError(error), event: staged.file }) + '\n')
        if (['SessionStart', 'UserPromptSubmit', 'SubagentStart'].includes(staged.event.hook_event_name)) output({ hookSpecificOutput: {
          hookEventName: staged.event.hook_event_name,
          additionalContext: 'JTH 流程数据库暂不可用，事件已保留，后台正在准备。不能把缺少注入当成没有任务；继续主任务前用 jth flow context 恢复目标。',
        } })
        else output({})
        await startBackground(root, ['flow', 'sync', '--workspace', workspace], resolve(workspace, '.jth/flow-worker.log'))
        return
      }
      output(hook.output)
      if (hook.taskId) await scheduleRecall(root, store, hook.taskId)
      return
    }
    if (command === 'uninstall') { output(await configureFlowHooks(root, workspace, false)); return }
    if (!existsSync(flowPath(workspace))) throw new Error('旧流程尚未迁移；运行 jth flow migrate')
    const location = locatorSchema.parse(await readJson(flowPath(workspace)))
    if (location.workspace !== workspace) throw new Error('流程连接配置的工作区不一致')
    const config = await loadConfig(root, location.envFile)
    store = new FlowStore(workspace, await connectDatabase(config))
    await store.settings()
    const pending = await drainFlowEvents(store)
    if (command === 'sync') {
      for (const id of pending.taskIds) await scheduleRecall(root, store, id)
      output(pending)
      return
    }
    if (command === 'start') {
      if (values.phase && values.phase !== 'discussion' && values.phase !== 'execution') throw new Error('初始阶段只能为 discussion 或 execution')
      const task = await store.start({ goal: operand, acceptance: values.accept ?? [], scope: values.scope, checks: values.check,
        contextFiles: values.context, constraints: values.constraint, steps: values.step, phase: values.phase as 'discussion' | 'execution' | undefined,
      }, await workspaceSnapshot(workspace), sessionId)
      output({ ...taskView(task), recall: await scheduleRecall(root, store, task.id) })
      return
    }
    if (command === 'resume') {
      if (!sessionId) throw new Error('resume 需要当前 Codex 会话，或 --session <id>')
      const task = await store.resume(operand, sessionId, values.takeover)
      output({ ...taskView(task), recall: await scheduleRecall(root, store, task.id) })
      return
    }
    if (command === 'context') {
      if (!sessionId) throw new Error('context 需要 --session 或 CODEX_THREAD_ID')
      process.stdout.write(renderFlowContext(workspace, sessionId, await store.current(sessionId), await store.binding(sessionId)) + '\n')
      return
    }
    if (command === 'status' && values.all) { output({ settings: await store.settings(), tasks: (await store.tasks()).map(task => ({ id: task.id, goal: task.goal, phase: task.phase, next: task.next, blocked: task.blocked, updatedAt: task.updatedAt })) }); return }
    const taskId = values.task ?? (sessionId ? (await store.binding(sessionId))?.taskId : null)
    if (!taskId) {
      if (command === 'status') { output({ status: 'unbound', sessionId, recovery: 'jth flow start 或 resume；已有任务用 status --all' }); return }
      throw new Error('当前会话未绑定任务；使用 start、resume 或 --task <id>')
    }
    if (command === 'status') { output({ ...taskView(await store.task(taskId)), sessions: await store.bindings(taskId), ...(values.history ? { history: await store.history(taskId) } : {}) }); return }
    if (command === 'pause') { output(taskView(await store.pause(taskId, values.reason ?? '', sessionId))); return }
    if (command === 'recall') {
      const memory = await recallTask(root, store, taskId, values.request)
      output(memory)
      if (memory?.status === 'failed') process.exitCode = 1
      return
    }
    if (command === 'checkpoint') {
      if (values.phase && values.phase !== 'discussion' && values.phase !== 'execution') throw new Error('手动阶段只能为 discussion 或 execution')
      output(taskView(await store.checkpoint(taskId, { constraint: values.constraint, done: values.done, decision: values.decision, question: values.question, resolve: values.resolve,
        step: values.step, completeStep: values['complete-step'] === undefined ? undefined : Number(values['complete-step']),
        next: values.next, phase: values.phase as 'discussion' | 'execution' | undefined, reason: values.reason, blocked: values.blocked, check: values.check, context: values.context,
      }, sessionId)))
      await scheduleRecall(root, store, taskId)
      return
    }
    if (command === 'revise') {
      output(taskView(await store.revise(taskId, operand, values.reason ?? '', sessionId)))
      await scheduleRecall(root, store, taskId)
      return
    }
    if (command === 'verify') {
      const controller = new AbortController(), abort = () => controller.abort()
      process.once('SIGINT', abort); process.once('SIGTERM', abort)
      try {
        const result = await verifyTask(store, taskId, sessionId, Number(values['timeout-ms'] ?? 120000), controller.signal)
        output(result)
        if (!result.passed) process.exitCode = 1
      } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
      return
    }
    if (values.evidence) {
      const evidence = await realpath(resolve(workspace, values.evidence)), path = relative(workspace, evidence)
      if (path === '..' || path.startsWith('../') || isAbsolute(path) || !(await stat(evidence)).isFile()) throw new Error('验收证据必须是项目内真实文件')
    }
    output(taskView(await store.finish(taskId, values.summary ?? '', await workspaceSnapshot(workspace), sessionId, values.evidence)))
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: safeError(error) }) + '\n')
    process.exitCode = 1
  } finally { await store?.close() }
}
