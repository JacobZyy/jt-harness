/** Additive diagnostics; accepted facts, hashes and existing receipts are not rewritten. */
export const intakeSchema = `
ALTER TABLE jt_memo.submissions ADD COLUMN IF NOT EXISTS intake_issues jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE jt_memo.index_commits ADD COLUMN IF NOT EXISTS intake_issues jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE jt_memo.jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jt_memo.jobs ADD CONSTRAINT jobs_status_check CHECK(status IN ('queued','running','complete','partial','failed'));
CREATE TABLE IF NOT EXISTS jt_memo.agent_outputs (
  submission_id text NOT NULL REFERENCES jt_memo.jobs(id),
  stage text NOT NULL CHECK(stage IN ('extraction','reconciliation')),
  session_id text NOT NULL,
  response text NOT NULL,
  run jsonb NOT NULL,
  validation_error text,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(submission_id,stage,session_id)
);
`
