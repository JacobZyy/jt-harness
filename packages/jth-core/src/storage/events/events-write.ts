import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fileEventsPath, withMemoLock } from '../base/fs.ts'
import { appendLine, readTextIfExists, readJsonlSync } from '../base/io.ts'

// ── Schema ────────────────────────────────────────────────────────────────────

export const memoScopeSchema = z.enum(['project_shared', 'agent_private', 'session'])
export type MemoScope = z.infer<typeof memoScopeSchema>

export const memoEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  space: z.string().default('default'),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  validAt: z.string(),
  kind: z.literal('memo'),
  role: z.enum(['user', 'assistant', 'agent']).default('agent'),
  scope: memoScopeSchema.default('project_shared'),
  text: z.string().min(1),
  refs: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', '']).default(''),
  evidenceRef: z.string().default(''),
  date: z.string().default(''),
  supersedes: z.array(z.string()).default([]),
  claimStatus: z.enum(['candidate', 'verified']).default('candidate'),
})
export type MemoEvent = z.infer<typeof memoEventSchema>

export interface AppendMemoOptions {
  workspaceRoot: string
  space?: string
  text: string
  scope?: MemoScope
  entities?: string[]
  confidence?: 'high' | 'medium' | ''
  evidenceRef?: string
  date?: string
  refs?: string[]
  supersedes?: string[]
  role?: 'user' | 'assistant' | 'agent'
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function readAllEvents(workspaceRoot: string): Promise<MemoEvent[]> {
  const path = fileEventsPath(workspaceRoot)
  const text = await readTextIfExists(path)
  if (!text.trim()) return []
  return readJsonlSync(text)
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && (x as Record<string, unknown>).kind === 'memo')
    .map(raw => { try { return memoEventSchema.parse(raw) } catch { return null } })
    .filter((x): x is MemoEvent => x !== null)
}

async function nextSeq(workspaceRoot: string): Promise<number> {
  const events = await readAllEvents(workspaceRoot)
  return events.reduce((max, e) => Math.max(max, e.seq), 0) + 1
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function appendMemoEvent(opts: AppendMemoOptions): Promise<MemoEvent> {
  const { workspaceRoot, text, space = 'default', scope = 'project_shared',
    entities = [], confidence = '', evidenceRef = '', date = '',
    refs = [], supersedes = [], role = 'agent' } = opts

  return withMemoLock(workspaceRoot, async () => {
    const seq = await nextSeq(workspaceRoot)
    const ts = new Date().toISOString()
    const event: MemoEvent = memoEventSchema.parse({
      schemaVersion: 1,
      eventId: `memo:${space}:${ts.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`,
      space, seq, ts, validAt: date || ts, kind: 'memo', role, scope,
      text: text.trim(), refs, entities, confidence, evidenceRef, date, supersedes,
      claimStatus: 'candidate',
    })
    await appendLine(fileEventsPath(workspaceRoot), JSON.stringify(event))
    return event
  })
}
