export const memoryUseSchema = `
CREATE TABLE jt_memo.memory_uses (
  declaration_id text NOT NULL REFERENCES jt_memo.declaration_receipts(id),
  entry_id uuid NOT NULL REFERENCES jt_memo.entries(id),
  read_version text NOT NULL CHECK (read_version ~ '^[0-9a-f]{64}$'),
  reported_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (declaration_id, entry_id)
);
CREATE INDEX memory_uses_entry ON jt_memo.memory_uses(entry_id, reported_at);
`
