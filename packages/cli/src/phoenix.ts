import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Config } from '@jacob-z/jt-harness/memo/config'
import { openDatabase } from '@jacob-z/jt-harness/memo'
import { readJson, writeJson } from '@jacob-z/jt-harness/codex-hooks'
import { startPostgres } from './postgres.ts'

export const phoenixUrl = 'http://127.0.0.1:6006'
const execute = promisify(execFile)
const statePath = (config: Config) => resolve(config.dataDir, 'monitor/phoenix.json')
interface Service { pid: number, command: string, started: string, processStarted: string, url: string }

async function ownedProcess(service: Service) {
  try {
    const result = await execute('ps', ['-p', String(service.pid), '-o', 'command='])
    const started = await execute('ps', ['-p', String(service.pid), '-o', 'lstart='])
    return result.stdout.includes(service.command) && result.stdout.includes('serve') && started.stdout.trim() === service.processStarted
  } catch { return false }
}
export async function phoenixStatus(config: Config) {
  const service = await readJson(statePath(config)) as Service | undefined
  const reachable = await fetch(`${phoenixUrl}/healthz`, { signal: AbortSignal.timeout(1200) }).then(response => response.ok, () => false)
  return { url: phoenixUrl, reachable, managed: Boolean(service && await ownedProcess(service)), pid: service?.pid, log: resolve(config.dataDir, 'monitor/phoenix.log') }
}
export async function startPhoenix(config: Config, root: string) {
  if (!config.databaseUrl) throw new Error('Phoenix 需要现有 PostgreSQL 配置')
  if (config.postgres) await startPostgres(config)
  const pool = openDatabase(config), client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`jth:phoenix:${config.dataDir}`])
    return await launchPhoenix(config, root)
  } finally { client.release(true); await pool.end() }
}

async function launchPhoenix(config: Config, root: string) {
  const before = await phoenixStatus(config)
  if (before.reachable) {
    if (!before.managed) throw new Error('6006 端口已有服务；未接管，请先确认端口占用')
    return before
  }
  if (before.managed) throw new Error('Phoenix 进程存在但未就绪；查看日志，避免重复启动')
  const toolsDirectory = (await execute('uv', ['tool', 'dir'])).stdout.trim()
  const command = resolve(toolsDirectory, 'arize-phoenix/bin/python')
  await mkdir(resolve(config.dataDir, 'monitor'), { recursive: true, mode: 0o700 })
  const log = await open(before.log, 'a', 0o600)
  try {
    const child = spawn(command, [resolve(root, 'bin/phoenix-local.py'), 'serve'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: {
      ...process.env, PHOENIX_HOST: '127.0.0.1', PHOENIX_PORT: '6006',
      PHOENIX_SQL_DATABASE_URL: config.databaseUrl, PHOENIX_SQL_DATABASE_SCHEMA: 'phoenix',
      PHOENIX_TELEMETRY_ENABLED: 'false', PHOENIX_ALLOW_EXTERNAL_RESOURCES: 'false',
      PHOENIX_WORKING_DIR: resolve(config.dataDir, 'monitor/phoenix'),
    } })
    await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject) })
    const processStarted = (await execute('ps', ['-p', String(child.pid), '-o', 'lstart='])).stdout.trim()
    await writeJson(statePath(config), { pid: child.pid, command, started: new Date().toISOString(), processStarted, url: phoenixUrl })
    child.unref()
  } finally { await log.close() }
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await phoenixStatus(config)
    if (status.reachable) return status
    if (!status.managed) throw new Error(`Phoenix 启动失败；日志：${before.log}`)
    await delay(500)
  }
  throw new Error(`Phoenix 尚未就绪；日志：${before.log}`)
}
export async function stopPhoenix(config: Config) {
  const service = await readJson(statePath(config)) as Service | undefined
  if (service && await ownedProcess(service)) {
    process.kill(service.pid, 'SIGTERM')
    for (let attempt = 0; attempt < 30 && await ownedProcess(service); attempt++) await delay(100)
    if (await ownedProcess(service)) throw new Error('Phoenix 尚未退出；保留管理记录')
  }
  if (service) await unlink(statePath(config))
  return { stopped: true, data_preserved: true }
}
