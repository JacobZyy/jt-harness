import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ensureStateDir } from './io.ts'
import {
  MEMO_STORAGE_DIR,
  FILE_EVENTS_SEGMENTS,
  MEMO_LOCK_FILENAME,
  MEMO_LOCK_TIMEOUT_CODE,
} from './constants.ts'

// ── Path helpers ──────────────────────────────────────────────────────────────

export function memoRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot || process.cwd(), MEMO_STORAGE_DIR)
}

export function fileEventsPath(workspaceRoot: string): string {
  return join(memoRoot(workspaceRoot), ...FILE_EVENTS_SEGMENTS)
}

export function filePinnedPath(workspaceRoot: string, space = 'default'): string {
  return join(memoRoot(workspaceRoot), 'file', 'pinned', `${space}.md`)
}

export function recallFeedbackPath(workspaceRoot: string): string {
  return join(memoRoot(workspaceRoot), 'telemetry', 'memo-recall-feedback.jsonl')
}

export function lockPath(workspaceRoot: string): string {
  return join(memoRoot(workspaceRoot), '.locks', MEMO_LOCK_FILENAME)
}

/** Every write goes through here first, so a memo root created by a hook ignores itself. */
export async function ensureMemoRoot(workspaceRoot: string): Promise<string> {
  const root = memoRoot(workspaceRoot)
  await ensureStateDir(root)
  return root
}

// ── File lock (mirror AIOS memo storage lock) ─────────────────────────────────

interface LockRecord { pid: number; at: string; nonce: string }

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (e: unknown) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function tryAcquire(path: string): Promise<string | null> {
  const nonce = randomUUID()
  const record: LockRecord = { pid: process.pid, at: new Date().toISOString(), nonce }
  try {
    // O_EXCL creates atomically and fails if file exists
    const fh = await open(path, 'wx')
    await fh.writeFile(JSON.stringify(record), 'utf8')
    await fh.close()
    return nonce
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      // Check if owner is still alive; steal stale lock
      try {
        const raw = await readFile(path, 'utf8')
        const rec = JSON.parse(raw) as LockRecord
        if (!processIsAlive(rec.pid)) {
          await unlink(path).catch(() => undefined)
          return null // retry
        }
      } catch { /* ignore */ }
    }
    return null
  }
}

export async function withMemoLock<T>(
  workspaceRoot: string,
  fn: () => Promise<T>,
  { timeoutMs = 10000, pollMs = 50 } = {},
): Promise<T> {
  const path = lockPath(workspaceRoot)
  await ensureMemoRoot(workspaceRoot)
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let nonce: string | null = null
  while (Date.now() < deadline) {
    nonce = await tryAcquire(path)
    if (nonce !== null) break
    await new Promise(r => setTimeout(r, pollMs))
  }
  if (nonce === null) {
    const err = new Error(`jth memo lock timed out after ${timeoutMs}ms: ${path}`)
    ;(err as NodeJS.ErrnoException).code = MEMO_LOCK_TIMEOUT_CODE
    throw err
  }
  try { return await fn() }
  finally {
    try { await unlink(path) } catch { /* already gone */ }
  }
}
