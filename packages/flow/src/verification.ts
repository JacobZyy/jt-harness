import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream } from 'node:fs'
import { lstat, readlink, mkdir, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FlowStore } from './store.ts'
import type { Verification } from './contracts.ts'

const execute = promisify(execFile)
/** Hash actual tracked and non-ignored files, so commits alone do not invalidate passing checks. */
export async function workspaceSnapshot(workspace: string): Promise<Record<string, string>> {
  // ponytail: whole-worktree snapshots suit one active implementation per worktree;
  // parallel edits should use separate worktrees rather than guessing change ownership.
  const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: workspace, maxBuffer: 8_000_000 })
  const snapshot: Record<string, string> = {}
  for (const path of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    // State and installed adapters are runtime inputs, not the task's implementation output.
    if (path.startsWith('.jth/') || path === '.codex/hooks.json' || path === '.agents/skills/jth-flow' || path.startsWith('.agents/skills/jth-flow/')) continue
    const absolute = resolve(workspace, path)
    const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!info) continue
    const hash = createHash('sha256')
    hash.update(String(info.mode & 0o777))
    if (info.isSymbolicLink()) hash.update(await readlink(absolute))
    else if (info.isFile()) for await (const chunk of createReadStream(absolute)) hash.update(chunk)
    else throw new Error('验收快照不支持目录型 Git 条目：' + path)
    snapshot[path] = hash.digest('hex')
  }
  return snapshot
}

async function runCheck(command: string, workspace: string, log: string, timeoutMs: number, signal?: AbortSignal) {
  const file = await open(log, 'wx', 0o600)
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let termination: Promise<void> | undefined
  let timedOut = false
  let abort: (() => void) | undefined
  try {
    signal?.throwIfAborted()
    const child = spawn(command, { cwd: workspace, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', file.fd, file.fd], env: process.env })
    const stop = () => {
      if (termination) return
      const kill = (signal: NodeJS.Signals) => {
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      kill('SIGTERM')
      // Wait for the group cleanup even if the shell exits before its descendants.
      termination = new Promise<void>((done, reject) => setTimeout(() => {
        try { kill('SIGKILL'); done() } catch (error) { reject(error) }
      }, 1000))
    }
    abort = stop
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    if (signal?.aborted) stop()
    const result = await new Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => done({ exitCode, signal }))
    })
    return { command, ...result, timedOut, elapsedMs: Date.now() - started, log }
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); try { await termination } finally { await file.close() } }
}

export async function verifyTask(store: FlowStore, taskId: string, sessionId?: string, timeoutMs = 120000, signal?: AbortSignal) {
  const task = await store.task(taskId)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000) throw new Error('单项验收超时必须为 100..3600000 毫秒')
  if (task.phase === 'discussion' || task.phase === 'completed' || task.blocked) throw new Error('只有未阻塞的实施任务可执行验收命令')
  if (!task.checks.length) throw new Error('任务没有验收命令；用 checkpoint --check 添加实际检查')
  if (sessionId && ((await store.binding(sessionId))?.taskId !== taskId || (await store.binding(sessionId))?.role !== 'owner')) throw new Error('仅任务主控可运行验收命令')
  const snapshot = await workspaceSnapshot(store.workspace)
  const id = randomUUID(), directory = resolve(store.workspace, '.jth/checks', id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const results: Verification['results'] = []
  // An interrupted or failed rerun must not leave an older green result usable.
  await store.saveVerification(taskId, { id, contractVersion: task.contractVersion, at: new Date().toISOString(), passed: false, snapshot, results }, sessionId)
  for (const [index, command] of task.checks.entries()) {
    if (signal?.aborted) break
    results.push(await runCheck(command, store.workspace, resolve(directory, `${index + 1}.log`), timeoutMs, signal))
    if (results.at(-1)!.exitCode !== 0 || results.at(-1)!.timedOut) break
  }
  const unchanged = JSON.stringify(snapshot) === JSON.stringify(await workspaceSnapshot(store.workspace))
  const passed = !signal?.aborted && unchanged && results.length === task.checks.length && results.every(result => result.exitCode === 0 && !result.timedOut)
  const verification: Verification = { id, contractVersion: task.contractVersion, at: new Date().toISOString(), passed, snapshot, results }
  await store.saveVerification(taskId, verification, sessionId)
  return { ...verification, snapshot: undefined, sourceUnchanged: unchanged }
}
