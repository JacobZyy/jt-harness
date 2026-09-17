import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function buildPackage(directory) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  await rm(resolve(directory, 'dist'), { recursive: true, force: true })
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(directory, 'tsconfig.json')], { cwd: root, stdio: 'inherit' })
  if (directory.endsWith('/memo')) {
    await mkdir(resolve(directory, 'dist/agents'), { recursive: true })
    for (const file of ['runtime.json', 'agent.md', 'reconcile.md', 'agent.cordis.patch.yml']) {
      await copyFile(resolve(directory, 'src/agents', file), resolve(directory, 'dist/agents', file))
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPackage(process.cwd())
