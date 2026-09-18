import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { agentExtractionSchema, parseExtraction, submissionSchema } from '../contracts.ts'
import type { MemoryAgentOptions, Submission } from '../contracts.ts'
import { assertAgentRun, runValidatedMemoryAgent } from './runtime.ts'
import type { AgentContext } from './runtime.ts'
import type { AgentOutput } from './runtime.ts'
import { inspectExtraction } from '../intake.ts'
import type { IntakeIssue } from '../intake.ts'

export type ExtractionResult = Awaited<ReturnType<typeof extractionResult>> & { issues?: IntakeIssue[] }
function extractionResult(submission: Submission, extraction: ReturnType<typeof parseExtraction>, run: AgentOutput['run']) {
  return { status: 'extracted' as const, submission_id: submission.submission_id, source: submission.source, scope: submission.scope, run, ...extraction }
}

export function finishExtraction(run: RunResult, submission: Submission) {
  assertAgentRun(run)
  return parseExtraction(run.finalResponse, submission)
}

/** Extract source-only candidates. Reconciliation and publication belong to the worker. */
export async function extractMemories(input: unknown, runtime: MemoryAgentOptions, context: AgentContext = {}): Promise<ExtractionResult> {
  const submission = submissionSchema.parse(input)
  const result = await runValidatedMemoryAgent(submission, runtime, new URL('./agent.md', import.meta.url), agentExtractionSchema,
    response => inspectExtraction(response, submission), context)
  return { ...extractionResult(submission, result.value.extraction, result.run), issues: result.value.issues }
}
