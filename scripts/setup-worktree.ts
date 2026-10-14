import { execFileSync } from 'node:child_process'
import { access, lstat, realpath, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Share external source dependencies without replacing local overrides. */
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

export async function readPrimaryInstallation(primary: string) {
  const status = JSON.parse(execFileSync('bun', ['--no-env-file', '--', resolve(primary, 'bin/jth.ts'), 'flow', 'status', '--workspace', primary], {
    cwd: primary, encoding: 'utf8',
  })) as { memo_scope: { project_ids: string[], business_ids: string[] }, configuration: { envFile: string } }
  return { envFile: await realpath(status.configuration.envFile), projectIds: status.memo_scope.project_ids, businessIds: status.memo_scope.business_ids }
}

export async function setupWorktree() {
  const workspace = await realpath(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: workspace, encoding: 'utf8' })
  const primary = await realpath(worktrees.split('\0').find(field => field.startsWith('worktree '))!.slice('worktree '.length))
  const dsh = resolve(dirname(primary), 'deepseek-harness')
  await access(resolve(dsh, 'package.json'))
  if (workspace !== primary) await ensureSharedLink(dsh, resolve(dirname(workspace), 'deepseek-harness'))
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: workspace, stdio: 'inherit' })
  return { status: 'configured', workspace, primary, jth: '用户级接入由已安装 Hook 自动生效；worktree 无需 init 或项目文件' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupWorktree().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
