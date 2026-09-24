import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openDatabase, safeError } from '@jacob-z/jt-harness/memo'
import { loadWorkspaceConfig } from './configuration.ts'
import type { Config } from '@jacob-z/jt-harness/memo'

const execute = promisify(execFile)
function managed(config: Config) {
  if (!config.postgres || !config.databaseUrl) throw new Error('未配置托管 PG；设置 JTH_PG_DATA_DIR，外部数据库只连接、不启停')
  const url = new URL(config.databaseUrl), host = url.searchParams.get('host') ?? url.hostname
  if (!(host.startsWith('/') || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host))) throw new Error('托管 PG 仅允许明确的本地地址或 Unix socket')
  return config.postgres
}
async function control(config: Config, args: string[]) {
  const local = managed(config)
  const command = local.binDir ? resolve(local.binDir, 'pg_ctl') : 'pg_ctl'
  return execute(command, ['-D', local.dataDir, ...args], { timeout: 20000, maxBuffer: 64000 })
}
export async function postgresStatus(config: Config) {
  const local = managed(config)
  const version = (await readFile(resolve(local.dataDir, 'PG_VERSION'), 'utf8')).trim()
  const running = await control(config, ['status']).then(() => true).catch(error => { if (error.code === 3) return false; throw error })
  return { status: running ? 'running' : 'stopped', dataDir: local.dataDir, version }
}
async function verifyInstance(config: Config) {
  const pool = openDatabase(config)
  try {
    const result = await pool.query<{ data_directory: string }>('SHOW data_directory')
    if (await realpath(result.rows[0].data_directory) !== await realpath(managed(config).dataDir)) throw new Error('数据库连接指向另一 PG 实例；拒绝接管')
  } finally { await pool.end() }
}
async function waitReady(config: Config) {
  const deadline = Date.now() + 15000
  for (;;) {
    try { await verifyInstance(config); return } catch (error) {
      if (!['ECONNREFUSED', 'ENOENT', '57P03'].includes(String((error as NodeJS.ErrnoException).code)) || Date.now() >= deadline) throw error
      await delay(100)
    }
  }
}
export async function startPostgres(config: Config) {
  const before = await postgresStatus(config)
  if (before.status === 'running') { await waitReady(config); return { ...before, started: false } }
  try {
    await control(config, ['start', '-l', resolve(dirname(before.dataDir), 'postgres.log'), '-w', '-t', '15'])
  } catch (error) {
    // PostgreSQL's postmaster lock chooses the winner when several CLI processes start together.
    if ((await postgresStatus(config)).status !== 'running') throw error
  }
  await waitReady(config)
  return { ...before, status: 'running', started: true }
}
export async function connectDatabase(config: Config) {
  if (config.postgres) await startPostgres(config)
  return openDatabase(config)
}
export async function databaseMain(root: string, args: string[]) {
  let config: Config | undefined
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'env-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
    if (values.help || !positionals.length) { process.stdout.write('jth db status|start|stop [--env-file <path>]\nstatus 只观察；stop 关闭明确配置的本地实例，数据保留。\n'); return }
    const [command] = positionals
    if (positionals.length !== 1 || !['status', 'start', 'stop'].includes(command)) throw new Error('未知数据库命令')
    config = await loadWorkspaceConfig(root, values['env-file'])
    if (command === 'start') { process.stdout.write(JSON.stringify(await startPostgres(config)) + '\n'); return }
    const status = await postgresStatus(config)
    if (command === 'stop' && status.status === 'running') {
      await verifyInstance(config)
      await control(config, ['stop', '-m', 'fast', '-w', '-t', '15'])
    }
    process.stdout.write(JSON.stringify(command === 'stop' ? await postgresStatus(config) : status) + '\n')
  } catch (error) { process.stderr.write(JSON.stringify({ error: safeError(error, config) }) + '\n'); process.exitCode = 1 }
}
