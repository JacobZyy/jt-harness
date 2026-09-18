import { fileURLToPath } from 'node:url'
import { buildPackage } from './build-package.mjs'

for (const name of ['memo', 'flow', 'codex-hooks', 'cli']) {
  await buildPackage(fileURLToPath(new URL(`../packages/${name}`, import.meta.url)))
}
