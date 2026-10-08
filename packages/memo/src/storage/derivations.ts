import { z } from 'zod'
import type { Pool, PoolClient } from 'pg'
import type { Extraction, Submission } from '../contracts.ts'
import { entryMetadata } from './metadata.ts'
import { entrySnapshot } from './metadata.ts'
import { entryVersion, versionExpressionFor } from '../version.ts'
import { sha256, MemoStorageError } from './contract.ts'
import type { MemoryEntry } from './contract.ts'
import type { StateEntry } from './relations.ts'
import { sameScope, scopeProvided } from './relations.ts'

export const derivationSourceSchema = z.strictObject({
  entry_id: z.uuid(),
  read_version: z.string().regex(/^[0-9a-f]{64}$/),
})

export const derivationSchema = z.strictObject({
  proposal_index: z.number().int().min(0),
  sources: z.array(derivationSourceSchema).min(1).max(10)
    .refine(sources => new Set(sources.map(source => source.entry_id)).size === sources.length, '派生来源不能重复'),
})

export const derivationsSchema = z.array(derivationSchema).max(3)
  .refine(items => new Set(items.map(item => item.proposal_index)).size === items.length, '同一 proposal 不能重复声明派生关系')

export type DerivationSource = z.infer<typeof derivationSourceSchema>
export type Derivation = z.infer<typeof derivationSchema>

export function derivationSnapshotStale(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.some(item => {
    if (!item || typeof item !== 'object') return true
    const dependency = item as { read_version?: unknown, version_data?: unknown }
    return typeof dependency.read_version !== 'string' || dependency.version_data == null
      || sha256(JSON.stringify(dependency.version_data)) !== dependency.read_version
  })
}

function candidateEntry(fact: Extraction['proposals'][number], submission: Submission): MemoryEntry {
  const metadata = entryMetadata(fact, submission)
  return {
    id: '', submission_id: submission.submission_id, position: 0, collection: 'proposals',
    content: fact.content, content_sha256: sha256(fact.content), basis: fact.basis, scope: fact.scope,
    source_message_ids: fact.source_message_ids, project_ids: submission.scope.project_ids,
    business_ids: submission.scope.business_ids, source_session_id: submission.source.session_id,
    entities: metadata.entities,
    source_occurred_at: metadata.source_occurred_at ? new Date(metadata.source_occurred_at) : null,
    valid_from: metadata.valid_from ? new Date(metadata.valid_from) : null,
    valid_until: metadata.valid_until ? new Date(metadata.valid_until) : null,
  }
}

/** Lock and validate every source before the derived proposal is inserted. */
export async function validateDerivations(
  client: PoolClient,
  input: unknown,
  extraction: Extraction,
  submission: Submission,
) {
  const derivations = derivationsSchema.parse(input ?? [])
  for (const derivation of derivations) {
    if (derivation.proposal_index >= extraction.proposals.length) throw new Error('派生 proposal_index 必须引用本批 proposals')
  }
  const sourceIds = [...new Set(derivations.flatMap(item => item.sources.map(source => source.entry_id)))].sort()
  if (sourceIds.length) await client.query('SELECT id FROM jt_memo.entries WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [sourceIds])
  const states = sourceIds.length
    ? (await client.query<StateEntry>('SELECT * FROM jt_memo.entry_states WHERE id=ANY($1::uuid[])', [sourceIds])).rows
    : []
  const stateById = new Map(states.map(entry => [entry.id, entry]))
  const derivedSources = sourceIds.length
    ? new Set((await client.query<{ derived_entry_id: string }>('SELECT derived_entry_id FROM jt_memo.entry_derivations WHERE derived_entry_id=ANY($1::uuid[])', [sourceIds])).rows.map(row => row.derived_entry_id))
    : new Set<string>()
  for (const derivation of derivations) {
    const proposal = candidateEntry(extraction.proposals[derivation.proposal_index], submission)
    for (const source of derivation.sources) {
      const entry = stateById.get(source.entry_id)
      if (!entry || !['active'].includes(entry.state) || entry.archived
        || !['asserted', 'observed', 'verified'].includes(entry.claim_status)) {
        throw new Error('派生来源必须是未归档、未冲突且已确认的 active 记忆')
      }
      if (derivedSources.has(source.entry_id)) throw new Error('派生来源不能再依赖其他派生记忆')
      if (!scopeProvided(entry, submission) || !sameScope(entry, proposal)) {
        throw new Error('派生来源与 proposal 必须属于完全相同范围')
      }
      if (source.read_version !== await entryVersion(client, source.entry_id)) {
        throw new MemoStorageError('VERSION_CONFLICT', '派生来源版本已变化；请重新 read 后提交')
      }
    }
  }
  return derivations
}

interface DerivationRow {
  derived_entry_id: string
  source_entry_id: string
  read_version: string
  version_data: unknown | null
  source_exists: boolean
}

async function derivationRows(database: Pool | PoolClient, entryId: string, asOf?: string) {
  const result = await database.query<DerivationRow>(`
    WITH snapshot AS (${entrySnapshot('$2')})
    SELECT d.derived_entry_id,d.source_entry_id,d.read_version,
      source.id IS NOT NULL AS source_exists,
      CASE WHEN source.id IS NULL THEN NULL ELSE ${versionExpressionFor('source', '$2', false)} END AS version_data
    FROM jt_memo.entry_derivations d LEFT JOIN snapshot source ON source.id=d.source_entry_id
    WHERE d.derived_entry_id=$1 ORDER BY d.source_entry_id
  `, [entryId, asOf ?? null])
  return result.rows
}

export async function readDerivations(database: Pool | PoolClient, entryId: string, asOf?: string) {
  const sources = (await derivationRows(database, entryId, asOf)).map(row => {
    const current_version = row.source_exists && row.version_data !== null ? sha256(JSON.stringify(row.version_data)) : null
    return { entry_id: row.source_entry_id, read_version: row.read_version, current_version, stale: current_version !== row.read_version }
  })
  return { sources, stale: sources.some(source => source.stale) }
}

/** Approving a derived proposal requires source locks and a fresh source token. */
export async function assertDerivationApprovable(client: PoolClient, entryId: string) {
  const sources = (await client.query<{ source_entry_id: string }>(`
    SELECT d.source_entry_id FROM jt_memo.entry_derivations d
    JOIN jt_memo.entries source ON source.id=d.source_entry_id
    WHERE d.derived_entry_id=$1 ORDER BY d.source_entry_id FOR UPDATE OF source
  `, [entryId])).rows
  if (!sources.length) return
  const states = (await client.query<StateEntry>('SELECT * FROM jt_memo.entry_states WHERE id=ANY($1::uuid[])', [sources.map(source => source.source_entry_id)])).rows
  for (const source of sources) {
    const state = states.find(entry => entry.id === source.source_entry_id)
    if (!state || state.state !== 'active' || state.archived || !['asserted', 'observed', 'verified'].includes(state.claim_status)) {
      throw new Error('派生记忆来源已失效；禁止确认')
    }
    const edges = await client.query<{ read_version: string }>('SELECT read_version FROM jt_memo.entry_derivations WHERE derived_entry_id=$1 AND source_entry_id=$2', [entryId, source.source_entry_id])
    if (!edges.rows[0] || edges.rows[0].read_version !== await entryVersion(client, source.source_entry_id)) {
      throw new Error('派生记忆来源已变化；禁止确认')
    }
  }
}
