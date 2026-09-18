import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, relative, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { FlowStore, findFlowWorkspace, renderFlowContext, taskView, verifyTask, workspaceSnapshot } from '@jt-harness/flow'
import { configureFlowHooks, configureHooks, flowHook } from '@jt-harness/codex-hooks'
import { loadConfig, safeError } from '@jt-harness/memo/config'
import { recallTask, scheduleRecall } from './flow-memory.ts'

const help = `jth flow install --project <id> [--business <id>] [--env-file <path>]
jth flow start <目标> --accept <完成条件> [--phase discussion|execution] [--scope <相对路径>] [--check <命令>]
jth flow status [--all] [--history] | context
jth flow checkpoint [--done <进展>] [--next <下一步>] [--constraint <约束>] [--decision <结论>] [--question <问题>] [--resolve <问题ID>]
                    [--phase discussion|execution --reason <授权依据>] [--blocked <原因或空字符串>] [--check <命令>] [--context <相对路径>]
jth flow revise <新目标> --reason <用户变更依据>
jth flow resume <任务ID> [--takeover]
jth flow pause --reason <暂停或切换依据>
jth flow recall
jth flow verify [--timeout-ms <每项超时>]
jth flow finish --summary <达成结果> [--evidence <相对文件>]
jth flow uninstall
通用：--workspace <项目目录>。任务命令可用 --task <ID>；Codex 内默认绑定 CODEX_THREAD_ID，终端用 --session <ID> 或明确任务 ID。
accept、scope、check、context、constraint、done、decision、question、resolve 可重复。hook 是内部入口。
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
      all: { type: 'boolean' }, history: { type: 'boolean' }, takeover: { type: 'boolean' }, 'timeout-ms': { type: 'string' }, request: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } })
    const [command, operand] = positionals
    if (values.help || !command) { process.stdout.write(help); return }
    const allowed: Record<string, string[]> = {
      install: ['project', 'business', 'env-file'], uninstall: [], start: ['accept', 'scope', 'check', 'context', 'phase', 'constraint'],
      status: ['all', 'history'], context: [], checkpoint: ['constraint', 'done', 'decision', 'question', 'resolve', 'next', 'phase', 'reason', 'blocked', 'check', 'context'],
      revise: ['reason'], resume: ['takeover'], pause: ['reason'], verify: ['timeout-ms'], finish: ['summary', 'evidence'], recall: ['request'], hook: [],
    }
    if (!Object.hasOwn(allowed, command)) throw new Error('未知 flow 命令；使用 jth flow --help')
    const invalid = Object.keys(values).filter(key => !['workspace', 'session', 'task', 'help', ...allowed[command]].includes(key))
    if (invalid.length) throw new Error(command + ' 不支持：' + invalid.join(', '))
    if (positionals.length !== (['start', 'revise', 'resume'].includes(command) ? 2 : 1)) throw new Error('命令参数数量不符；使用 jth flow --help')
    const workspace = command === 'install' ? await realpath(resolve(values.workspace ?? process.cwd())) : findFlowWorkspace(values.workspace ?? process.cwd())
    const sessionId = values.session ?? process.env.CODEX_THREAD_ID
    store = new FlowStore(workspace, command === 'install')
    const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
    if (command === 'install') {
      const config = await loadConfig(root, values['env-file'])
      store.install({ version: 1, workspace, envFile: config.envFile, projectIds: values.project ?? [], businessIds: values.business ?? [], installedAt: new Date().toISOString() })
      const memo = await configureHooks(root, config, workspace, { project_ids: values.project ?? [], business_ids: values.business ?? [] }, resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex')))
      output({ ...await configureFlowHooks(root, workspace), memo, state: resolve(workspace, '.jth/flow.sqlite') })
      return
    }
    store.settings()
    if (command === 'uninstall') { output(await configureFlowHooks(root, workspace, false)); return }
    if (command === 'hook') {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of process.stdin) {
        bytes += chunk.length
        if (bytes > 512000) throw new Error('Hook 输入超过 512000 字节')
        chunks.push(Buffer.from(chunk))
      }
      const hook = await flowHook(JSON.parse(Buffer.concat(chunks).toString('utf8')), store)
      output(hook.output)
      if (hook.taskId) await scheduleRecall(root, store, hook.taskId)
      return
    }
    if (command === 'start') {
      if (values.phase && values.phase !== 'discussion' && values.phase !== 'execution') throw new Error('初始阶段只能为 discussion 或 execution')
      const task = store.start({ goal: operand, acceptance: values.accept ?? [], scope: values.scope, checks: values.check,
        contextFiles: values.context, constraints: values.constraint, phase: values.phase as 'discussion' | 'execution' | undefined,
      }, await workspaceSnapshot(workspace), sessionId)
      output({ ...taskView(task), recall: await scheduleRecall(root, store, task.id) })
      return
    }
    if (command === 'resume') {
      if (!sessionId) throw new Error('resume 需要当前 Codex 会话，或 --session <id>')
      const task = store.resume(operand, sessionId, values.takeover)
      output({ ...taskView(task), recall: await scheduleRecall(root, store, task.id) })
      return
    }
    if (command === 'context') {
      if (!sessionId) throw new Error('context 需要 --session 或 CODEX_THREAD_ID')
      process.stdout.write(renderFlowContext(workspace, sessionId, store.current(sessionId), store.binding(sessionId)) + '\n')
      return
    }
    if (command === 'status' && values.all) { output({ settings: store.settings(), tasks: store.tasks().map(task => ({ id: task.id, goal: task.goal, phase: task.phase, next: task.next, blocked: task.blocked, updatedAt: task.updatedAt })) }); return }
    const taskId = values.task ?? (sessionId ? store.binding(sessionId)?.taskId : null)
    if (!taskId) {
      if (command === 'status') { output({ status: 'unbound', sessionId, recovery: 'jth flow start 或 resume；已有任务用 status --all' }); return }
      throw new Error('当前会话未绑定任务；使用 start、resume 或 --task <id>')
    }
    if (command === 'status') { output({ ...taskView(store.task(taskId)), sessions: store.bindings(taskId), ...(values.history ? { history: store.history(taskId) } : {}) }); return }
    if (command === 'pause') { output(taskView(store.pause(taskId, values.reason ?? '', sessionId))); return }
    if (command === 'recall') {
      const memory = await recallTask(root, store, taskId, values.request)
      output(memory)
      if (memory?.status === 'failed') process.exitCode = 1
      return
    }
    if (command === 'checkpoint') {
      if (values.phase && values.phase !== 'discussion' && values.phase !== 'execution') throw new Error('手动阶段只能为 discussion 或 execution')
      output(taskView(store.checkpoint(taskId, { constraint: values.constraint, done: values.done, decision: values.decision, question: values.question, resolve: values.resolve,
        next: values.next, phase: values.phase as 'discussion' | 'execution' | undefined, reason: values.reason, blocked: values.blocked, check: values.check, context: values.context,
      }, sessionId)))
      await scheduleRecall(root, store, taskId)
      return
    }
    if (command === 'revise') {
      output(taskView(store.revise(taskId, operand, values.reason ?? '', sessionId)))
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
    output(taskView(store.finish(taskId, values.summary ?? '', await workspaceSnapshot(workspace), sessionId, values.evidence)))
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: safeError(error) }) + '\n')
    process.exitCode = 1
  } finally { store?.close() }
}
