import filesystem from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

/** Bun on macOS can resolve a regular hard-link leaf to another name for its inode. */
export async function canonicalFilePath(path: string) {
  const canonical = resolve(await filesystem.realpath(dirname(path)), basename(path))
  return (await filesystem.lstat(canonical)).isSymbolicLink() ? filesystem.realpath(canonical) : canonical
}
