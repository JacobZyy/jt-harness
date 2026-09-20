import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

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
