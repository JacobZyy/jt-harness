import { resolve } from 'node:path'
import { z } from 'zod'
import { policyModeSchema, type PolicyMode } from '@jacob-z/jt-harness/flow'
import { readJson, writeJson } from '@jacob-z/jt-harness/codex-hooks'
import { userConfigPaths } from '@jacob-z/jt-harness/memo/config'

const settingsSchema = z.strictObject({ mode: policyModeSchema.optional() })
export function workflowSettingsPaths(workspace: string, environment: NodeJS.ProcessEnv = process.env) {
  return {
    user: resolve(userConfigPaths(environment).directory, 'workflow.json'),
    project: resolve(workspace, '.jth/workflow.json'),
  }
}

async function readSettings(file: string) {
  const value = await readJson(file).catch(error => {
    if (error instanceof SyntaxError) throw new Error(`Workflow Policy 配置不是有效 JSON：${file}`)
    throw error
  })
  const result = settingsSchema.safeParse(value === undefined ? {} : value)
  if (!result.success) throw new Error(`Workflow Policy 配置无效：${file}`)
  return result.data
}

/** Policy settings are local and independent of Memo credentials, databases, and model configuration. */
export async function resolveWorkflowPolicy(workspace: string, override?: PolicyMode, environment: NodeJS.ProcessEnv = process.env) {
  if (override !== undefined) return { mode: override, source: 'argument', file: null }
  if (environment.JTH_WORKFLOW_POLICY_MODE !== undefined) {
    return { mode: policyModeSchema.parse(environment.JTH_WORKFLOW_POLICY_MODE), source: 'environment', file: null }
  }
  const paths = workflowSettingsPaths(workspace, environment)
  for (const source of ['project', 'user'] as const) {
    const settings = await readSettings(paths[source])
    if (settings.mode !== undefined) return { mode: settings.mode, source, file: paths[source] }
  }
  return { mode: 'adaptive' as const, source: 'default', file: null }
}

export async function configureWorkflowPolicy(workspace: string, scope: 'user' | 'project', mode: PolicyMode | 'inherit', environment: NodeJS.ProcessEnv = process.env) {
  const file = workflowSettingsPaths(workspace, environment)[scope]
  await readSettings(file)
  await writeJson(file, mode === 'inherit' ? {} : { mode })
  return { scope, file, configured: mode, effective: await resolveWorkflowPolicy(workspace, undefined, environment) }
}
