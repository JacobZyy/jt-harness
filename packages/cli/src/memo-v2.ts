// `jth memo core add|search|recall|useful|checkpoint|read|list|pinned`. The memo belongs to the caller's working directory.

import { appendMemoEvent } from '../../jth-core/src/storage/events/events-write.ts'
import { searchMemoEvents, listMemoEvents, recordFeedback } from '../../jth-core/src/storage/views/query.ts'
import { readAllMemoEvents } from '../../jth-core/src/storage/events/events-read.ts'
import { appendToPinned, readPinned } from '../../jth-core/src/storage/govern/pinned.ts'
import { collectTurnRecall, buildRecallContextJson } from '../../jth-core/src/flow/recall/recall.ts'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

function out(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function err(message: string) {
  process.stderr.write(JSON.stringify({ error: message }) + '\n')
  process.exitCode = 1
}

export async function memoMain(args: string[], workspaceRoot?: string) {
  const root = workspaceRoot ?? resolve(process.cwd())
  const [cmd, ...rest] = args

  switch (cmd) {
    case 'add': {
      if (rest.length === 0) { err('usage: jth memo core add "<fact>" [--supersedes <eventId>] [--space <space>]'); return }
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: {
          supersedes: { type: 'string' },
          space: { type: 'string' },
          scope: { type: 'string' },
          entities: { type: 'string' },
          date: { type: 'string' },
          evidence: { type: 'string' },
          confidence: { type: 'string' },
        },
      })
      const text = positionals[0]
      if (!text) { err('fact text is required'); return }
      const event = await appendMemoEvent({
        workspaceRoot: root,
        text,
        space: values.space ?? 'default',
        scope: (values.scope ?? 'project_shared') as 'project_shared' | 'agent_private',
        entities: values.entities ? values.entities.split(',').map(s => s.trim()).filter(Boolean) : [],
        date: values.date ?? '',
        evidenceRef: values.evidence ?? '',
        confidence: (values.confidence ?? '') as 'high' | 'medium' | '',
        supersedes: values.supersedes ? [values.supersedes] : [],
      })
      out({ status: 'recorded', eventId: event.eventId, space: event.space })
      break
    }

    case 'search': {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { limit: { type: 'string' }, space: { type: 'string' } },
      })
      const query = positionals[0] ?? ''
      const results = await searchMemoEvents({
        workspaceRoot: root,
        query,
        space: values.space,
        limit: values.limit ? parseInt(values.limit) : 20,
      })
      out(results.map(r => ({ eventId: r.event.eventId, text: r.event.text, score: r.score, space: r.event.space, entities: r.event.entities })))
      break
    }

    case 'recall': {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { limit: { type: 'string' }, space: { type: 'string' } },
      })
      const query = positionals[0] ?? ''
      const recall = await collectTurnRecall({
        workspaceRoot: root,
        query,
        space: values.space ?? 'default',
        maxHits: values.limit ? parseInt(values.limit) : 6,
      })
      out({
        status: recall.status,
        hits: recall.hits.map(h => ({ eventId: h.eventId, excerpt: h.excerpt, entities: h.entities })),
        pinned: recall.pinned || undefined,
        totalChars: recall.totalChars,
      })
      break
    }

    case 'useful': {
      if (!rest[0]) { err('usage: jth memo core useful <eventId>[,eventId2]'); return }
      const ids = rest[0].split(',').map(s => s.trim()).filter(Boolean)
      await recordFeedback(root, ids, 'useful')
      out({ status: 'recorded', eventIds: ids })
      break
    }

    case 'checkpoint': {
      if (!rest[0]) { err('usage: jth memo core checkpoint "<one-line takeaway>" [--space <space>]'); return }
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { space: { type: 'string' } },
      })
      const text = positionals[0]
      if (!text) { err('takeaway text is required'); return }
      const result = await appendToPinned({ workspaceRoot: root, space: values.space ?? 'default', text })
      out({ status: 'checkpointed', truncated: result.truncated })
      break
    }

    case 'read': {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { level: { type: 'string' } },
      })
      const eventId = positionals[0]
      if (!eventId) { err('usage: jth memo core read <eventId>'); return }
      const all = await readAllMemoEvents(root)
      const found = all.find(e => e.eventId === eventId)
      if (!found) { err(`event not found: ${eventId}`); return }
      out(found)
      break
    }

    case 'list': {
      const { values } = parseArgs({ args: rest, allowPositionals: false, options: { space: { type: 'string' }, limit: { type: 'string' } } })
      const events = await listMemoEvents({ workspaceRoot: root, space: values.space, limit: values.limit ? parseInt(values.limit) : 20 })
      out(events.map(e => ({ eventId: e.eventId, text: e.text.slice(0, 140), space: e.space, ts: e.ts })))
      break
    }

    case 'pinned': {
      const { values } = parseArgs({ args: rest, allowPositionals: false, options: { space: { type: 'string' } } })
      const pinned = await readPinned(root, values.space ?? 'default')
      out({ space: values.space ?? 'default', pinned })
      break
    }

    default:
      err(`unknown memo command: ${cmd ?? '(none)'}. try: add|search|recall|useful|checkpoint|read|list|pinned`)
  }
}
