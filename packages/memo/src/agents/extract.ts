import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { agentExtractionSchema, parseExtraction, submissionSchema } from '../contracts.ts'
import type { MemoryAgentOptions, Submission } from '../contracts.ts'
import { assertAgentRun, runValidatedMemoryAgent } from './runtime.ts'
import type { AgentContext } from './runtime.ts'

export function finishExtraction(run: RunResult, submission: Submission) {
  assertAgentRun(run)
  return parseExtraction(run.finalResponse, submission)
}

/** Extract source-only candidates. Reconciliation and publication belong to the worker. */
export async function extractMemories(input: unknown, runtime: MemoryAgentOptions, context: AgentContext = {}) {
  const submission = submissionSchema.parse(input)
  const result = await runValidatedMemoryAgent(submission, runtime, new URL('./agent.md', import.meta.url), agentExtractionSchema, response => {
    agentExtractionSchema.parse(JSON.parse(response))
    return parseExtraction(response, submission)
  }, context)
  return {
    status: 'extracted' as const, submission_id: submission.submission_id, source: submission.source, scope: submission.scope,
    run: result.run, ...result.value,
  }
}
