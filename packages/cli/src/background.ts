import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Acceptance is durable before this process is launched. No model work runs in a hook. */
export async function startWorker(root: string, config: { dataDir: string, envFile: string }, indexOnly = false) {
  return startBackground(root, ['memo', 'work', '--env-file', config.envFile, ...(indexOnly ? ['--index'] : [])], resolve(config.dataDir, 'worker.log'))
}

export async function startBackground(root: string, args: string[], logPath: string) {
  await mkdir(resolve(logPath, '..'), { recursive: true, mode: 0o700 })
  const log = await open(logPath, 'a', 0o600)
  try {
    await log.chmod(0o600)
    const child = spawn(process.execPath, [resolve(root, 'bin/jth.mjs'), ...args], {
      cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
    })
    await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject) })
    child.unref()
    return { started: true, pid: child.pid, log: logPath }
  } finally { await log.close() }
}
