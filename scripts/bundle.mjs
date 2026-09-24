import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, rm, realpath, unlink, rename } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = resolve(root, 'artifacts/distribution'), target = resolve(output, 'jt-harness')
const digest = createHash('sha256')
digest.update(await readFile(resolve(root, 'pnpm-lock.yaml')))
await rm(target, { recursive: true, force: true })
execFileSync('pnpm', ['--filter', '@jacob-z/jt-harness', 'deploy', '--prod', '--no-optional', '--legacy', target], { cwd: root, stdio: 'inherit' })
for (const name of ['cli', 'codex-hooks', 'flow', 'memo']) {
  await rm(resolve(target, 'packages', name, 'dist'), { recursive: true, force: true })
}
// The normal distribution deliberately omits optional, source-linked legacy DSH SDKs.
async function inspect(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const actual = await realpath(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (!actual) { await unlink(path); continue }
      const child = relative(target, actual)
      if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error(`发行包含外部链接：${relative(target, path)}`)
    } else if (entry.isDirectory()) await inspect(path)
    else if (entry.name === 'package.json') {
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      delete manifest.devDependencies
      if (manifest.optionalDependencies) {
        for (const [name, version] of Object.entries(manifest.optionalDependencies)) if (String(version).startsWith('link:')) delete manifest.optionalDependencies[name]
      }
      // Deploy may hard-link manifests to the workspace/store. Replace the staged inode only.
      await writeFile(`${path}.bundle-tmp`, JSON.stringify(manifest, null, 2) + '\n')
      await rename(`${path}.bundle-tmp`, path)
    } else if (entry.name === '.env') throw new Error('发行包中禁止包含 .env')
    if (entry.isFile()) { digest.update(relative(target, path)); digest.update(await readFile(path)) }
  }
}
await inspect(target)
const manifest = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'))
manifest.jthDistribution = { format: 1, build: `${manifest.version.replaceAll('.', '-')}-${digest.digest('hex').slice(0, 16)}` }
manifest.private = false
delete manifest.scripts
await writeFile(resolve(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
execFileSync(process.execPath, [resolve(target, 'bin/jth.ts'), '--help'], { cwd: target, stdio: 'ignore' })
const archive = resolve(output, `jt-harness-${manifest.version}.tar.gz`)
execFileSync('tar', ['-czf', archive, '-C', output, 'jt-harness'])
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(`${archive}.sha256`, `${sha256}  ${archive.split('/').at(-1)}\n`)
console.log(JSON.stringify({ archive, sha256, build: manifest.jthDistribution.build }))
