import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { parse, patch } from '@decimalturn/toml-patch'
import { locatorSchema, settingsSchema } from '@jacob-z/jt-harness/flow'
import { cleanupProjectInstallation, configureUserHooks, configureMonitorHooks, readJson, writeJson } from '@jacob-z/jt-harness/codex-hooks'
import { userConfigPaths, type Config } from '@jacob-z/jt-harness/memo/config'
import { importLegacyBindings, legacyInstallations, loadLegacyWorkspaceConfig, workspaceBinding } from './configuration.ts'
import { configureWorkflowPolicy, workflowSettingsPaths, workflowSettingsSchema } from './workflow-settings.ts'

/** Remove only the values written by registered JTH project setup, preserving later edits. */
export async function removeManagedProjectPreferences(workspace: string, dryRun = false) {
  const path = resolve(workspace, '.codex/config.toml')
  const metadata = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!metadata) return { path, removed: [] as string[] }
  if (!metadata.isFile() || await realpath(resolve(workspace, '.codex')) !== resolve(workspace, '.codex')) throw new Error('项目 Codex 配置不是独立普通文件；保留原文件')
  const original = await readFile(path, 'utf8'), document = parse(original)
  const removed: string[] = []
  const memories = document.memories as Record<string, unknown> | undefined
  if (memories && typeof memories === 'object') {
    for (const key of ['use_memories', 'generate_memories']) if (memories[key] === false) { delete memories[key]; removed.push(`memories.${key}`) }
    if (!Object.keys(memories).length) delete document.memories
  }
  const tools = document.tools as Record<string, unknown> | undefined
  const plan = tools?.update_plan as Record<string, unknown> | undefined
  if (plan?.enabled === true) {
    delete plan.enabled; removed.push('tools.update_plan.enabled')
    if (!Object.keys(plan).length) delete tools!.update_plan
    if (!Object.keys(tools!).length) delete document.tools
  }
  if (!removed.length || dryRun) return { path, removed }
  const next = patch(original, document)
  if (await readFile(path, 'utf8') !== original) throw new Error('Codex 配置被其他进程更新；保留原文件，请重试')
  if (!next.trim()) await rm(path)
  else {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, next, { flag: 'wx', mode: metadata.mode & 0o777 })
      if (await readFile(path, 'utf8') !== original) throw new Error('Codex 配置被其他进程更新；保留原文件，请重试')
      await rename(temporary, path)
    }
    finally { await rm(temporary, { force: true }) }
  }
  return { path, removed }
}

async function projectLocator(workspace: string) {
  const flow = resolve(workspace, '.jth/flow.json'), memo = resolve(workspace, '.jth/memo.json')
  const flowValue = await readJson(flow), path = flowValue === undefined ? memo : flow
  const value = flowValue ?? await readJson(memo)
  if (value === undefined) return undefined
  const locator = locatorSchema.safeParse(value)
  if (locator.success) return { path, locator: locator.data }
  const legacy = settingsSchema.safeParse(value)
  if (legacy.success) return { path, locator: { version: 3 as const, scope: { project_ids: legacy.data.projectIds, business_ids: legacy.data.businessIds } } }
  return undefined
}

async function installedWorktrees(workspaces: string[]) {
  const execute = promisify(execFile)
  const related = await Promise.all(workspaces.map(async workspace => {
    try {
      const result = await execute('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: workspace })
      return result.stdout.split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as { stderr?: string }).stderr?.includes('not a git repository')) return []
      throw error
    }
  }))
  return related.flat()
}

export async function migrateUserInstallation(root: string, config: Config, codexHome: string, options: { workspaces?: string[], dryRun?: boolean, cleanupOnly?: boolean, existingOnly?: boolean, preserveLocalPolicy?: boolean } = {}) {
  const environment = process.env, dryRun = Boolean(options.dryRun)
  const installations = await legacyInstallations(config, options.cleanupOnly ? options.workspaces : undefined)
  const installed = installations.map(installation => installation.settings.workspace)
  const requested = options.workspaces?.length ? options.workspaces : [...installed, ...await installedWorktrees(installed)]
  const workspaces = [...new Set(requested.map(path => resolve(path)))]
  const imported = await importLegacyBindings(config, environment, dryRun, options.cleanupOnly ? options.workspaces : undefined)
  const projects = []
  let monitorEnabled = false
  for (const workspace of workspaces) {
    const available = await realpath(workspace).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!available) { projects.push({ workspace, available: false, preserved: '目录不可用，旧安装和队列保留' }); continue }
    const savedLocator = await projectLocator(available), locator = savedLocator?.locator
    const registered = installations.some(installation => installation.settings.workspace === available) || locator !== undefined
    const workflow = workflowSettingsSchema.safeParse(await readJson(resolve(available, '.jth/workflow.json')))
    const oldWorkflow = workflow.success ? workflow.data : undefined
    const oldMonitor = await readJson(resolve(available, '.jth/monitor.json')) as { enabled?: boolean } | undefined
    monitorEnabled ||= Boolean(oldMonitor?.enabled)
    const original = imported.find(entry => entry.workspace === available)?.binding
    const sourceInstallations = locator?.version === 2 ? await legacyInstallations(config, [locator.workspace]) : []
    const historicalIds = locator?.version === 3 ? locator.scope.project_ids : locator?.version === 2
      ? [...imported.flatMap(entry => entry.workspace === locator.workspace && entry.binding ? entry.binding.read_project_ids : []),
        ...sourceInstallations.flatMap(entry => entry.settings.scope.project_ids)] : []
    const legacyConfig = savedLocator ? await loadLegacyWorkspaceConfig(root, available) : undefined
    const locatorLegacy = locator ? { workspace: locator.version === 2 ? locator.workspace : available,
      env_file: locator.version === 2 ? locator.envFile : legacyConfig!.envFile, installation_path: savedLocator!.path,
      project_ids: historicalIds, business_ids: locator.version === 3 ? locator.scope.business_ids : [] } : undefined
    const binding = await workspaceBinding(available, environment, { dryRun, projectIds: dryRun ? original?.project_ids : undefined,
      readProjectIds: [...(original?.read_project_ids ?? []), ...historicalIds], businessIds: locator?.version === 3 ? locator.scope.business_ids : original?.business_ids,
      legacy: [...(original?.legacy ?? []), ...(locatorLegacy ? [locatorLegacy] : [])] })
    if (!dryRun && registered && oldWorkflow?.mode && (!options.preserveLocalPolicy || await readJson(workflowSettingsPaths(available).project) === undefined)) {
      await configureWorkflowPolicy(available, 'project', oldWorkflow.mode)
    }
    const cleanup = await cleanupProjectInstallation(available, { dataDir: config.dataDir, dryRun, registered, existingOnly: options.existingOnly })
    const preferences = registered ? await removeManagedProjectPreferences(available, dryRun) : { removed: [] }
    projects.push({ ...cleanup, available: true, registered, binding, legacy_locator: locator ?? null, codex_preferences: preferences,
      ...(oldWorkflow?.mode ? { workflow_policy: oldWorkflow.mode } : {}), ...(oldMonitor?.enabled ? { monitoring: options.cleanupOnly ? '保留用户级监控偏好' : '转为用户级' } : {}) })
  }
  const global = options.cleanupOnly ? null : dryRun ? { status: 'planned', hooks_path: resolve(codexHome, 'hooks.json'), skills: resolve(homedir(), '.agents/skills') }
    : await configureUserHooks(root, config, codexHome)
  if (!dryRun && monitorEnabled && !options.cleanupOnly) {
    await writeJson(resolve(userConfigPaths(environment).directory, 'monitor.json'), { enabled: true })
    await configureMonitorHooks(root, process.cwd(), true, { dataDir: config.dataDir, codexHome })
  }
  return { mode: 'user', dry_run: dryRun, global, imported, projects,
    database_preserved: true, queues_preserved: true, history_preserved: true, native_user_preferences_preserved: true }
}
