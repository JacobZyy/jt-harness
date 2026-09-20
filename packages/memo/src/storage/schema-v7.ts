/** Declaration receipts link repeated assertions to one fact without rewriting its original source. */
export const declarationStorageSchema = `
CREATE TABLE IF NOT EXISTS jt_memo.declaration_receipts (
  id text PRIMARY KEY,
  draft jsonb NOT NULL,
  evidence jsonb NOT NULL,
  result jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jt_memo.declaration_sources (
  declaration_id text NOT NULL REFERENCES jt_memo.declaration_receipts(id),
  position integer NOT NULL,
  entry_id uuid NOT NULL REFERENCES jt_memo.entries(id),
  source_message_ids text[] NOT NULL,
  PRIMARY KEY(declaration_id,position)
);
CREATE INDEX IF NOT EXISTS declaration_sources_entry ON jt_memo.declaration_sources(entry_id);
CREATE INDEX IF NOT EXISTS entries_exact_content ON jt_memo.entries(content_sha256,scope,basis);
`
