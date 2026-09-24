import { resolve } from 'node:path'
import { memoryKey } from '@jacob-z/jt-harness/flow'
import type { FlowStore } from '@jacob-z/jt-harness/flow'
import { loadConfig, safeError } from '@jacob-z/jt-harness/memo/config'
import type { Config } from '@jacob-z/jt-harness/memo/config'
import { startBackground } from './background.ts'
import { connectDatabase } from './postgres.ts'

/** Hooks only claim a local refresh; the child owns embedding and database I/O. */
export async function scheduleRecall(root: string, store: FlowStore, taskId: string) {
  const request = await store.claimRecall(taskId)
  if (!request) return { started: false }
  try {
    return await startBackground(root, ['flow', 'legacy', 'recall', '--workspace', store.workspace, '--task', taskId, '--request', request], resolve(store.workspace, '.jth/recall.log'))
  } catch (error) {
    await store.saveRecall(taskId, memoryKey(await store.task(taskId)), request, [], safeError(error))
    return { started: false, error: safeError(error) }
  }
}

export async function recallTask(root: string, store: FlowStore, taskId: string, pendingRequest?: string) {
  const requestedAt = pendingRequest ?? await store.claimRecall(taskId, true)
  let task = await store.task(taskId)
  if (!requestedAt || task.memory?.requestedAt !== requestedAt || task.memory.status !== 'refreshing') return task.memory
  const key = memoryKey(task), settings = await store.settings()
  let config: Config | undefined
  let pool
  try {
    config = await loadConfig(root, settings.envFile)
    const { MemoStorage, embedTexts, prepareDatabase } = await import('@jacob-z/jt-harness/memo')
    const [vector] = await embedTexts([JSON.stringify({ goal: task.goal, constraints: task.constraints })], config.embedding, AbortSignal.timeout(45000))
    pool = await connectDatabase(config)
    await prepareDatabase(pool, false)
    const storage = new MemoStorage(pool)
    const scopes = [{ kind: 'project' as const, project_ids: settings.projectIds }, { kind: 'user' as const },
      ...(settings.businessIds.length ? [{ kind: 'business' as const, business_ids: settings.businessIds }] : []),
    ]
    const matches = await Promise.all(scopes.map(scope => storage.search({ space_id: config!.embedding.space!.id, vector, scope, limit: 5 })))
    const entries = matches.flatMap(match => match.entries).sort((a, b) => a.distance - b.distance).slice(0, 5).map(entry => ({
      id: entry.id, content: entry.content.slice(0, 1000), state: entry.state, claimStatus: entry.claim_status, sourceSession: entry.source_session_id,
    }))
    await store.saveRecall(taskId, key, requestedAt, entries)
  } catch (error) {
    await store.saveRecall(taskId, key, requestedAt, [], safeError(error, config))
  } finally { await pool?.end() }
  task = await store.task(taskId)
  return task.memory
}
