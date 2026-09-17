import { recordMemories, withIntakeLock } from '@jt-harness/memo'
import type { Config, Pool } from '@jt-harness/memo'
import { registerCaptures, deliverRecords } from '@jt-harness/codex-hooks'

export function receiveRecords(pool: Pool, config: Config) {
  return withIntakeLock(pool, async () => {
    const captures = await registerCaptures(config)
    const records = await deliverRecords(config, (draft, evidence) => recordMemories(pool, draft, evidence, config))
    return { ...captures, ...records }
  })
}
