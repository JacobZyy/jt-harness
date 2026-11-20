import { readFile, appendFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function readTextIfExists(filePath: string): Promise<string> {
  try { return await readFile(filePath, 'utf8') }
  catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw e
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/**
 * Creates a directory for project-local state. A new one ignores itself: hooks and agents write this
 * state in whatever project Codex runs in, and it must not reach that project's commits. An existing
 * directory is left as its owner arranged it.
 */
export async function ensureStateDir(dir: string): Promise<void> {
  if (existsSync(dir)) return
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined)
}

export async function appendLine(filePath: string, content: string): Promise<void> {
  await ensureDir(dirname(filePath))
  await appendFile(filePath, content.endsWith('\n') ? content : content + '\n', 'utf8')
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await ensureDir(dirname(filePath))
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}

export function readJsonlSync(text: string): unknown[] {
  return text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(x => x !== null)
}
