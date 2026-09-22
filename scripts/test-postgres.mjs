import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'memory-live': { type: 'boolean' }, 'declaration-live': { type: 'boolean' }, 'env-file': { type: 'string' } } })
if (values['memory-live'] && values['declaration-live']) throw new Error('Choose one live verification mode')
const live = values['memory-live'] || values['declaration-live']
if (live && !values['env-file']) throw new Error('Live verification requires --env-file')
if (!live && values['env-file']) throw new Error('--env-file requires a live verification mode')

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
  await appendFile(resolve(data, 'postgresql.conf'), `\nlisten_addresses=''\nunix_socket_directories='${socket}'\n`)
  pg('pg_ctl', ['-D', data, '-l', resolve(directory, 'postgres.log'), '-o', `-c listen_addresses='' -k ${socket}`, '-w', 'start'])
  started = true
  pg('createdb', ['-h', socket, 'jth_test'])
  const args = live ? [values['declaration-live'] ? 'scripts/test-memory-declarations.ts' : 'scripts/test-memory-inputs.ts', '--env-file', resolve(values['env-file'])]
    : ['--test', '--test-concurrency=1', 'tests/integration/database.test.ts', 'tests/integration/inline.test.ts', 'tests/integration/intake.test.ts', 'tests/integration/declarations.test.ts', 'tests/integration/retrieval.test.ts', 'packages/flow/src/flow.test.ts', 'packages/codex-hooks/src/flow.test.ts', 'tests/integration/runtime.test.ts']
  const child = spawn(process.execPath, args, {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, JTH_TEST_DATABASE_URL: `postgresql:///jth_test?host=${encodeURIComponent(socket)}`, JTH_TEST_PG_DATA_DIR: data, JTH_TEST_PG_BIN_DIR: binary },
  })
  process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)) })
} finally {
  if (started) pg('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
  await rm(directory, { recursive: true, force: true })
}
