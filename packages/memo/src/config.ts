import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { optionsSchema } from './contracts.ts'
import { sha256, spaceSchema } from './storage/contract.ts'

const positiveInteger = z.coerce.number().int().positive()
const endpoint = z.url().transform(value => new URL(value)).refine(url => (
  ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
), 'Embedding 地址必须为不含凭据、查询参数的 HTTP(S) URL').transform(url => url.href.replace(/\/$/, ''))

export function userConfigPaths(environment: NodeJS.ProcessEnv = process.env) {
  const directory = resolve(environment.JTH_CONFIG_DIR ?? resolve(homedir(), '.jt-harness'))
  return { directory, envFile: resolve(directory, '.env'), aliasesFile: resolve(directory, 'config-migrations.json') }
}

export async function readConfigAliases(environment: NodeJS.ProcessEnv = process.env) {
  const contents = await readFile(userConfigPaths(environment).aliasesFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (contents === undefined) return []
  let value: unknown
  try { value = JSON.parse(contents) } catch { throw new Error('用户配置迁移记录不是有效 JSON') }
  return z.strictObject({ version: z.literal(1), sources: z.array(z.string().refine(isAbsolute)) }).parse(value).sources
}

export async function configLocation(envFile?: string, environment: NodeJS.ProcessEnv = process.env) {
  const paths = userConfigPaths(environment), aliases = await readConfigAliases(environment)
  const requested = resolve(envFile ?? environment.JTH_ENV_FILE ?? paths.envFile)
  const actual = await lstat(requested).then(info => info.isSymbolicLink() ? realpath(requested) : requested)
    .catch(error => { if (error.code === 'ENOENT') return requested; throw error })
  const managed = await realpath(paths.envFile).catch(error => { if (error.code === 'ENOENT') return paths.envFile; throw error })
  const file = requested === paths.envFile || aliases.includes(requested) || aliases.includes(actual) ? managed : actual
  return { envFile: file, envAliases: file === managed ? aliases : [] }
}

export function matchesConfigFile(config: { envFile: string, envAliases?: readonly string[] }, file: string | undefined) {
  return file !== undefined && (config.envFile === file || Boolean(config.envAliases?.includes(file)))
}

export async function loadConfig(_root: string, envFile?: string, environment: NodeJS.ProcessEnv = process.env) {
  const location = await configLocation(envFile, environment), file = location.envFile
  let contents = ''
  try { contents = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const values = { ...parseEnv(contents), ...Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)) }
  const runtime = optionsSchema.parse(JSON.parse(await readFile(new URL('./agents/runtime.json', import.meta.url), 'utf8')))
  const agent = optionsSchema.parse({
    ...runtime,
    provider: values.JTH_DSH_PROVIDER ?? runtime.provider,
    model: values.JTH_DSH_MODEL ?? runtime.model,
    timeoutMs: values.JTH_DSH_TIMEOUT_MS === undefined ? runtime.timeoutMs : Number(values.JTH_DSH_TIMEOUT_MS),
    dshBin: values.JTH_DSH_BIN ? resolve(dirname(file), values.JTH_DSH_BIN) : runtime.dshBin,
    dshHome: values.JTH_DSH_HOME ? resolve(dirname(file), values.JTH_DSH_HOME) : runtime.dshHome,
  })
  const baseUrl = values.EMBEDDING_BASE_URL ? endpoint.parse(values.EMBEDDING_BASE_URL) : undefined
  const definition = baseUrl && values.EMBEDDING_MODEL ? {
    provider: baseUrl,
    model: values.EMBEDDING_MODEL,
    dimensions: positiveInteger.max(16_000).parse(values.EMBEDDING_DIMENSIONS ?? '1024'),
    input_version: 'content-v1' as const,
  } : undefined
  const space = definition ? spaceSchema.parse({ ...definition, id: `embedding-${sha256(JSON.stringify(definition)).slice(0, 24)}` }) : undefined
  return {
    ...location,
    databaseUrl: values.JTH_DATABASE_URL,
    dataDir: values.JTH_DATA_DIR ? resolve(dirname(file), values.JTH_DATA_DIR) : resolve(homedir(), '.jth'),
    postgres: values.JTH_PG_DATA_DIR ? {
      dataDir: resolve(dirname(file), values.JTH_PG_DATA_DIR),
      binDir: values.JTH_PG_BIN_DIR ? resolve(dirname(file), values.JTH_PG_BIN_DIR) : undefined,
    } : undefined,
    agent,
    embedding: {
      baseUrl, space, apiKey: values.EMBEDDING_API_KEY,
      ...(values.EMBEDDING_MODEL ? { model: values.EMBEDDING_MODEL } : {}),
      timeoutMs: positiveInteger.max(2_147_483_647).parse(values.EMBEDDING_TIMEOUT_MS ?? '60000'),
    },
  }
}

export type Config = Awaited<ReturnType<typeof loadConfig>>

/** Only public execution choices enter the durable queue; secrets stay in .env. */
export function executionProfile(config: Config) {
  if (!config.embedding.space || !config.embedding.apiKey) throw new Error('请在 .env 配置 EMBEDDING_BASE_URL、EMBEDDING_MODEL、EMBEDDING_API_KEY')
  return { envFile: config.envFile, dataDir: config.dataDir, agent: config.agent, space: config.embedding.space }
}
export type ExecutionProfile = ReturnType<typeof executionProfile>

export function safeError(error: unknown, config?: Config) {
  let message = error instanceof z.ZodError
    ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    : error instanceof Error ? error.message : '未知错误'
  const secrets = [config?.embedding.apiKey, config?.databaseUrl, ...Object.entries(process.env)
    .filter(([name]) => /KEY|TOKEN|PASSWORD|SECRET|DATABASE_URL/i.test(name)).map(([, value]) => value)]
  for (const value of secrets) if (value && value.length > 3) message = message.replaceAll(value, '[redacted]')
  return message.replace(/(Bearer\s+)\S+/gi, '$1[redacted]').slice(0, 1200)
}
