import { execFileSync } from 'node:child_process'
for (const name of ['memo', 'flow', 'codex-hooks', 'cli']) {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/${name}/tsconfig.json`, '--noEmit'], { stdio: 'inherit' })
}

execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' })
