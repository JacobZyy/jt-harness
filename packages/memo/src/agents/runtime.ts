import { mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { z } from 'zod'
import { optionsSchema } from '../contracts.ts'
import type { MemoryAgentOptions } from '../contracts.ts'
import type { AgentRun } from '../storage/contract.ts'

export function assertAgentRun(run: RunResult) {
  const turnEnd = run.events.findLast(event => event.type === 'turn/end')
  if (turnEnd?.data.reason.kind !== 'completed') {
    throw new Error(`DSH 未完成提炼：${JSON.stringify(turnEnd?.data.reason ?? 'missing turn/end')}`)
  }
  if (run.events.some(event => event.type === 'tool/call')) {
    throw new Error('提炼会话调用了工具；请检查 sdk-minimal profile 是否添加了额外插件')
  }
  if (run.events.some(event => event.type === 'request/header' && event.data.header.tools?.length)) {
    throw new Error('提炼请求暴露了额外工具；请检查 sdk-minimal profile 配置')
  }
}

export interface AgentOutput { response: string, run: AgentRun }
export interface AgentContext {
  workspace?: string
  sourceBytes?: number
  signal?: AbortSignal
  onOutput?: (output: AgentOutput) => Promise<void>
  onInvalidOutput?: (output: AgentOutput, error: string) => Promise<void>
}

/** DSH inputTokens excludes cache reads/writes. Missing usage is not a zero-cost request. */
export function agentUsage(run: RunResult): AgentRun['usage'] {
  const usages = run.events.flatMap(event => event.type === 'assistant/message' && event.data.usage ? [event.data.usage] : [])
  if (!usages.length) return undefined
  return usages.reduce((sum, usage) => ({
    input_tokens: sum.input_tokens + usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    cache_hit_tokens: sum.cache_hit_tokens + (usage.cacheReadTokens ?? 0),
    output_tokens: sum.output_tokens + usage.outputTokens, requests: sum.requests + 1,
  }), { input_tokens: 0, cache_hit_tokens: 0, output_tokens: 0, requests: 0 })
}

/** A stopped generation may still contain useful text. Keep it before rejecting the run. */
export async function checkAgentCompletion(run: RunResult, output: AgentOutput, context: AgentContext) {
  try { assertAgentRun(run) } catch (error) {
    await context.onOutput?.(output)
    await context.onInvalidOutput?.(output, error instanceof Error ? error.message : 'DSH 未完成')
    throw error
  }
}

/** Retry an unreadable response once; per-item diagnostics are normal results, not whole-run failures. */
export async function runValidatedMemoryAgent<T>(input: object, runtime: MemoryAgentOptions, prompt: URL, schema: z.ZodType,
  validate: (response: string) => T, context: AgentContext = {}, run = runMemoryAgent) {
  const options = optionsSchema.parse(runtime)
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(context.signal ? [context.signal] : [])])
  let material = input
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run(material, options, prompt, schema, { ...context, signal })
    await context.onOutput?.(result)
    try { return { value: validate(result.response), run: result.run } } catch (error) {
      await context.onInvalidOutput?.(result, error instanceof Error ? error.message : '输出格式错误')
      if (attempt === 1) throw error
      material = { ...input, validation_feedback: { error: error instanceof Error ? error.message : '输出格式错误', previous_output: result.response } }
    }
  }
  throw new Error('记忆输出未通过校验')
}

/** Both memory stages share the same tool-free DSH process lifecycle. */
export async function runMemoryAgent(input: unknown, runtime: MemoryAgentOptions, prompt: URL, schema: z.ZodType, context: AgentContext = {}): Promise<AgentOutput> {
  context.signal?.throwIfAborted()
  const options = optionsSchema.parse(runtime)
  const instructions = await readFile(prompt, 'utf8')
  const systemPrompt = `${instructions}\n${JSON.stringify(z.toJSONSchema(schema))}`
  const material = JSON.stringify(input)
  const workspace = context.workspace ?? fileURLToPath(new URL('../../../../artifacts/memory-agent/workspace/', import.meta.url))
  await mkdir(workspace, { recursive: true })
  const harness = new DeepSeekHarness({
    profile: 'sdk-minimal',
    patches: [fileURLToPath(new URL('./agent.cordis.patch.yml', import.meta.url))],
    cwd: workspace,
    processCwd: workspace,
    provider: options.provider,
    model: options.model,
    dshBin: options.dshBin,
    dshHome: options.dshHome,
    env: {
      ...process.env,
      EMBEDDING_API_KEY: '',
      JTH_DATABASE_URL: '',
      PGPASSWORD: '',
      DSH_SYSTEM_PROMPT: systemPrompt,
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const sessionId = `session-${randomUUID().replaceAll('-', '')}`
  try {
    const run = await Promise.race([
      harness.run(material, { sessionId }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DSH 提炼超过 ${options.timeoutMs}ms，已请求关闭本次运行`)), options.timeoutMs)
        abort = () => reject(context.signal?.reason ?? new Error('记忆任务已中断'))
        context.signal?.addEventListener('abort', abort, { once: true })
        if (context.signal?.aborted) abort()
      }),
    ])
    const output = {
      response: run.finalResponse,
      run: { session_id: run.sessionId, provider: options.provider, model: options.model, usage: agentUsage(run),
        input_bytes: Buffer.byteLength(material), system_prompt_bytes: Buffer.byteLength(systemPrompt), source_bytes: context.sourceBytes },
    }
    await checkAgentCompletion(run, output, context)
    return output
  } catch (error) {
    throw new Error(`DSH session=${sessionId}: ${error instanceof Error ? error.message : '运行失败'}`, { cause: error })
  } finally {
    clearTimeout(timer)
    if (abort) context.signal?.removeEventListener('abort', abort)
    await harness.close()
  }
}
