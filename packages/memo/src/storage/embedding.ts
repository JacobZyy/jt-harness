import { z } from 'zod'
import { safeError } from '../config.ts'
import type { Config } from '../config.ts'
import { MemoStorageError, vectorSchema } from './contract.ts'
import { sanitizeMemoryText } from '../memory-context.ts'

const responseSchema = z.object({
  model: z.string(),
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: vectorSchema })),
})

export interface EmbeddingAttempt {
  text_index: number
  started_at: string
  completed_at: string
  model: string
  status: 'complete' | 'failed'
  error: string | null
  usage: { prompt_tokens: number | null, total_tokens: number | null }
}
const tokenNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

function providerUsage(value: unknown): EmbeddingAttempt['usage'] {
  const raw = value && typeof value === 'object' && 'usage' in value ? value.usage : null
  const usage = raw && typeof raw === 'object' ? raw : {}
  return { prompt_tokens: tokenNumber('prompt_tokens' in usage ? usage.prompt_tokens : null), total_tokens: tokenNumber('total_tokens' in usage ? usage.total_tokens : null) }
}

/** Bind each returned vector to exactly one submitted text. */
export async function embedTexts(texts: string[], config: Config['embedding'], signal?: AbortSignal, onAttempt?: (attempt: EmbeddingAttempt) => Promise<void>): Promise<number[][]> {
  const { baseUrl, space, apiKey, timeoutMs } = config
  if (!baseUrl || !space || !apiKey) throw new MemoStorageError('EMBEDDING_NOT_CONFIGURED', 'Embedding 配置不完整')
  const vectors: number[][] = []
  // ponytail: the configured Qwen Flash endpoint returned index=0 for every
  // batch row in live testing. One text per call avoids guessing associations;
  // batch only after the provider supplies verified unique input indices.
  for (const [text_index, text] of texts.entries()) {
    const started_at = new Date().toISOString()
    let usage: EmbeddingAttempt['usage'] = { prompt_tokens: null, total_tokens: null }
    const safeText = sanitizeMemoryText(text)
    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: space.model, input: [safeText], dimensions: space.dimensions, encoding_format: 'float' }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      }).catch((error: unknown) => {
        signal?.throwIfAborted()
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
        const detail = [error instanceof Error ? error.message : '网络错误', cause].filter(Boolean).join(': ')
        throw new Error(`Embedding 请求失败：${detail}；任务保留，可恢复连接后 retry`, { cause: error })
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new MemoStorageError('EMBEDDING_FAILED', `Embedding HTTP ${response.status}；任务保留，可修复配置后重试`)
      }
      const body: unknown = await response.json()
      usage = providerUsage(body)
      const result = responseSchema.parse(body)
      if (result.model !== space.model || result.data.length !== 1 || result.data[0].index !== 0 || result.data[0].embedding.length !== space.dimensions) {
        throw new MemoStorageError('INVALID_EMBEDDINGS', 'Embedding 返回的模型、数量、序号或维度与请求不符')
      }
      vectors.push(result.data[0].embedding)
    } catch (error) {
      await onAttempt?.({ text_index, started_at, completed_at: new Date().toISOString(), model: space.model, status: 'failed', error: safeError(error).replaceAll(apiKey, '[redacted]'), usage })
      throw error
    }
    await onAttempt?.({ text_index, started_at, completed_at: new Date().toISOString(), model: space.model, status: 'complete', error: null, usage })
  }
  return vectors
}
