export async function run(root: string, args = process.argv.slice(2)) {
  process.umask(0o077)
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
