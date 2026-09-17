import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const binary = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin'
// /tmp avoids macOS's 104-byte Unix socket path limit.
const directory = await mkdtemp(resolve('/tmp', 'jth-pg-test-'))
const data = resolve(directory, 'data')
const socket = resolve(directory, 'socket')
let started = false
const pg = (command, args) => execFileSync(resolve(binary, command), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
try {
  await mkdir(socket, { mode: 0o700 })
  pg('initdb', ['-D', data, '--auth-local=peer', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'])
  pg('pg_ctl', ['-D', data, '-l', resolve(directory, 'postgres.log'), '-o', `-c listen_addresses='' -k ${socket}`, '-w', 'start'])
  started = true
  pg('createdb', ['-h', socket, 'jth_test'])
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/integration/database.test.ts', 'tests/integration/inline.test.ts'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, JTH_TEST_DATABASE_URL: `postgresql:///jth_test?host=${encodeURIComponent(socket)}` },
  })
  process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)) })
} finally {
  if (started) pg('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
  await rm(directory, { recursive: true, force: true })
}
