import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { modelEnv, envVersion, saveModel } from './models.ts'
import { loadConfig } from './config.ts'

test('model selection preserves secrets and controls, quotes identifiers and rejects stale edits', async () => {
  const original = '# retain this comment\nEMBEDDING_API_KEY="private-placeholder"\nexport JTH_DSH_PROVIDER=old\nJTH_DSH_MODEL=old\nJTH_DSH_REASONING_EFFORT=off\n'
  const updated = modelEnv(original, 'zz-tokenhub', 'deepseek-flash')
  assert(updated.includes('# retain this comment'))
  assert.equal(parseEnv(updated).EMBEDDING_API_KEY, 'private-placeholder')
  assert.equal(parseEnv(updated).JTH_DSH_PROVIDER, 'zz-tokenhub')
  assert.equal(parseEnv(updated).JTH_DSH_MODEL, 'deepseek-flash')
  assert.equal(parseEnv(updated).JTH_DSH_REASONING_EFFORT, 'off')
  assert.equal(parseEnv(updated).JTH_DSH_MAX_TOKENS, undefined)
  assert.throws(() => modelEnv(original, 'provider\nBAD=1', 'model'))
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-model-config-'))
  try {
    const path = resolve(directory, '.env')
    await writeFile(path, original, { mode: 0o600 })
    const config = await loadConfig(directory, path, {})
    await saveModel(config, 'zz-tokenhub', 'deepseek-flash', envVersion(original))
    assert.equal(await readFile(path, 'utf8'), updated)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    await assert.rejects(saveModel(config, 'other', 'model', envVersion(original)), /已被修改/)
    assert.equal(await readFile(path, 'utf8'), updated)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
