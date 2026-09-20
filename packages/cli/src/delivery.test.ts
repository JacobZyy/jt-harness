import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { installCli, isManagedHook } from './delivery.ts'
import { quote } from '@jt-harness/codex-hooks'
import { readPrimaryInstallation } from '../../../scripts/setup-worktree.ts'

test('trust selection excludes foreign markers, events, commands and ancestor projects', () => {
  const root = '/tool', workspace = '/project'
  const hook = { key: 'fixture', source: 'project', sourcePath: '/project/.codex/hooks.json', eventName: 'userPromptSubmit', currentHash: 'hash',
    statusMessage: 'jth flow entry', command: [process.execPath, '/tool/bin/jth.mjs', 'flow', 'prompt'].map(quote).join(' '), enabled: true, trustStatus: 'untrusted' }
  assert(isManagedHook(hook, root, workspace, false))
  for (const changed of [{ statusMessage: 'jth unknown' }, { eventName: 'preToolUse' }, { sourcePath: '/parent/.codex/hooks.json' },
    { command: `echo ${hook.command}` }, { statusMessage: 'jth monitor' }]) assert.equal(isManagedHook({ ...hook, ...changed }, root, workspace, false), false)
})

test('versioned CLI install/upgrade preserves credentials and refuses an unrelated binary', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-delivery-')))
  const prefix = resolve(root, 'prefix'), envFile = resolve(root, 'original.env')
  try {
    await writeFile(envFile, 'EMBEDDING_API_KEY=keep-private\nJTH_DATA_DIR=state\n')
    for (const build of ['first-build', 'second-build']) {
      const source = resolve(root, build)
      await mkdir(resolve(source, 'bin'), { recursive: true })
      await writeFile(resolve(source, 'bin/jth.mjs'), '#!/usr/bin/env node\nconsole.log("fixture CLI")\n')
      await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'jt-harness', version: '0.1.0', jthDistribution: { build } }))
      const installed = await installCli(source, prefix, envFile)
      assert.equal(await realpath(installed.binary), resolve(installed.root, 'bin/jth.mjs'))
      assert.equal(await realpath(resolve(installed.root, '.env')), envFile)
      assert((await readFile(installed.envFile, 'utf8')).includes('keep-private'))
    }
    assert.equal(await readFile(envFile, 'utf8'), 'EMBEDDING_API_KEY=keep-private\nJTH_DATA_DIR=state\n')
    const before = await readFile(resolve(prefix, 'share/jth/.env'), 'utf8')
    const replacement = resolve(root, 'replacement.env')
    await writeFile(replacement, 'EMBEDDING_API_KEY=do-not-replace\n')
    await installCli(resolve(root, 'second-build'), prefix, replacement)
    assert.equal(await readFile(resolve(prefix, 'share/jth/.env'), 'utf8'), before)
    await mkdir(resolve(root, 'unrelated/bin'), { recursive: true })
    await writeFile(resolve(root, 'unrelated/bin/jth'), 'another tool')
    await assert.rejects(installCli(resolve(root, 'first-build'), resolve(root, 'unrelated'), envFile), /保留已有/)
    assert.equal(await readFile(resolve(root, 'unrelated/bin/jth'), 'utf8'), 'another tool')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('project install and upgrade are idempotent; uninstall preserves data and other hooks', async () => {
  const root = resolve(import.meta.dirname, '../../..'), workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'jth-project-')))
  const execute = promisify(execFile), envFile = resolve(workspace, '.env')
  const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [resolve(root, 'bin/jth.mjs'), ...args, '--workspace', workspace], { cwd: workspace })).stdout)
  try {
    await mkdir(resolve(workspace, '.codex'), { recursive: true })
    await writeFile(resolve(workspace, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-other-tool' }] }] } }))
    await writeFile(envFile, `JTH_DATA_DIR=${workspace}/data\nJTH_DATABASE_URL=postgresql://127.0.0.1:1/test\n`)
    await cli('install', '--project', 'fixture', '--env-file', envFile)
    await mkdir(resolve(workspace, 'bin'))
    await symlink(resolve(root, 'bin/jth.mjs'), resolve(workspace, 'bin/jth.mjs'))
    assert.deepEqual(await readPrimaryInstallation(workspace), { envFile, projectIds: ['fixture'], businessIds: [] })
    const first = await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')
    await cli('upgrade')
    assert.equal(await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8'), first)
    await writeFile(resolve(workspace, '.jth/keep-data'), 'keep')
    await cli('uninstall')
    assert.equal(await readFile(resolve(workspace, '.jth/keep-data'), 'utf8'), 'keep')
    assert((await readFile(resolve(workspace, '.codex/hooks.json'), 'utf8')).includes('keep-other-tool'))
    await assert.rejects(readlink(resolve(workspace, '.agents/skills/jth-flow')), { code: 'ENOENT' })
    assert((await readFile(envFile, 'utf8')).includes('JTH_DATABASE_URL'))
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
