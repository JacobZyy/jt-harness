#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'

if (!process.versions.bun) {
  const { spawn } = await import('node:child_process')
  const child = spawn('bun', [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
  })
} else {
  const { run } = await import('../packages/cli/src/index.ts')
  await run(fileURLToPath(new URL('../', import.meta.url)))
}
