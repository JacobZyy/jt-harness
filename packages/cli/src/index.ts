import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function run(root: string, args = process.argv.slice(2)) {
  process.umask(0o077)
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
    process.stdout.write(`${manifest.version}\n`); return
  }
  if (args[0] === 'monitor') {
    const { monitorMain } = await import('./monitor.ts')
    return monitorMain(root, args.slice(1))
  }
  if (['init', 'install', 'upgrade', 'doctor', 'uninstall'].includes(args[0])) {
    const { deliveryMain } = await import('./delivery.ts')
    return deliveryMain(root, args)
  }
  if (args[0] === 'db') {
    const { databaseMain } = await import('./postgres.ts')
    return databaseMain(root, args.slice(1))
  }
  if (args[0] === 'flow') {
    const { flowMain } = await import('./flow.ts')
    return flowMain(root, args.slice(1))
  }
  if (args[0] === 'memo' && args[1] === 'model') {
    const { modelMain } = await import('./model.ts')
    return modelMain(root, args.slice(2))
  }
  if (args[0] === 'memo' && args[1] === 'codex') {
    const { codexMain } = await import('./codex.ts')
    return codexMain(root, args.slice(2))
  }
  if (args[0] === 'memo' && ['prepare', 'evidence', 'record'].includes(args[1])) {
    const { inlineMain } = await import('./inline.ts')
    return inlineMain(root, args.slice(1))
  }
  const { main } = await import('./main.ts')
  return main(root, args)
}
