import { chmod, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual, parseEnv, promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { z } from 'zod'
import { flowPath, legacyFlowPath, locatorSchema } from '@jacob-z/jt-harness/flow'
import { hash, memoLocatorPath, readJson, writeJson, codexDirectory, captureSettingsSchema, sessionWorkspaceContext, type CaptureSettings } from '@jacob-z/jt-harness/codex-hooks'
import { loadConfig, readConfigAliases, userConfigPaths, type Config } from '@jacob-z/jt-harness/memo/config'

const readEnv = (path: string) => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
const deviceBindingSchema = z.strictObject({ version: z.literal(1), envFile: z.string().refine(isAbsolute) })
const workspaceBindingSchema = z.strictObject({ version: z.literal(2), path: z.string(), identity: z.string(), display_name: z.string(),
  project_ids: z.array(z.string()), read_project_ids: z.array(z.string()), business_ids: z.array(z.string()),
  legacy: z.array(z.strictObject({ workspace: z.string(), env_file: z.string(), enabled_at: z.string().optional(), installation_path: z.string(),
    project_ids: z.array(z.string()), business_ids: z.array(z.string()) })).default([]),
})
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>
const deviceBindingPath = (workspace: string, environment: NodeJS.ProcessEnv = process.env) =>
  resolve(userConfigPaths(environment).directory, 'projects', `${hash(realpathSync(workspace))}.json`)

export async function saveWorkspaceBinding(workspace: string, envFile: string, environment: NodeJS.ProcessEnv = process.env) {
  await writeJson(deviceBindingPath(workspace, environment), deviceBindingSchema.parse({ version: 1, envFile }))
}

export async function removeWorkspaceBinding(workspace: string, environment: NodeJS.ProcessEnv = process.env) {
  await rm(deviceBindingPath(workspace, environment), { force: true })
}

export function findInstalledWorkspace(start: string) {
  let path = realpathSync(start)
  const original = path
  while (!existsSync(flowPath(path)) && !existsSync(memoLocatorPath(path))) {
    const parent = dirname(path)
    if (parent === path) return original
    path = parent
  }
  return path
}

export async function loadWorkspaceConfig(root: string, envFile?: string, _workspace = process.cwd(), environment: NodeJS.ProcessEnv = process.env) {
  if (envFile !== undefined || environment.JTH_ENV_FILE !== undefined) return loadConfig(root, envFile, environment)
  const selected = await readJson(resolve(userConfigPaths(environment).directory, 'configuration.json'))
  return loadConfig(root, selected ? deviceBindingSchema.parse(selected).envFile : undefined, environment)
}

export async function saveUserConfigBinding(envFile: string, environment: NodeJS.ProcessEnv = process.env) {
  await writeJson(resolve(userConfigPaths(environment).directory, 'configuration.json'), deviceBindingSchema.parse({ version: 1, envFile }))
}

export async function findLegacyWorkspace(start: string, environment: NodeJS.ProcessEnv = process.env) {
  const bindings = await workspaceBindings(environment)
  let path = await realpath(start)
  const original = path
  for (;;) {
    if (existsSync(flowPath(path)) || existsSync(legacyFlowPath(path)) || bindings.some(binding => binding.path === path && binding.legacy.length)) return path
    const parent = dirname(path)
    if (parent === path) return original
    path = parent
  }
}

/** Explicit legacy commands retain their original connection; native commands use the user selection. */
export async function loadLegacyWorkspaceConfig(root: string, workspace: string, envFile?: string, environment: NodeJS.ProcessEnv = process.env) {
  if (envFile !== undefined || environment.JTH_ENV_FILE !== undefined) return loadConfig(root, envFile, environment)
  const selected = await readJson(deviceBindingPath(workspace, environment))
  if ((selected as { version?: number } | undefined)?.version === 1) return loadConfig(root, deviceBindingSchema.parse(selected).envFile, environment)
  if ((selected as { version?: number } | undefined)?.version === 2) {
    const binding = workspaceBindingSchema.parse(selected)
    const legacy = binding.legacy.find(entry => entry.workspace === workspace) ?? binding.legacy[0]
    if (legacy) return loadConfig(root, legacy.env_file, environment)
  }
  const locator = await readJson(flowPath(workspace))
  if (locator !== undefined) {
    const saved = locatorSchema.parse(locator)
    if (saved.version === 2 && saved.workspace === workspace) return loadConfig(root, saved.envFile, environment)
  }
  return loadWorkspaceConfig(root, undefined, workspace, environment)
}

export async function workspaceIdentity(workspace: string) {
  return `path:${await realpath(workspace)}`
}

export async function workspaceBindings(environment: NodeJS.ProcessEnv = process.env) {
  const directory = resolve(userConfigPaths(environment).directory, 'projects')
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const entries = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
    const entry = await readJson(resolve(directory, name))
    if ((entry as { version?: number } | undefined)?.version === 1) { deviceBindingSchema.parse(entry); return undefined }
    return workspaceBindingSchema.parse(entry)
  }))
  return entries.filter((entry): entry is WorkspaceBinding => entry !== undefined)
}

export async function workspaceBinding(workspace: string, environment: NodeJS.ProcessEnv = process.env, options: {
  projectIds?: string[], readProjectIds?: string[], businessIds?: string[], legacy?: WorkspaceBinding['legacy'], dryRun?: boolean, independent?: boolean,
} = {}) {
  const path = await realpath(workspace), identity = await workspaceIdentity(path)
  const related = (await workspaceBindings(environment)).filter(binding => binding.identity === identity)
  const projectId = `${basename(path)}-${hash(identity).slice(0, 12)}`
  const legacy = [...related.flatMap(binding => binding.legacy), ...(options.legacy ?? [])]
    .filter((entry, index, entries) => entries.findIndex(other => other.installation_path === entry.installation_path) === index)
  const projectIds = options.independent ? [projectId] : options.projectIds?.length ? options.projectIds : related[0]?.project_ids ?? [projectId]
  const binding = workspaceBindingSchema.parse({ version: 2, path, identity, display_name: basename(path), project_ids: projectIds,
    read_project_ids: [...new Set([...projectIds, ...related.flatMap(binding => binding.read_project_ids), ...(options.readProjectIds ?? []), ...legacy.flatMap(entry => entry.project_ids)])],
    business_ids: [...new Set([...related.flatMap(binding => binding.business_ids), ...(options.businessIds ?? []), ...legacy.flatMap(entry => entry.business_ids)])], legacy })
  if (!options.dryRun) await writeJson(deviceBindingPath(path, environment), binding)
  return binding
}

export async function legacyInstallations(config: { dataDir: string }) {
  const directory = resolve(codexDirectory(config), 'installations')
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  return (await Promise.all(names.filter(name => name.endsWith('.json') && !name.startsWith('user-')).map(async name => {
    const path = resolve(directory, name), entry = await readJson(path) as { settings?: unknown, disabled?: boolean } | undefined
    if (!entry?.settings) return undefined
    const settings = captureSettingsSchema.parse(entry.settings)
    return { path, settings, disabled: Boolean(entry.disabled) }
  }))).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
}

export async function importLegacyBindings(config: { dataDir: string }, environment: NodeJS.ProcessEnv = process.env, dryRun = false) {
  const imported = []
  for (const installation of await legacyInstallations(config)) {
    const settings = installation.settings
    const available = await realpath(settings.workspace).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!available) { imported.push({ workspace: settings.workspace, available: false, installation: installation.path }); continue }
    const existing = (await workspaceBindings(environment)).find(binding => binding.path === available)
    const independent = !existing && await secondaryGitWorktree(available)
    const binding = await workspaceBinding(available, environment, { dryRun, independent, projectIds: existing ? undefined : settings.scope.project_ids, businessIds: settings.scope.business_ids,
      legacy: [{ workspace: settings.workspace, env_file: settings.env_file, enabled_at: settings.enabled_at, installation_path: installation.path,
        project_ids: settings.scope.project_ids, business_ids: settings.scope.business_ids }] })
    imported.push({ workspace: available, available: true, installation: installation.path, binding })
  }
  return imported
}

async function secondaryGitWorktree(workspace: string) {
  try {
    const result = await promisify(execFile)('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: workspace })
    const primary = result.stdout.split('\0').find(field => field.startsWith('worktree '))
    return primary !== undefined && await realpath(primary.slice(9)) !== workspace
  } catch (error) {
    if ((error as { stderr?: string }).stderr?.includes('not a git repository')) return false
    throw error
  }
}

export async function automaticWorkspaceScope(input: unknown, codexHome: string, environment: NodeJS.ProcessEnv = process.env) {
  const context = await sessionWorkspaceContext(input, codexHome)
  const ordered = context.primary ? [context.primary, ...context.roots.filter(path => path !== context.primary)] : context.roots
  const bindings = await Promise.all(ordered.map(path => workspaceBinding(path, environment, { dryRun: true })))
  const workspaces: NonNullable<CaptureSettings['workspaces']> = ordered.length
    ? bindings.map(binding => ({ path: binding.path, project_ids: binding.project_ids, business_ids: binding.business_ids }))
    : [{ path: context.cwd, project_ids: ['default'], business_ids: [] }]
  return { ...context, workspaces, scope: { project_ids: bindings.length ? [...new Set(bindings.flatMap(binding => binding.read_project_ids))] : ['default'],
    business_ids: [...new Set(workspaces.flatMap(workspace => workspace.business_ids))] } }
}

export async function configurationScope(config: Config, environment: NodeJS.ProcessEnv = process.env) {
  const path = userConfigPaths(environment).envFile
  const userFile = await realpath(path).catch(error => { if (error.code === 'ENOENT') return path; throw error })
  return { scope: config.envFile === userFile ? 'user' : 'override', envFile: config.envFile, userFile }
}

function patchEnv(contents: string, values: Record<string, string>) {
  let next = contents
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value) || (value.includes("'") && value.includes('"'))) throw new Error(`${key} 包含 .env 不支持的引号或换行，配置未保存`)
    const mark = value.includes("'") ? '"' : "'"
    const line = `${key}=${mark}${value}${mark}`
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm')
    next = pattern.test(next) ? next.replace(pattern, () => line) : next + (next && !next.endsWith('\n') ? '\n' : '') + line + '\n'
  }
  for (const [key, value] of Object.entries(values)) if (parseEnv(next)[key] !== value) throw new Error(`${key} 无法无损保存，配置未改变`)
  return next
}

async function saveEnv(path: string, contents: string, expected?: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    if (expected === undefined) await link(temporary, path)
    else {
      if (await readEnv(path) !== expected) throw new Error('配置被其他进程修改，原文件已保留，请重试')
      await rename(temporary, path)
    }
  } finally { await rm(temporary, { force: true }) }
}

function relocatedEnv(contents: string, source: string) {
  const values = parseEnv(contents), paths: Record<string, string> = {}
  for (const name of ['JTH_DATA_DIR', 'JTH_PG_DATA_DIR', 'JTH_PG_BIN_DIR', 'JTH_DSH_BIN', 'JTH_DSH_HOME']) {
    if (values[name]) paths[name] = resolve(dirname(source), values[name])
  }
  paths.JTH_DATA_DIR ??= resolve(homedir(), '.jth')
  return patchEnv(contents, paths)
}

/** Copy credentials once; aliases keep historical source pointers and queue snapshots usable. */
export async function ensureUserConfig(root: string, source?: string, environment: NodeJS.ProcessEnv = process.env) {
  let paths = userConfigPaths(environment)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  if ((await lstat(paths.directory)).isSymbolicLink()) throw new Error('用户配置目录不能是符号链接；原配置已保留')
  paths = userConfigPaths({ ...environment, JTH_CONFIG_DIR: await realpath(paths.directory) })
  await chmod(paths.directory, 0o700)
  const existing = await lstat(paths.envFile).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (existing && !existing.isFile()) throw new Error('用户配置必须是普通文件，不能继续链接到源码仓库')
  if (existing && !source) {
    await chmod(paths.envFile, 0o600)
    return { ...paths, created: false, imported: false }
  }
  const candidate = source ? resolve(source) : resolve(root, '.env')
  const original = await lstat(candidate).then(info => info.isSymbolicLink() ? realpath(candidate) : candidate).catch(error => {
    if (!source && error.code === 'ENOENT') return undefined
    throw error
  })
  const imported = original && original !== paths.envFile ? relocatedEnv(await readFile(original, 'utf8'), original) : undefined
  const before = await readEnv(paths.envFile)
  if (before === undefined) {
    const contents = imported ?? await readFile(resolve(root, '.env.example'), 'utf8')
    try { await saveEnv(paths.envFile, contents) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  await chmod(paths.envFile, 0o600)
  const contents = (await readEnv(paths.envFile))!
  const equivalent = imported !== undefined && isDeepStrictEqual(parseEnv(relocatedEnv(contents, paths.envFile)), parseEnv(imported))
  if (equivalent) {
    const sources = [...new Set([...await readConfigAliases(environment), candidate, original!])].filter(path => path !== paths.envFile).sort()
    await writeJson(paths.aliasesFile, { version: 1, sources })
  }
  return { ...paths, created: before === undefined, imported: equivalent }
}

export function promptConfigValue(label: string, options: { value?: string, secret?: boolean, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream } = {}) {
  const input = options.input ?? process.stdin, destination = options.output ?? process.stderr
  let muted = false, answered = false
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) destination.write(chunk); done() } })
  const reader = createInterface({ input, output, terminal: true })
  return new Promise<string>((done, reject) => {
    reader.once('close', () => { if (!answered) reject(new Error('已取消初始化')) })
    reader.once('SIGINT', () => reader.close())
    reader.question(`${label}${!options.secret && options.value ? ` [${options.value}]` : ''}: `, value => {
      answered = true
      reader.close()
      if (options.secret) destination.write('\n')
      done(value.trim() || options.value || '')
    })
    muted = Boolean(options.secret)
  })
}

export function missingConfiguration(config: Config) {
  return [!config.databaseUrl?.trim() && 'JTH_DATABASE_URL', !config.embedding.baseUrl && 'EMBEDDING_BASE_URL',
    !config.embedding.model?.trim() && 'EMBEDDING_MODEL', !config.embedding.apiKey?.trim() && 'EMBEDDING_API_KEY'].filter((value): value is string => Boolean(value))
}

export async function promptConfirmation(label: string) {
  for (;;) {
    const answer = (await promptConfigValue(`${label}（Y/n）`, { value: 'y' })).toLowerCase()
    if (['y', 'yes', '是'].includes(answer)) return true
    if (['n', 'no', '否'].includes(answer)) return false
    process.stderr.write('请输入 y 或 n。\n')
  }
}

export async function completeConfiguration(root: string, config: Config, options: {
  environment?: NodeJS.ProcessEnv, reviewDefaults?: boolean, editDatabase?: boolean, interactive?: boolean, ask?: typeof promptConfigValue,
} = {}) {
  const missing = missingConfiguration(config)
  if (!missing.length && !options.editDatabase) return config
  if (!(options.interactive ?? (process.stdin.isTTY && process.stderr.isTTY))) {
    throw new Error(`配置不完整：缺少 ${missing.join('、')}。请在交互终端运行 jth init，或填写 ${config.envFile}；非交互模式也可使用 --env-file 或环境变量`)
  }
  const environment = options.environment ?? process.env, ask = options.ask ?? promptConfigValue
  const before = await readEnv(config.envFile), values = { ...parseEnv(before ?? ''), ...environment }
  const updates: Record<string, string> = {}
  const fields = [
    { name: 'EMBEDDING_BASE_URL', label: 'Embedding 服务地址', fallback: '', secret: false },
    { name: 'EMBEDDING_MODEL', label: 'Embedding 模型', fallback: '', secret: false },
    { name: 'EMBEDDING_DIMENSIONS', label: '向量维度', fallback: '1024', secret: false },
    { name: 'JTH_DATABASE_URL', label: 'PostgreSQL 连接地址（隐藏输入，回车保留已有值）', fallback: '', secret: true },
    { name: 'EMBEDDING_API_KEY', label: 'Embedding API Key（隐藏输入）', fallback: '', secret: true },
  ]
  for (const field of fields) {
    if (values[field.name]?.trim() && !(options.editDatabase && field.name === 'JTH_DATABASE_URL')
      && (!options.reviewDefaults || field.name === 'EMBEDDING_API_KEY')) continue
    while (true) {
      let label = field.label
      if (field.name === 'EMBEDDING_API_KEY') label = `Embedding API Key（${new URL(updates.EMBEDDING_BASE_URL ?? config.embedding.baseUrl!).host}，隐藏输入）`
      const existingValue = values[field.name]
      if (field.name === 'JTH_DATABASE_URL' && existingValue && URL.canParse(existingValue)) {
        const url = new URL(existingValue)
        label = `PostgreSQL 连接地址（默认 ${url.hostname || '本地套接字'}${url.port ? `:${url.port}` : ''}${url.pathname}，隐藏输入）`
      }
      const value = (await ask(label, { value: field.name === 'EMBEDDING_API_KEY' ? undefined : values[field.name] ?? field.fallback, secret: field.secret })).trim()
      let valid = Boolean(value)
      if (field.name === 'EMBEDDING_DIMENSIONS') valid = Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 16000
      if (field.name.endsWith('_URL')) {
        try {
          const url = new URL(value)
          valid = field.name === 'JTH_DATABASE_URL' ? ['postgres:', 'postgresql:'].includes(url.protocol)
            : ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
        } catch { valid = false }
      }
      if (!valid) { process.stderr.write(`${field.name} 无效，请重新输入。\n`); continue }
      updates[field.name] = value
      break
    }
  }
  const next = patchEnv(before ?? '', updates)
  await saveEnv(config.envFile, next, before)
  return loadConfig(root, config.envFile, environment)
}
