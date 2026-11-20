import { readAllMemoEvents } from '../events/events-read.ts'
import type { MemoEvent } from '../events/events-write.ts'
import { tokenizeForMatch, scoreText } from './tokenize.ts'
import { readTextIfExists, appendLine } from '../base/io.ts'
import { ensureMemoRoot, recallFeedbackPath } from '../base/fs.ts'

// ── Feedback (impression / useful) ───────────────────────────────────────────

interface FeedbackRow { eventId: string; signal: 'impression' | 'useful' }
interface FeedbackScores { impressions: number; useful: number }

export async function readFeedbackScores(workspaceRoot: string): Promise<Map<string, FeedbackScores>> {
  const path = recallFeedbackPath(workspaceRoot)
  const text = await readTextIfExists(path)
  const scores = new Map<string, FeedbackScores>()
  if (!text.trim()) return scores
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line) as FeedbackRow
      if (!row.eventId || !['impression', 'useful'].includes(row.signal)) continue
      const entry = scores.get(row.eventId) ?? { impressions: 0, useful: 0 }
      if (row.signal === 'useful') entry.useful++
      else entry.impressions++
      scores.set(row.eventId, entry)
    } catch { /* skip malformed */ }
  }
  return scores
}

export async function recordFeedback(workspaceRoot: string, eventIds: string[], signal: 'impression' | 'useful', meta: { query?: string; sessionId?: string } = {}): Promise<void> {
  if (eventIds.length === 0) return
  await ensureMemoRoot(workspaceRoot)
  const path = recallFeedbackPath(workspaceRoot)
  for (const eventId of eventIds) {
    await appendLine(path, JSON.stringify({
      schemaVersion: 1,
      kind: 'jth.memo-recall-feedback',
      at: new Date().toISOString(),
      signal,
      eventId,
      query: meta.query ?? '',
      sessionId: meta.sessionId ?? '',
    }))
  }
}

// AIOS feedback boost: useful marks add trust, stale impressions decay
function applyFeedbackBoost(base: number, fb: FeedbackScores | undefined): number {
  if (!fb) return base
  let score = base
  if (fb.useful > 0) score += Math.min(fb.useful * 1.5, 4.5)
  if (fb.impressions >= 5 && fb.useful === 0) score *= 0.6
  return score
}

// ── Temporal filtering ────────────────────────────────────────────────────────

function isSuperseded(event: MemoEvent, allEvents: MemoEvent[]): boolean {
  return allEvents.some(e => e.supersedes.includes(event.eventId))
}

function filterActive(events: MemoEvent[]): MemoEvent[] {
  return events.filter(e => !isSuperseded(e, events))
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  event: MemoEvent
  score: number
  matched: string[]
  phraseMatch: boolean
  feedback?: FeedbackScores
}

export interface SearchOptions {
  space?: string
  query?: string
  limit?: number
  scope?: string
  includeSuperseded?: boolean
  maxCharsPerMemory?: number
  maxTotalChars?: number
  workspaceRoot: string
}

export async function searchMemoEvents(opts: SearchOptions): Promise<SearchResult[]> {
  const { workspaceRoot, query = '', limit = 20, space, scope, includeSuperseded = false, maxCharsPerMemory = Infinity, maxTotalChars = Infinity } = opts
  let events = await readAllMemoEvents(workspaceRoot)
  if (!includeSuperseded) events = filterActive(events)
  if (space) events = events.filter(e => e.space === space)
  if (scope) events = events.filter(e => e.scope === scope)

  const feedbackScores = await readFeedbackScores(workspaceRoot)
  const phrase = query.toLowerCase().trim()
  const queryTokens = tokenizeForMatch(query)

  let results: SearchResult[] = []

  if (!phrase) {
    // No query: return recent events sorted by ts desc
    results = events.map(event => ({ event, score: 0, matched: [], phraseMatch: false }))
      .sort((a, b) => b.event.ts.localeCompare(a.event.ts))
  } else {
    for (const event of events) {
      const haystack = [event.text, ...event.entities].join('\n')
      const { score, matched, phraseMatch } = scoreText(haystack, queryTokens, phrase)
      if (score <= 0 && !phraseMatch) continue
      const fb = feedbackScores.get(event.eventId)
      const boosted = applyFeedbackBoost(score, fb)
      results.push({ event, score: boosted, matched, phraseMatch, feedback: fb })
    }
    results.sort((a, b) => b.score - a.score || b.event.ts.localeCompare(a.event.ts))
  }

  // Apply char budgets
  const limited: SearchResult[] = []
  let totalChars = 0
  for (const r of results.slice(0, limit)) {
    const chars = r.event.text.length
    if (chars > maxCharsPerMemory) continue
    if (totalChars + chars > maxTotalChars) break
    limited.push(r)
    totalChars += chars
  }
  return limited
}

export async function listMemoEvents(opts: Omit<SearchOptions, 'query'>): Promise<MemoEvent[]> {
  const results = await searchMemoEvents({ ...opts, query: '' })
  return results.map(r => r.event)
}
