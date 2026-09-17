import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { executionProfile, loadConfig, safeError } from './config.ts'

test('.env uses explicit paths and environment overrides; durable profile excludes credentials', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'jth-config-'))
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  try {
    const envFile = resolve(directory, '.env')
    await writeFile(envFile, 'EMBEDDING_API_KEY="private-placeholder"\nEMBEDDING_BASE_URL=https://example.invalid/v1\nEMBEDDING_MODEL=test\nJTH_DATABASE_URL=postgresql://u:secret@localhost/db\n', { mode: 0o600 })
    const config = await loadConfig(root, envFile, { EMBEDDING_MODEL: 'override', JTH_DATA_DIR: './data', JTH_DSH_BIN: './dsh.js' })
    assert.equal(config.embedding.space?.model, 'override')
    assert.equal(config.embedding.space?.dimensions, 1024)
    assert.equal(config.embedding.apiKey, 'private-placeholder')
    assert.equal(config.dataDir, resolve(directory, 'data'))
    assert.equal(config.agent.reasoningEffort, undefined)
    assert.equal(config.agent.maxTokens, undefined)
    await writeFile(envFile, (await readFile(envFile, 'utf8')) + 'JTH_DSH_REASONING_EFFORT=high\n')
    assert.equal((await loadConfig(root, envFile, {})).agent.reasoningEffort, undefined)
    assert.equal((await loadConfig(root, envFile, { JTH_DSH_REASONING_EFFORT: 'off', JTH_DSH_MAX_TOKENS: '8192' })).agent.maxTokens, undefined)
    assert.equal(config.agent.dshBin, resolve(directory, 'dsh.js'))
    const profile = JSON.stringify(executionProfile(config))
    assert(!profile.includes('private-placeholder'))
    assert(!profile.includes('postgresql:'))
    assert(!safeError(new Error(`Failure ${config.embedding.apiKey} ${config.databaseUrl}`), config).includes('secret'))
    const next = await loadConfig(root, envFile, { EMBEDDING_MODEL: 'other' })
    assert.notEqual(next.embedding.space?.id, config.embedding.space?.id)
    await assert.rejects(loadConfig(root, envFile, { EMBEDDING_BASE_URL: 'https://secret@example.invalid/v1' }))
    const ignore = await readFile(resolve(root, '.gitignore'), 'utf8')
    assert(ignore.split('\n').includes('.env'))
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
    assert(!manifest.files.includes('.env'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
