import { z } from 'zod'
import type { Config } from '../config.ts'
import { MemoStorageError, vectorSchema } from './contract.ts'

const responseSchema = z.object({
  model: z.string(),
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: vectorSchema })),
})

/** Bind each returned vector to exactly one submitted text. */
export async function embedTexts(texts: string[], config: Config['embedding'], signal?: AbortSignal): Promise<number[][]> {
  const { baseUrl, space, apiKey, timeoutMs } = config
  if (!baseUrl || !space || !apiKey) throw new MemoStorageError('EMBEDDING_NOT_CONFIGURED', 'Embedding 配置不完整')
  const vectors: number[][] = []
  // ponytail: the configured Qwen Flash endpoint returned index=0 for every
  // batch row in live testing. One text per call avoids guessing associations;
  // batch only after the provider supplies verified unique input indices.
  for (const text of texts) {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: space.model, input: [text], dimensions: space.dimensions, encoding_format: 'float' }),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new MemoStorageError('EMBEDDING_FAILED', `Embedding HTTP ${response.status}；任务保留，可修复配置后重试`)
    }
    const result = responseSchema.parse(await response.json())
    if (result.model !== space.model || result.data.length !== 1 || result.data[0].index !== 0 || result.data[0].embedding.length !== space.dimensions) {
      throw new MemoStorageError('INVALID_EMBEDDINGS', 'Embedding 返回的模型、数量、序号或维度与请求不符')
    }
    vectors.push(result.data[0].embedding)
  }
  return vectors
}
