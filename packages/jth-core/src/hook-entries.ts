// New codex hook entry points for jth-core
// These are the actual shell commands called by Codex hooks

import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

function out(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n') }
function err(msg: string) { process.stderr.write(msg + '\n'); process.exitCode = 1 }

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  } catch {
    // bun throws Premature close when the pipe ends — ignore, use what we have
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

// jth memo core cue  — called by UserPromptSubmit + SessionStart hooks
export async function memoCueMain(args: string[], hookInput?: unknown) {
  const { values } = parseArgs({ args, allowPositionals: false, options: { workspace: { type: 'string' } } })
  const root = resolve(values.workspace ?? process.cwd())
  const input = hookInput === undefined ? await readStdin() : hookInput ?? {}
  const { handleCueHook } = await import('./flow/hooks.ts')
  const result = await handleCueHook(input, { workspaceRoot: root })
  out(result)
}

// jth memo core declare  — called by Stop hook
export async function memoDeclareMain(args: string[], hookInput?: unknown) {
  const { values } = parseArgs({ args, allowPositionals: false, options: { workspace: { type: 'string' } } })
  const root = resolve(values.workspace ?? process.cwd())
  const input = (hookInput === undefined ? await readStdin() : hookInput) as { last_assistant_message?: string | null } | null
  const { handleStopHook } = await import('./flow/hooks.ts')
  const result = await handleStopHook(input ?? {}, { workspaceRoot: root, replyText: input?.last_assistant_message ?? undefined })
  if (result._jth?.status === 'error') return err('JTH Stop Hook could not persist the memory declaration')
  out({ continue: result.continue, decision: result.decision, reason: result.reason })
}

// jth flow core entry  — called by UserPromptSubmit hook (flow reminder injection)
export async function flowEntryMain(args: string[]) {
  const { values } = parseArgs({ args, allowPositionals: false, options: { workspace: { type: 'string' } } })
  const root = resolve(values.workspace ?? process.cwd())
  const { loadWorkflowState } = await import('./harness/application/activation.ts')
  const state = await loadWorkflowState(root)
  if (!state?.currentActivation || state.currentActivation.stageId === 'completed') {
    out({})
    return
  }
  const context = [
    `# JTH Flow 当前状态`,
    `Capability: ${state.currentActivation.capabilityId}`,
    `Stage: ${state.currentActivation.stageId}`,
    `Objective: ${state.currentCommand?.objective ?? ''}`,
    `Expected evidence: ${JSON.stringify(state.currentCommand?.expectedEvidence ?? [])}`,
    `Use \`jth harness status\` for full details. Submit evidence with \`jth harness submit --kind <kind>\`.`,
  ].join('\n')
  out({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  })
}
