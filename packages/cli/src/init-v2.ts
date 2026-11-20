// `jth init-v2`: prepares the file memo and harness state of one workspace and installs the user-level
// Codex hooks of jth-core. `--remove-hooks` takes those hooks out again.

import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { installCoreHooks, uninstallCoreHooks } from '../../jth-core/src/install/hooks.ts'
import { ensureMemoRoot } from '../../jth-core/src/storage/base/fs.ts'
import { ensureStateDir } from '../../jth-core/src/storage/base/io.ts'

const out = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')

export async function initMain(args: string[], workspaceRoot?: string) {
  const { values } = parseArgs({
    args, allowPositionals: false,
    options: {
      workspace: { type: 'string' },
      'skip-hooks': { type: 'boolean' },
      'remove-hooks': { type: 'boolean' },
    },
  })

  if (values['remove-hooks']) {
    out(await uninstallCoreHooks())
    return
  }

  const root = workspaceRoot ?? resolve(values.workspace ?? process.cwd())
  const memoDir = await ensureMemoRoot(root)
  for (const dir of [join(memoDir, 'file', 'pinned'), join(memoDir, 'telemetry'), join(memoDir, '.locks')]) {
    await mkdir(dir, { recursive: true })
  }
  await ensureStateDir(join(root, '.jth', 'harness'))
  // An existing config is kept.
  await writeFile(join(memoDir, 'config.json'), JSON.stringify({ schemaVersion: 1, active: 'file', createdAt: new Date().toISOString() }, null, 2), { flag: 'wx' })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })

  let hooks: { status: string; hooks_path: string | null; changed?: boolean; error?: string } | null = null
  if (!values['skip-hooks']) {
    hooks = await installCoreHooks().catch((error: Error) => ({ status: 'failed', hooks_path: null, error: error.message }))
  }
  if (hooks?.error) process.exitCode = 1

  out({
    status: hooks?.error ? 'hooks_failed' : 'ready',
    memoRoot: memoDir,
    hooksInstalled: hooks?.status ?? 'skipped',
    hooksPath: hooks?.hooks_path ?? null,
    message: [
      `✓ JTH Core initialized at ${memoDir}`,
      !hooks ? '  Hooks skipped (--skip-hooks)'
        : hooks.error ? `✗ Hooks not installed: ${hooks.error}`
        : hooks.changed ? `✓ Hooks written to ${hooks.hooks_path}; trust them in Codex before they can run`
        : `✓ Hooks already up to date at ${hooks.hooks_path}`,
      ...(hooks && !hooks.error ? ['', 'Next: open a new Codex session. Memory recall is injected on every prompt.'] : []),
    ].join('\n'),
  })
}
