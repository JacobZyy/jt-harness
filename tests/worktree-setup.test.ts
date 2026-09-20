import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSharedLink } from '../scripts/setup-worktree.ts'

test('worktree setup shares live config, is repeatable, and preserves existing overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jth-worktree-links-'))
  const source = join(directory, 'main.env'), target = join(directory, '.env')
  try {
    await writeFile(source, 'setting=first')
    await ensureSharedLink(source, target)
    await ensureSharedLink(source, target)
    assert.equal(await realpath(target), await realpath(source))
    await writeFile(source, 'setting=updated')
    assert.equal(await readFile(target, 'utf8'), 'setting=updated')
    const override = join(directory, 'override.env')
    await writeFile(override, 'keep-local')
    await assert.rejects(ensureSharedLink(source, override), /未覆盖/)
    assert.equal(await readFile(override, 'utf8'), 'keep-local')
    const dangling = join(directory, 'dangling.env')
    await symlink(join(directory, 'missing'), dangling)
    await assert.rejects(ensureSharedLink(source, dangling), /未覆盖/)
    await assert.rejects(ensureSharedLink(join(directory, 'missing'), join(directory, 'new.env')), { code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
