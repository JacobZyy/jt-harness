import { recordMemories, recordDeclaration, withIntakeLock, enqueue, executionProfile } from '@jacob-z/jt-harness/memo'
import type { Config, Pool } from '@jacob-z/jt-harness/memo'
import { deliverRecords, drainCaptureFiles, collectDeclarations } from '@jacob-z/jt-harness/codex-hooks'

export function receiveRecords(pool: Pool, config: Config) {
  return withIntakeLock(pool, async () => {
    const declarations = await collectDeclarations(config)
    const records = await deliverRecords(config, (draft, evidence, declaration) => declaration ? recordDeclaration(pool, draft, evidence, config) : recordMemories(pool, draft, evidence, config))
    return { ...records, received: declarations.received, skipped: declarations.skipped, declaration_errors: declarations.errors }
  })
}

export function receiveDshCaptures(pool: Pool, config: Config, signal?: AbortSignal) {
  return withIntakeLock(pool, () => drainCaptureFiles(config, submission => enqueue(pool, submission, executionProfile(config)), signal))
}
