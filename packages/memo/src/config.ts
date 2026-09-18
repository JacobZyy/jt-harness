import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { optionsSchema } from './contracts.ts'
import { sha256, spaceSchema } from './storage/contract.ts'

const positiveInteger = z.coerce.number().int().positive()
const endpoint = z.url().transform(value => new URL(value)).refine(url => (
  ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
), 'Embedding 地址必须为不含凭据、查询参数的 HTTP(S) URL').transform(url => url.href.replace(/\/$/, ''))

export async function loadConfig(root: string, envFile?: string, environment: NodeJS.ProcessEnv = process.env) {
  const file = resolve(envFile ?? environment.JTH_ENV_FILE ?? resolve(root, '.env'))
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
    envFile: file,
    databaseUrl: values.JTH_DATABASE_URL,
    dataDir: values.JTH_DATA_DIR ? resolve(dirname(file), values.JTH_DATA_DIR) : resolve(homedir(), '.jth'),
    postgres: values.JTH_PG_DATA_DIR ? {
      dataDir: resolve(dirname(file), values.JTH_PG_DATA_DIR),
      binDir: values.JTH_PG_BIN_DIR ? resolve(dirname(file), values.JTH_PG_BIN_DIR) : undefined,
    } : undefined,
    agent,
    embedding: {
      baseUrl, space, apiKey: values.EMBEDDING_API_KEY,
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
