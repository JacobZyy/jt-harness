import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
const paths = []
for (const directory of ['packages/flow/src', 'packages/memo/src', 'packages/codex-hooks/src', 'packages/cli/src', 'tests']) {
  try {
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.test.ts')) paths.push(`${entry.parentPath}/${entry.name}`)
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
execFileSync(process.execPath, ['--test', ...paths], { stdio: 'inherit' })
