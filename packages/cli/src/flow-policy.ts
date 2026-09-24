import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { evaluatePolicy, findFlowWorkspace, planDraftSchema, planningTemplate, policyModeSchema, policyRequestSchema } from '@jacob-z/jt-harness/flow'
import { safeError } from '@jacob-z/jt-harness/memo/config'
import { codexProgressSchema, prepareCodexPlan } from './plan-adapters/codex.ts'
import { codexGoalSchema, prepareCodexGoal } from './codex-goal.ts'
import { configureWorkflowPolicy, resolveWorkflowPolicy, workflowSettingsPaths } from './workflow-settings.ts'

const invocationSchema = z.strictObject({ request: policyRequestSchema, plan: planDraftSchema.optional(), progress: codexProgressSchema.default([]), goal: codexGoalSchema.prefault({}) })
const help = `jth flow policy <file.json|-> [--mode adaptive|strict] [--host codex] [--plan-tool available|unavailable] [--goal-tools available|unavailable] [--role primary|delegate]
jth flow config [--scope user|project] [--mode adaptive|strict|inherit]
通用：--workspace <目录>
policy 读取主 Agent 显式声明的 request，可附 plan、progress、goal；返回 recording（计划）及 goal（目标）的待调用参数，不保存或更新任务。
config 不传 --mode 时只读；默认 adaptive。覆盖顺序：policy --mode、JTH_WORKFLOW_POLICY_MODE、项目配置、用户配置、默认值。
Codex 原生计划工具是否可用，由主 Agent 按实际工具清单声明；不传时为 unknown，不伪造原生调用。
--goal-tools available 表示 get_goal/create_goal/update_goal 均实际可用；goal.authorization 为 user/instruction/none，current 为 unknown/none/same/other/complete。仅用户明确指定预算时提供 goal.tokenBudget。
`

async function readInvocation(file: string) {
  let text: string
  if (file === '-') {
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 512_000) throw new Error('策略输入超过 512000 字节')
      chunks.push(Buffer.from(chunk))
    }
    text = Buffer.concat(chunks).toString('utf8')
  } else text = await readFile(resolve(file), 'utf8')
  if (Buffer.byteLength(text) > 512_000) throw new Error('策略输入超过 512000 字节')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('策略输入不是有效 JSON') }
  return invocationSchema.parse(value)
}

export async function flowPolicyMain(args: string[]) {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      workspace: { type: 'string' }, mode: { type: 'string' }, scope: { type: 'string' }, host: { type: 'string' },
      'plan-tool': { type: 'string' }, 'goal-tools': { type: 'string' }, role: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } })
    if (values.help) { process.stdout.write(help); return }
    const cwd = await realpath(resolve(values.workspace ?? process.cwd()))
    const workspace = findFlowWorkspace(cwd, true) ?? cwd
    const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
    if (positionals[0] === 'config') {
      if (positionals.length !== 1 || values.host || values['plan-tool'] || values['goal-tools'] || values.role) throw new Error('config 参数不支持；运行 jth flow config --help')
      const scope = z.enum(['user', 'project']).parse(values.scope ?? 'project')
      if (values.mode === undefined) {
        output({ effective: await resolveWorkflowPolicy(workspace), paths: workflowSettingsPaths(workspace) }); return
      }
      const mode = z.enum(['adaptive', 'strict', 'inherit']).parse(values.mode)
      output(await configureWorkflowPolicy(workspace, scope, mode)); return
    }
    if (positionals[0] !== 'policy' || positionals.length !== 2 || values.scope) throw new Error('参数不符；运行 jth flow policy --help')
    if (values.host !== undefined && values.host !== 'codex') throw new Error(`宿主 ${values.host} 尚无任务记录适配器；当前支持 codex`)
    const context = {
      role: z.enum(['primary', 'delegate']).parse(values.role ?? 'primary'),
      planTool: z.enum(['available', 'unavailable', 'unknown']).parse(values['plan-tool'] ?? 'unknown'),
      goalTools: z.enum(['available', 'unavailable', 'unknown']).parse(values['goal-tools'] ?? 'unknown'),
    }
    const mode = values.mode === undefined ? undefined : policyModeSchema.parse(values.mode)
    const settings = await resolveWorkflowPolicy(workspace, mode)
    const input = await readInvocation(positionals[1])
    const decision = evaluatePolicy(input.request, settings.mode)
    if (input.plan && decision.disposition !== 'planned') throw new Error('当前策略不需要计划；不要附带任务列表或执行原生计划更新')
    if (input.progress.length && !input.plan) throw new Error('进度必须与完整计划同时提供')
    output({ policy: settings, decision, template: planningTemplate(decision),
      recording: prepareCodexPlan(decision, context, input.plan, input.progress),
      goal: prepareCodexGoal(decision, context, input.goal, input.plan) })
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: safeError(error) }) + '\n'); process.exitCode = 1
  }
}
