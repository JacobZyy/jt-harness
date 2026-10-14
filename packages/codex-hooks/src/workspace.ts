import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

const inputSchema = z.object({ cwd: z.string().refine(isAbsolute), session_id: z.string().min(1).max(200).optional(), transcript_path: z.string().refine(isAbsolute).nullable().optional(), path: z.string().refine(isAbsolute).optional() })
const inside = (root: string, path: string) => {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

/** Session metadata is the binding authority; sandbox permission roots are not workspace groups. */
export async function sessionWorkspaceContext(input: unknown, codexHome: string) {
  const event = inputSchema.parse(input)
  const cwd = await realpath(event.cwd)
  if (!event.session_id) return { cwd, primary: cwd, roots: [cwd], source: 'cwd' as const }
  const transcript = await sessionTranscriptPath(event, codexHome)
  if (!transcript) return { cwd, primary: cwd, roots: [cwd], source: 'cwd' as const }
  const meta = await sessionMetadata(transcript, event.session_id)
  if (meta.runtime_workspace_roots === undefined) return { cwd, primary: cwd, roots: [cwd], source: 'cwd' as const }
  const paths = z.array(z.string().refine(isAbsolute)).parse(meta.runtime_workspace_roots)
  const roots = [...new Set(await Promise.all(paths.map(async path => {
    const root = await realpath(path)
    if (!(await stat(root)).isDirectory()) throw new Error('绑定工作目录不是目录')
    return root
  })))]
  const primaryCwd = typeof meta.cwd === 'string' && isAbsolute(meta.cwd) ? await realpath(meta.cwd).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return resolve(meta.cwd as string); throw error }) : undefined
  const primary = (primaryCwd ? roots.find(root => root === primaryCwd) ?? roots.find(root => inside(root, primaryCwd)) : undefined) ?? roots[0] ?? null
  return { cwd, primary, roots: primary ? [primary, ...roots.filter(root => root !== primary)] : [], source: 'session_meta' as const }
}

/** Resolve only a registered session ID inside the selected Codex account's transcript directories. */
export async function sessionTranscriptPath(input: unknown, codexHome: string): Promise<string | undefined> {
  const event = inputSchema.parse(input)
  if (!event.session_id) return undefined
  const home = await realpath(codexHome)
  const roots = [resolve(home, 'sessions'), resolve(home, 'archived_sessions')]
  const requested = event.transcript_path ?? event.path
  if (requested) {
    const path = await realpath(requested)
    if (!roots.some(root => inside(root, path))) throw new Error('会话文件必须位于指定 CODEX_HOME 的 sessions 或 archived_sessions 中')
    await sessionMetadata(path, event.session_id)
    return path
  }
  for (const root of roots) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.includes(event.session_id)) continue
      const path = await realpath(resolve(entry.parentPath, entry.name))
      if (!inside(root, path)) throw new Error('会话文件超出指定 CODEX_HOME')
      const meta = await sessionMetadata(path)
      if (meta.id === event.session_id) return path
    }
  }
}

/** Read the first complete JSONL line only, without importing turn context or message content. */
async function sessionMetadata(path: string, sessionId?: string): Promise<Record<string, unknown>> {
  const file = await open(path, 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('会话来源不是普通文件')
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < 1_048_576) {
      const buffer = Buffer.alloc(4096)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) throw new Error('Codex 日志尚未写入完整元数据')
      const chunk = buffer.subarray(0, bytesRead), newline = chunk.indexOf(10)
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline))
      if (newline >= 0) {
        const row = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (row.type !== 'session_meta' || !row.payload || typeof row.payload.id !== 'string') throw new Error('Codex 日志缺少首行 session_meta')
        if (sessionId && row.payload.id !== sessionId) throw new Error('日志线程与 Hook 会话不一致')
        return row.payload
      }
      offset += bytesRead
    }
    throw new Error('Codex 会话元数据超过 1 MiB')
  } finally { await file.close() }
}
