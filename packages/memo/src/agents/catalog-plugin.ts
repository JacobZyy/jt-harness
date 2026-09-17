import type { Context } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { z } from 'zod'

export const name = 'memo-model-catalog'
export const inject = ['llm', 'loader']

/** A read-only SDK endpoint: discover the same loaded adapters without creating a model conversation. */
export function apply(ctx: Context) {
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout)
  transport.onRequest(async (method, params) => {
    if (method === 'shutdown') {
      setImmediate(() => { void transport.flush().then(() => ctx.root.fiber.dispose()).then(() => process.exit(0)) })
      return {}
    }
    const loader = ctx.get('loader') as { await(): Promise<unknown> }
    await loader.await()
    const llm = ctx.get('llm') as LlmRuntime
    if (method === 'memo/models') {
      return Promise.all(llm.listProviders().map(async provider => ({
        provider: provider.id, name: provider.name,
        models: (await llm.listModels(provider.id)).map(model => ({ id: model.id, name: model.name })),
      })))
    }
    if (method === 'memo/check-model') {
      const input = z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }).parse(params)
      return llm.resolveCallConfig(input)
    }
    throw new Error('Unknown memory catalog method')
  })
  ctx.effect(() => { transport.start(); return () => transport.close() })
}
