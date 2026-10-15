import assert from 'node:assert/strict'
import { test } from 'node:test'
import filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { canonicalFilePath } from './source-path.ts'
import { inside } from './capture.ts'

test('regular hard links retain their own path despite Bun inode aliases; symlink escapes still resolve outside', async () => {
  const directory = await filesystem.realpath(await filesystem.mkdtemp(resolve(tmpdir(), 'jth-source-path-')))
  const source = resolve(directory, 'native.jsonl'), collection = resolve(directory, 'sources'), retained = resolve(collection, 'retained.jsonl')
  const originalRealpath = filesystem.realpath, nativeRealpath = filesystem.realpath.bind(filesystem)
  let leafCalls = 0
  try {
    await filesystem.mkdir(collection)
    await filesystem.writeFile(source, 'immutable source\n')
    await filesystem.link(source, retained)
    await filesystem.symlink(source, resolve(collection, 'outside.jsonl'))
    filesystem.realpath = (async (path: Parameters<typeof filesystem.realpath>[0]) => {
      if (String(path) === retained) { leafCalls++; return source }
      return nativeRealpath(path)
    }) as typeof filesystem.realpath
    assert.equal(await canonicalFilePath(retained), retained)
    assert.equal(leafCalls, 0, 'A regular hard-link leaf must not use the inode-aliasing realpath operation')
    assert.equal(inside(collection, await canonicalFilePath(retained)), true)
    assert.equal(inside(collection, await canonicalFilePath(resolve(collection, 'outside.jsonl'))), false)
    await filesystem.writeFile(source, 'changed source\n')
    assert.equal(await filesystem.readFile(retained, 'utf8'), 'changed source\n')
  } finally { filesystem.realpath = originalRealpath; await filesystem.rm(directory, { recursive: true, force: true }) }
})
