import { recordMemories, withIntakeLock, enqueue, executionProfile } from '@jt-harness/memo'
import type { Config, Pool } from '@jt-harness/memo'
import { deliverRecords, drainCaptureFiles } from '@jt-harness/codex-hooks'

export function receiveRecords(pool: Pool, config: Config) {
  return withIntakeLock(pool, async () => {
    const records = await deliverRecords(config, (draft, evidence) => recordMemories(pool, draft, evidence, config))
    return { received: 0, ...records }
  })
}

export function receiveDshCaptures(pool: Pool, config: Config, signal?: AbortSignal) {
  return withIntakeLock(pool, () => drainCaptureFiles(config, submission => enqueue(pool, submission, executionProfile(config)), signal))
}
