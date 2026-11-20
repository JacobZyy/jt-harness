// Hook adapters for the new jth-core system
// UserPromptSubmit: inject recall context
// Stop: parse declaration and persist if verified

import { readTextIfExists } from '../storage/base/io.ts'
import { collectTurnRecall, buildRecallContextJson } from '../flow/recall/recall.ts'
import { parseMemoryDeclaration, stripMemoryDeclaration } from '../flow/declaration/protocol.ts'
import { appendMemoEvent } from '../storage/events/events-write.ts'
import { appendToPinned } from '../storage/govern/pinned.ts'
import { recordFeedback } from '../storage/views/query.ts'
import { resolve } from 'node:path'

export interface HookEvent {
  hook_event_name: string
  session_id: string
  cwd: string
  agent_id?: string
  turn_id?: string
  prompt?: string
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext: string
  }
}

export interface MemoHookConfig {
  workspaceRoot: string
  space?: string
  maxHits?: number
  maxTotalChars?: number
}

// ── UserPromptSubmit / SessionStart: inject recall context ────────────────────

export async function handleCueHook(
  input: unknown,
  config: MemoHookConfig,
): Promise<HookOutput> {
  const event = input as HookEvent
  if (!['UserPromptSubmit', 'SessionStart'].includes(event.hook_event_name)) return {}
  if (event.agent_id) return {} // skip subagents

  const { workspaceRoot, space = 'default', maxHits = 6, maxTotalChars = 2000 } = config
  const query = event.prompt?.trim() ?? ''

  const recall = await collectTurnRecall({
    workspaceRoot,
    query,
    space,
    sessionId: event.session_id,
    maxHits,
    maxTotalChars,
  }).catch(() => ({ status: 'empty' as const, hits: [], pinned: '', declarationInstruction: '', totalChars: 0 }))

  const ctx = buildRecallContextJson(recall)
  return {
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: ctx,
    },
  }
}

// ── Stop: capture reply and persist declared memory ───────────────────────────

export interface StopHookResult {
  continue: true
  decision?: 'block'
  reason?: string
  _jth?: {
    status: 'recorded' | 'skipped' | 'no_declaration' | 'error'
    eventId?: string
  }
}

export async function handleStopHook(
  input: unknown,
  config: MemoHookConfig & { replyText?: string },
): Promise<StopHookResult> {
  const event = input as HookEvent
  if (event.hook_event_name !== 'Stop' || event.agent_id) {
    return { continue: true, _jth: { status: 'skipped' } }
  }

  const reply = config.replyText ?? ''
  if (!reply.trim()) return { continue: true, _jth: { status: 'no_declaration' } }

  const decl = parseMemoryDeclaration(reply)
  if (!decl.found) return { continue: true, _jth: { status: 'no_declaration' } }
  if (!decl.verified) return { continue: true, _jth: { status: 'skipped' } }
  if (!decl.conclusion) return { continue: true, _jth: { status: 'skipped' } }

  try {
    const { workspaceRoot, space = 'default' } = config
    const event_ = await appendMemoEvent({
      workspaceRoot,
      space,
      scope: 'project_shared',
      text: decl.conclusion,
      role: 'agent',
      refs: event.session_id ? [`session:${event.session_id}`] : [],
    })

    if (decl.useful.length > 0 && event.session_id) {
      await recordFeedback(workspaceRoot, decl.useful, 'useful', { sessionId: event.session_id })
        .catch(() => undefined)
    }

    return { continue: true, _jth: { status: 'recorded', eventId: event_.eventId } }
  } catch (err) {
    return { continue: true, _jth: { status: 'error' } }
  }
}
