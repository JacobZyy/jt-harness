import { readTextIfExists, readJsonlSync } from '../base/io.ts'
import { fileEventsPath } from '../base/fs.ts'
import type { MemoEvent } from './events-write.ts'
import { memoEventSchema } from './events-write.ts'

export async function readAllMemoEvents(workspaceRoot: string): Promise<MemoEvent[]> {
  const path = fileEventsPath(workspaceRoot)
  const text = await readTextIfExists(path)
  if (!text.trim()) return []
  return readJsonlSync(text)
    .filter((x): x is Record<string, unknown> =>
      typeof x === 'object' && x !== null && (x as Record<string, unknown>).kind === 'memo')
    .map(raw => { try { return memoEventSchema.parse(raw) } catch { return null } })
    .filter((x): x is MemoEvent => x !== null)
}

export async function readMemoEventsForSpace(
  workspaceRoot: string,
  space: string,
): Promise<MemoEvent[]> {
  const all = await readAllMemoEvents(workspaceRoot)
  return all.filter(e => e.space === space)
}
