import { execFileSync } from 'node:child_process'
import { access, lstat, realpath, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FlowSettings } from '../packages/flow/src/contracts.ts'

/** Share local configuration and external source dependencies without replacing local overrides. */
export async function ensureSharedLink(source: string, target: string) {
  const actualSource = await realpath(source)
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    const actualTarget = await realpath(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (actualTarget === actualSource) return
    throw new Error(`保留已有路径，未覆盖：${target}；请先核对它与主工作区的配置是否一致`)
  }
  await symlink(actualSource, target)
}

export async function setupWorktree() {
  const workspace = await realpath(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: workspace, encoding: 'utf8' })
  const primary = await realpath(worktrees.split('\0').find(field => field.startsWith('worktree '))!.slice('worktree '.length))
  const primaryCli = resolve(primary, 'bin/jth.mjs')
  // Reuse the primary installation's scope and config instead of copying workspace-bound runtime files.
  const { settings } = JSON.parse(execFileSync(process.execPath, [primaryCli, 'flow', 'status', '--all', '--workspace', primary], {
    cwd: primary, encoding: 'utf8',
  })) as { settings: FlowSettings }
  const envFile = await realpath(settings.envFile)
  const dsh = resolve(dirname(primary), 'deepseek-harness')
  await access(resolve(dsh, 'package.json'))
  if (workspace !== primary) {
    await ensureSharedLink(envFile, resolve(workspace, '.env'))
    // package.json already uses link:../deepseek-harness; keep that layout in a Codex worktree container.
    await ensureSharedLink(dsh, resolve(dirname(workspace), 'deepseek-harness'))
  }
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: workspace, stdio: 'inherit' })
  execFileSync('pnpm', ['build'], { cwd: workspace, stdio: 'inherit' })
  execFileSync(process.execPath, [resolve(workspace, 'bin/jth.mjs'), 'flow', 'install',
    '--workspace', workspace, '--env-file', envFile,
    ...settings.projectIds.flatMap(id => ['--project', id]),
    ...settings.businessIds.flatMap(id => ['--business', id]),
  ], { cwd: workspace, stdio: 'inherit' })
  return { status: 'configured', workspace, primary, envFile }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupWorktree().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
