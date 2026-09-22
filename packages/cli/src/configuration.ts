import { chmod, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual, parseEnv } from 'node:util'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { stdin, stderr } from 'node:process'
import { findFlowWorkspace, flowPath, locatorSchema } from '@jt-harness/flow'
import { readJson, writeJson } from '@jt-harness/codex-hooks'
import { loadConfig, readConfigAliases, userConfigPaths, type Config } from '@jt-harness/memo/config'

const readEnv = (path: string) => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })

export async function loadWorkspaceConfig(root: string, envFile?: string, workspace = process.cwd(), environment: NodeJS.ProcessEnv = process.env) {
  if (envFile !== undefined || environment.JTH_ENV_FILE !== undefined) return loadConfig(root, envFile, environment)
  const installed = findFlowWorkspace(workspace, true)
  const locator = installed ? await readJson(flowPath(installed)) : undefined
  if (!locator) return loadConfig(root, undefined, environment)
  const saved = locatorSchema.parse(locator)
  if (saved.workspace !== installed) throw new Error('流程连接配置的工作区不一致')
  return loadConfig(root, saved.envFile, environment)
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
  const input = options.input ?? stdin, destination = options.output ?? stderr
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
    stderr.write('请输入 y 或 n。\n')
  }
}

export async function completeConfiguration(root: string, config: Config, options: {
  environment?: NodeJS.ProcessEnv, reviewDefaults?: boolean, editDatabase?: boolean, interactive?: boolean, ask?: typeof promptConfigValue,
} = {}) {
  const missing = missingConfiguration(config)
  if (!missing.length && !options.editDatabase) return config
  if (!(options.interactive ?? (stdin.isTTY && stderr.isTTY))) {
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
      if (!valid) { stderr.write(`${field.name} 无效，请重新输入。\n`); continue }
      updates[field.name] = value
      break
    }
  }
  const next = patchEnv(before ?? '', updates)
  await saveEnv(config.envFile, next, before)
  return loadConfig(root, config.envFile, environment)
}
