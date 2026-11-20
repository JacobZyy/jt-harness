// Autopilot — mirrors AIOS memo flow/autopilot.mjs
// Handles writing a memory from a declaration block after a turn

import { appendMemoEvent } from '../../storage/events/events-write.ts'
import { appendToPinned } from '../../storage/govern/pinned.ts'
import { parseMemoryDeclaration, stripMemoryDeclaration } from './protocol.ts'
import { recordFeedback } from '../../storage/views/query.ts'

export interface AutopilotOptions {
  workspaceRoot: string
  space?: string
  scope?: 'project_shared' | 'agent_private'
  sessionId?: string
}

export interface AutopilotResult {
  status: 'recorded' | 'skipped' | 'no_declaration'
  reason?: string
  eventId?: string
}

/** Called after a turn reply is received. Parses the declaration block and persists if verified. */
export async function processAutoMemory(
  reply: string,
  options: AutopilotOptions,
): Promise<AutopilotResult> {
  const decl = parseMemoryDeclaration(reply)
  if (!decl.found) return { status: 'no_declaration', reason: 'no declaration block' }
  if (!decl.verified) return { status: 'skipped', reason: 'verified=no or not declared' }
  if (!decl.conclusion) return { status: 'skipped', reason: 'no conclusion' }

  const text = stripMemoryDeclaration(reply)
  const excerpt = decl.conclusion

  const { workspaceRoot, space = 'default', scope = 'project_shared', sessionId } = options
  const event = await appendMemoEvent({
    workspaceRoot,
    space,
    scope,
    text: excerpt,
    role: 'agent',
    refs: sessionId ? [`session:${sessionId}`] : [],
  })

  // Record useful marks from declaration
  if (decl.useful.length > 0 && sessionId) {
    await recordFeedback(workspaceRoot, decl.useful, 'useful', { sessionId })
      .catch(() => undefined)
  }

  return { status: 'recorded', eventId: event.eventId }
}

/** Called at a milestone to write a checkpoint (pinned memory). */
export async function recordCheckpoint(
  workspaceRoot: string,
  takeaway: string,
  space = 'default',
): Promise<{ truncated: boolean }> {
  // Also append to events log
  await appendMemoEvent({
    workspaceRoot, space, scope: 'project_shared',
    text: takeaway, role: 'agent', refs: ['checkpoint'],
  })
  return appendToPinned({ workspaceRoot, space, text: takeaway })
}
