import { mkdtemp, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { z } from 'zod'
import type { Config } from './config.ts'

const catalogSchema = z.array(z.object({ provider: z.string(), name: z.string(), models: z.array(z.object({ id: z.string(), name: z.string() })) }))
async function withCatalogClient<T>(agent: Config['agent'], operation: (client: HarnessClient) => Promise<T>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-models-'))
  const patch = resolve(directory, 'catalog.yml')
  await writeFile(patch, JSON.stringify([{ id: 'sdk-jsonrpc-server', disabled: true }, { insert: [{ id: 'memo-model-catalog', name: new URL('./agents/catalog-plugin.js', import.meta.url).href }] }]), { mode: 0o600 })
  const client = new HarnessClient({ profile: 'sdk-minimal', patches: [fileURLToPath(new URL('./agents/agent.cordis.patch.yml', import.meta.url)), patch],
    dshBin: agent.dshBin, dshHome: agent.dshHome, processCwd: directory, requestTimeoutMs: 30000 })
  try { return await operation(client) }
  finally { await client.close(); await rm(directory, { recursive: true, force: true }) }
}
const resolvedSchema = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional(), maxTokens: z.number().int().positive().optional() })
async function checkModel(client: HarnessClient, provider: string, model: string) {
  return resolvedSchema.parse(await client.request('memo/check-model', { provider, model }))
}
export function withModelCatalog<T>(config: Config, operation: (catalog: z.infer<typeof catalogSchema>, check: (provider: string, model: string) => ReturnType<typeof checkModel>) => Promise<T>) {
  return withCatalogClient(config.agent, async client => operation(catalogSchema.parse(await client.request('memo/models')),
    (provider, model) => checkModel(client, provider, model)))
}
export function modelEnv(contents: string, provider: string, model: string) {
  // Quotes follow Node's parseEnv rules. Newline/quote values cannot represent a single model selection.
  if ([provider, model].some(value => !value || /[\r\n"\\]/.test(value))) throw new Error('模型标识包含不支持的环境变量字符')
  let next = contents
  for (const [key, value] of [['JTH_DSH_PROVIDER', provider], ['JTH_DSH_MODEL', model]]) {
    const line = `${key}="${value}"`
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm')
    next = pattern.test(next) ? next.replace(pattern, () => line) : next + (next.endsWith('\n') || !next ? '' : '\n') + line + '\n'
  }
  return next
}
export const envVersion = (text: string) => createHash('sha256').update(text).digest('hex')
export async function saveModel(config: Config, provider: string, model: string, expectedVersion: string) {
  const original = await readFile(config.envFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if (envVersion(original) !== expectedVersion) throw new Error('.env 已被修改，请重新选择模型')
  const temporary = `${config.envFile}.${process.pid}.tmp`
  try {
    await writeFile(temporary, modelEnv(original, provider, model), { mode: 0o600, flag: 'wx' })
    await rename(temporary, config.envFile)
    await chmod(config.envFile, 0o600)
  } finally { await rm(temporary, { force: true }) }
}
