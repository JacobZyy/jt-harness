import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function readHookInput() {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 512_000) throw new Error('Hook 输入超过 512000 字节')
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new Error('Hook 输入不是有效 JSON') }
}

export async function run(root: string, args = process.argv.slice(2)) {
  process.umask(0o077)
  const hook = args[0] === 'monitor' && args[1] === 'capture'
    || args[0] === 'migrate' && args.includes('--session-start')
    || args[0] === 'flow' && args[1] === 'prompt'
    || args[0] === 'memo' && args[1] === 'codex' && ['capture', 'declare', 'cue'].includes(args[2])
  let hookInput: unknown
  if (hook && !args.includes('--help') && !args.includes('-h')) {
    try { hookInput = await readHookInput() }
    catch (error) {
      process.stderr.write(JSON.stringify({ error: (error as Error).message }) + '\n')
      if (args[0] === 'flow' || args[0] === 'migrate') process.stdout.write('{}\n')
      return
    }
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
    process.stdout.write(`${manifest.version}\n`); return
  }
  if (args[0] === 'monitor') {
    const { monitorMain } = await import('./monitor.ts')
    return monitorMain(root, args.slice(1), hookInput)
  }
  if (['init', 'install', 'upgrade', 'doctor', 'uninstall', 'migrate'].includes(args[0])) {
    const { deliveryMain } = await import('./delivery.ts')
    return deliveryMain(root, args, hookInput)
  }
  if (args[0] === 'db') {
    const { databaseMain } = await import('./postgres.ts')
    return databaseMain(root, args.slice(1))
  }
  if (args[0] === 'flow') {
    const { flowMain } = await import('./flow.ts')
    return flowMain(root, args.slice(1), hookInput)
  }
  if (args[0] === 'memo' && args[1] === 'model') {
    const { modelMain } = await import('./model.ts')
    return modelMain(root, args.slice(2))
  }
  if (args[0] === 'memo' && args[1] === 'codex') {
    const { codexMain } = await import('./codex.ts')
    return codexMain(root, args.slice(2), hookInput)
  }
  if (args[0] === 'memo' && ['prepare', 'evidence', 'record'].includes(args[1])) {
    const { inlineMain } = await import('./inline.ts')
    return inlineMain(root, args.slice(1))
  }
  const { main } = await import('./main.ts')
  return main(root, args)
}
