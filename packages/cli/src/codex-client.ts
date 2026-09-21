import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse, patch } from '@decimalturn/toml-patch'

/** Project preferences stay in Codex's own config; never follow links into a shared user config. */
export async function configureProjectMemories(workspace: string, policy: 'off' | 'inherit') {
  const directory = resolve(workspace, '.codex'), path = resolve(directory, 'config.toml')
  await mkdir(directory, { recursive: true })
  if (await realpath(directory) !== directory) throw new Error('项目 .codex 是符号链接；未修改共享配置')
  const metadata = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (metadata && !metadata.isFile()) throw new Error('项目 config.toml 不是普通文件；未修改共享配置')
  const read = () => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const original = await read()
  let document: Record<string, unknown>
  try { document = parse(original) } catch { throw new Error('Codex 项目配置不是有效 TOML；未修改原文件') }
  if (document.memories !== undefined && (!document.memories || typeof document.memories !== 'object' || Array.isArray(document.memories) || document.memories instanceof Date)) {
    throw new Error('Codex 项目的 memories 必须是 TOML table；未修改原文件')
  }
  const memories = { ...document.memories as Record<string, unknown> }
  if (policy === 'off') { memories.use_memories = false; memories.generate_memories = false }
  else { delete memories.use_memories; delete memories.generate_memories }
  if (Object.keys(memories).length) document.memories = memories
  else delete document.memories
  const next = patch(original, document)
  if (next !== original) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, next, { flag: 'wx', mode: metadata ? metadata.mode & 0o777 : 0o600 })
      if (await read() !== original) throw new Error('Codex 项目配置被其他进程更新；请重试，原配置未覆盖')
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  return { policy, path, activation: '受信任项目的新会话生效；当前会话可用 /memories 调整',
    ...(policy === 'off' ? { use_memories: false, generate_memories: false } : {}) }
}

/** Read native configuration/status without starting a model turn. */
export async function withCodex<T>(operation: (call: (method: string, params: object) => Promise<any>) => Promise<T>) {
  const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>(done => child.once('close', () => done()))
  let id = 0
  const pending = new Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>()
  const rejectAll = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear() }
  child.once('error', rejectAll)
  child.stdin.on('error', rejectAll)
  child.once('exit', () => rejectAll(new Error('Codex 状态连接已关闭')))
  // Diagnostics can contain paths/provider metadata; the public response is the contract we consume.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let message: { id?: number, result?: unknown, error?: { message: string } }
    try { message = JSON.parse(line) } catch { return }
    const request = message.id === undefined ? undefined : pending.get(message.id)
    if (!request) return
    pending.delete(message.id!)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  const call = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) reject(error) })
  })
  const timer = setTimeout(() => { rejectAll(new Error('Codex 状态读取超过 15 秒')); child.kill() }, 15000)
  try {
    await call('initialize', { clientInfo: { name: 'jth', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    child.stdin.write('{"method":"initialized"}\n')
    return await operation(call)
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.end(); child.kill()
    const terminate = setTimeout(() => child.kill('SIGKILL'), 2000)
    await closed
    clearTimeout(terminate)
  }
}

export interface NativeHook { key: string, source: string, sourcePath: string, eventName: string, currentHash: string, statusMessage?: string, command?: string, enabled: boolean, trustStatus: string }
export interface NativeHookList { data: { cwd: string, hooks: NativeHook[], errors: { message: string }[], warnings: string[] }[] }

export async function inspectNativeHooks(workspace: string) {
  return withCodex(async call => (await call('hooks/list', { cwds: [workspace] }) as NativeHookList).data[0])
}
