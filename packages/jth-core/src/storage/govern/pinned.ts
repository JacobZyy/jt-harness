// Pinned memory — mirrors AIOS workspace-memory pinned.mjs
// Pinned entries are stored as a Markdown block per space and surfaced first on recall.

import { readTextIfExists, atomicWrite } from '../base/io.ts'
import { ensureMemoRoot, filePinnedPath } from '../base/fs.ts'

export async function readPinned(workspaceRoot: string, space = 'default'): Promise<string> {
  const path = filePinnedPath(workspaceRoot, space)
  return readTextIfExists(path)
}

export async function writePinned(workspaceRoot: string, space: string, content: string): Promise<void> {
  await ensureMemoRoot(workspaceRoot)
  await atomicWrite(filePinnedPath(workspaceRoot, space), content)
}

export interface PinnedAppendOptions {
  workspaceRoot: string
  space?: string
  text: string
  maxChars?: number
}

export async function appendToPinned(opts: PinnedAppendOptions): Promise<{ truncated: boolean }> {
  const { workspaceRoot, space = 'default', text, maxChars = 5000 } = opts
  const existing = await readPinned(workspaceRoot, space)
  const prefix = existing.trimEnd()
  const separator = prefix ? '\n\n' : ''
  const appended = `${prefix}${separator}${text.trim()}`
  const truncated = appended.length > maxChars
  const final = truncated ? appended.slice(0, maxChars) : appended
  await writePinned(workspaceRoot, space, final)
  return { truncated }
}
