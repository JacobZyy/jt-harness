import { mkdir, mkdtemp, readdir, rename, rmdir, rm, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { codexDirectory, hash, hookEventSchema, sessionWorkspaceContext, userInstallationPath, readJson } from '@jacob-z/jt-harness/codex-hooks'
import { matchesConfigFile, safeError, type Config } from '@jacob-z/jt-harness/memo/config'
import { migrateUserInstallation } from './migration.ts'

const changes = (report: Awaited<ReturnType<typeof migrateUserInstallation>>) => report.projects.some(project =>
  'removed' in project && (project.removed.length || project.handlers.length || project.codex_preferences.removed.length))

/** A session checks its own directories only; no database, queue replay or global reinstall. */
export async function cleanupSessionProjects(root: string, input: unknown, config: Config, codexHome: string) {
  const event = hookEventSchema.parse(input)
  if (event.hook_event_name !== 'SessionStart' || event.agent_id) return {}
  const installation = await readJson(userInstallationPath(config, codexHome)) as { disabled?: boolean, settings?: { env_file: string } } | undefined
  if (installation?.disabled || !installation?.settings) return {}
  if (!matchesConfigFile(config, installation.settings.env_file)) throw new Error('用户级 JTH 配置不匹配；运行 jth init')
  const context = await sessionWorkspaceContext(event, codexHome)
  const messages: string[] = []
  for (const workspace of context.roots) {
    const options = { workspaces: [workspace], cleanupOnly: true, existingOnly: true, preserveLocalPolicy: true }
    try {
      if (!changes(await migrateUserInstallation(root, config, codexHome, { ...options, dryRun: true }))) continue
      const lock = resolve(codexDirectory(config), 'migration-locks', hash(workspace))
      const owner = await acquireCleanupLock(lock, workspace)
      if (!owner) {
        messages.push(`JTH 旧环境清理稍后重试：${workspace} 的目录锁暂不可用，可能正由另一会话处理。`)
        continue
      }
      try {
        if (!changes(await migrateUserInstallation(root, config, codexHome, { ...options, dryRun: true }))) continue
        const report = await migrateUserInstallation(root, config, codexHome, options)
        messages.push(`JTH 已清理旧仓库接入：${workspace}；原文备份：${report.backup_directory}。`)
      } finally {
        await unlink(resolve(lock, owner))
        await rmdir(lock).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error })
      }
    } catch (error) {
      const message = `JTH 旧环境清理未完成：${workspace}；${safeError(error, config)}。可运行 jth migrate --dry-run 检查。`
      process.stderr.write(message + '\n')
      messages.push(message)
    }
  }
  if (!messages.length) return {}
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: messages.join('\n') } }
}

async function acquireCleanupLock(path: string, workspace: string) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  const candidate = await mkdtemp(`${path}-candidate-`), owner = `owner-${process.pid}-${randomUUID()}.json`
  await writeFile(resolve(candidate, owner), JSON.stringify({ pid: process.pid, workspace, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  try {
    try { await rename(candidate, path); return owner }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) throw error }
    const entries = await readdir(path).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    if (entries.length > 1) return undefined
    if (entries.length) {
      const filename = entries[0]
      if (!/^owner-\d+-[0-9a-f-]+\.json$/u.test(filename)) return undefined
      const pid = Number(filename.split('-')[1])
      try { process.kill(pid, 0); return undefined }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined }
      // Remove the exact abandoned token; a concurrent winner has a different filename.
      await unlink(resolve(path, filename)).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error })
    try {
      await rename(candidate, path)
      return owner
    } catch (error) { if (['EEXIST', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) return undefined; throw error }
  } finally { await rm(candidate, { recursive: true, force: true }) }
}
