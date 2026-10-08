/** Immutable provenance for proposal entries derived from already stored facts. */
export const derivationStorageSchema = `
CREATE TABLE jt_memo.entry_derivations (
  derived_entry_id uuid NOT NULL REFERENCES jt_memo.entries(id),
  source_entry_id uuid NOT NULL REFERENCES jt_memo.entries(id),
  read_version text NOT NULL CHECK (read_version ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (derived_entry_id, source_entry_id),
  CHECK (derived_entry_id <> source_entry_id)
);
CREATE INDEX entry_derivations_source ON jt_memo.entry_derivations(source_entry_id, derived_entry_id);
`
