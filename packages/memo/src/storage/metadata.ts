import type { Extraction, Submission } from '../contracts.ts'

type Fact = Extraction['memories'][number] | Extraction['proposals'][number]

/** Missing source dates stay unknown. All cited messages must be dated to order a fact. */
export function entryMetadata(fact: Fact, submission: Submission) {
  const cited = fact.source_message_ids.map(id => submission.messages.find(message => message.message_id === id)!)
  const dated = cited.every(message => message.occurred_at !== undefined)
  return {
    entities: fact.entities ?? [],
    source_occurred_at: dated ? new Date(Math.max(...cited.map(message => Date.parse(message.occurred_at!)))).toISOString() : null,
    valid_from: fact.valid_from ? new Date(fact.valid_from).toISOString() : null,
    valid_until: fact.valid_until ? new Date(fact.valid_until).toISOString() : null,
  }
}

/** The placeholder is an internal SQL constant, never user-supplied query text. */
export function entrySnapshot(atPlaceholder: string) {
  return `SELECT e.*, f.state, f.claim_status, f.archived, f.received_at, f.published_at, f.confirmed_at, f.invalid_at
    FROM jt_memo.entries e JOIN jt_memo.entry_facts_at(COALESCE(${atPlaceholder}::timestamptz,CURRENT_TIMESTAMP)) f ON f.entry_id=e.id`
}
