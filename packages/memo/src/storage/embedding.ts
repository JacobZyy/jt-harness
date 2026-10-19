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
  request_attempt: number
  started_at: string
  completed_at: string
  duration_ms: number
  model: string
  endpoint: string
  status: 'complete' | 'failed'
  http_status: number | null
  request_id: string | null
  error_type: 'network' | 'timeout' | 'http' | 'protocol' | 'cancelled' | null
  error_code: string | null
  retry_delay_ms: number | null
  error: string | null
  usage: { prompt_tokens: number | null, total_tokens: number | null }
}
const tokenNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const maxRetries = 5

function networkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? String(error.code) : ''
  const causeCode = error.cause instanceof Error && 'code' in error.cause ? String(error.cause.code) : code
  if (/^(?:ERR_INVALID_|ERR_HTTP_INVALID_|ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(causeCode)) return false
  return /^(?:E(?:CONNRESET|CONNREFUSED|TIMEDOUT|AI_AGAIN|NETUNREACH|HOSTUNREACH)|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(code)
    || /fetch failed|failed to fetch|network error|load failed|socket connection was closed|operation timed out/i.test(error.message)
    || (error.cause !== undefined && networkError(error.cause))
}

function retryDelay(attempt: number, retryAfter: string | null) {
  const seconds = retryAfter === null ? NaN : Number(retryAfter)
  const after = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : retryAfter ? Date.parse(retryAfter) - Date.now() : 0
  return Math.min(30_000, Math.max(500 * 2 ** (attempt - 1), Number.isFinite(after) ? after : 0))
}

async function waitBeforeRetry(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

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
    const safeText = sanitizeMemoryText(text)
    const redact = (value: string) => {
      let redacted = value.replaceAll(apiKey, '[redacted]')
      for (const input of new Set([text, safeText])) if (input) redacted = redacted.replaceAll(input, '[redacted input]')
      return safeError(new Error(redacted))
    }
    const endpoint = new URL(`${baseUrl}/embeddings`)
    endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = ''
    for (let request_attempt = 1; ; request_attempt++) {
      signal?.throwIfAborted()
      const started = performance.now()
      const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
      const attempt: EmbeddingAttempt = { text_index, request_attempt, started_at: new Date().toISOString(), completed_at: '', duration_ms: 0,
        model: redact(space.model), endpoint: redact(endpoint.href), status: 'failed', http_status: null, request_id: null, error_type: null, error_code: null,
        retry_delay_ms: null, error: null, usage: { prompt_tokens: null, total_tokens: null } }
      let retryable = false
      let retryAfter: string | null = null
      const transportFailure = (error: unknown) => {
        signal?.throwIfAborted()
        attempt.error_type = requestSignal.aborted ? 'timeout' : 'network'
        retryable = requestSignal.aborted || networkError(error)
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
        if (cause instanceof Error && 'code' in cause) attempt.error_code = redact(String(cause.code))
        const detail = [error instanceof Error ? error.message : '网络错误', cause !== error && cause instanceof Error ? cause.message : ''].filter(Boolean).join(': ')
        return new Error(`Embedding 请求失败：${redact(detail)}；任务保留，可恢复连接后 retry`, { cause: error })
      }
      try {
        const response = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: space.model, input: [safeText], dimensions: space.dimensions, encoding_format: 'float' }),
          signal: requestSignal,
        }).catch((error: unknown) => { throw transportFailure(error) })
        attempt.http_status = response.status
        const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? response.headers.get('x-dashscope-request-id')
        attempt.request_id = requestId ? redact(requestId).slice(0, 200) : null
        retryAfter = response.headers.get('retry-after')
        if (!response.ok) {
          attempt.error_type = 'http'
          retryable = response.status === 429 || response.status >= 500
          await response.body?.cancel()
          throw new MemoStorageError('EMBEDDING_FAILED', `Embedding HTTP ${response.status}；任务保留，可修复配置后重试`)
        }
        const body: unknown = await response.json().catch((error: unknown) => {
          if (requestSignal.aborted || networkError(error)) throw transportFailure(error)
          throw new MemoStorageError('INVALID_EMBEDDINGS', 'Embedding 返回不是有效 JSON')
        })
        attempt.usage = providerUsage(body)
        attempt.error_type = 'protocol'
        const parsed = responseSchema.safeParse(body)
        if (!parsed.success) throw new MemoStorageError('INVALID_EMBEDDINGS', 'Embedding 返回协议无效：模型、序号和向量必须有效')
        const result = parsed.data
        if (result.model !== space.model || result.data.length !== 1 || result.data[0].index !== 0 || result.data[0].embedding.length !== space.dimensions) {
          throw new MemoStorageError('INVALID_EMBEDDINGS', 'Embedding 返回的模型、数量、序号或维度与请求不符')
        }
        signal?.throwIfAborted()
        vectors.push(result.data[0].embedding)
        attempt.status = 'complete'
        attempt.error_type = null
      } catch (error) {
        attempt.error = redact(error instanceof Error ? error.message : '未知错误')
        attempt.error_type = signal?.aborted ? 'cancelled' : attempt.error_type ?? 'protocol'
        if (error instanceof MemoStorageError) attempt.error_code = error.code
        const retry = !signal?.aborted && retryable && request_attempt <= maxRetries
        attempt.retry_delay_ms = retry ? retryDelay(request_attempt, retryAfter) : null
        attempt.completed_at = new Date().toISOString()
        attempt.duration_ms = Math.round(performance.now() - started)
        await onAttempt?.(attempt)
        signal?.throwIfAborted()
        if (!retry) throw error
        await waitBeforeRetry(attempt.retry_delay_ms!, signal)
        continue
      }
      attempt.completed_at = new Date().toISOString()
      attempt.duration_ms = Math.round(performance.now() - started)
      await onAttempt?.(attempt)
      break
    }
  }
  return vectors
}
