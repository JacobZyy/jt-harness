/** Recovery is an append-only correction receipt; original output and publication remain intact. */
export const recoverySchema = `
ALTER TABLE jt_memo.jobs ADD COLUMN IF NOT EXISTS failure_history jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS jt_memo.intake_recoveries (
  submission_id text NOT NULL REFERENCES jt_memo.jobs(id),
  path text NOT NULL,
  action text NOT NULL CHECK(action IN ('replace','dismiss')),
  reason text NOT NULL,
  value jsonb,
  content_hash text NOT NULL,
  followup_id text UNIQUE REFERENCES jt_memo.jobs(id),
  publication_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(submission_id,path)
);
`
