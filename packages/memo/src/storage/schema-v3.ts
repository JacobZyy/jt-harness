/** Additive storage metadata and append-only governance; no historical body is rewritten. */
export const storageManagementSchema = `
ALTER TABLE jt_memo.submissions ADD COLUMN received_at timestamptz;
UPDATE jt_memo.submissions s SET received_at = COALESCE((SELECT j.created_at FROM jt_memo.jobs j WHERE j.id=s.id),s.stored_at);
ALTER TABLE jt_memo.submissions ALTER COLUMN received_at SET NOT NULL;
ALTER TABLE jt_memo.submissions ALTER COLUMN received_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE jt_memo.entries ADD COLUMN entities text[] NOT NULL DEFAULT '{}';
ALTER TABLE jt_memo.entries ADD COLUMN source_occurred_at timestamptz;
ALTER TABLE jt_memo.entries ADD COLUMN valid_from timestamptz;
ALTER TABLE jt_memo.entries ADD COLUMN valid_until timestamptz;
ALTER TABLE jt_memo.entries ADD CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until);
ALTER TABLE jt_memo.entry_relations ADD COLUMN effective_at timestamptz;
UPDATE jt_memo.entry_relations SET effective_at = created_at;
ALTER TABLE jt_memo.entry_relations ALTER COLUMN effective_at SET NOT NULL;
ALTER TABLE jt_memo.entry_relations ALTER COLUMN effective_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE jt_memo.entry_relations ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE jt_memo.index_commits ADD COLUMN publication_notes jsonb NOT NULL DEFAULT '[]';
CREATE TABLE jt_memo.entry_actions (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  entry_id uuid NOT NULL REFERENCES jt_memo.entries(id),
  action text NOT NULL CHECK (action IN ('approve','reject','hold','archive','restore')),
  origin text NOT NULL CHECK (origin IN ('local_cli','runtime')),
  actor text NOT NULL DEFAULT CURRENT_USER,
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  evidence_ref text,
  acted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (action <> 'approve' OR (evidence_ref IS NOT NULL AND length(btrim(evidence_ref))>0)),
  CHECK ((action='hold') = (origin='runtime'))
);
CREATE INDEX entry_actions_latest ON jt_memo.entry_actions(entry_id, sequence DESC);

CREATE FUNCTION jt_memo.entry_facts_at(p_at timestamptz)
RETURNS TABLE (entry_id uuid, state text, claim_status text, archived boolean,
  received_at timestamptz, published_at timestamptz, confirmed_at timestamptz, invalid_at timestamptz)
LANGUAGE sql STABLE AS $$
WITH facts AS (
  SELECT e.id, e.valid_from, e.valid_until, e.source_occurred_at, s.received_at,
    (SELECT min(c.indexed_at) FROM jt_memo.embeddings v JOIN jt_memo.index_commits c
      ON c.submission_id=v.submission_id AND c.space_id=v.space_id
      WHERE v.entry_id=e.id AND c.indexed_at<=p_at) AS published_at,
    CASE review.action WHEN 'approve' THEN 'verified' WHEN 'reject' THEN 'rejected' WHEN 'hold' THEN 'candidate'
      ELSE CASE WHEN s.source->>'review_required'='true' OR e.collection='proposals' THEN 'candidate'
        WHEN e.basis='user_confirmed' THEN 'verified' WHEN e.basis='user_statement' THEN 'asserted' ELSE 'observed' END END AS claim_status,
    COALESCE(archive.action='archive',false) AS archived,
    CASE WHEN review.action='approve' THEN review.acted_at ELSE NULL END AS confirmed_at
  FROM jt_memo.entries e JOIN jt_memo.submissions s ON s.id=e.submission_id
  LEFT JOIN LATERAL (SELECT a.action,a.acted_at FROM jt_memo.entry_actions a
    WHERE a.entry_id=e.id AND a.acted_at<=p_at AND a.action IN ('approve','reject','hold') ORDER BY a.sequence DESC LIMIT 1) review ON true
  LEFT JOIN LATERAL (SELECT a.action FROM jt_memo.entry_actions a
    WHERE a.entry_id=e.id AND a.acted_at<=p_at AND a.action IN ('archive','restore') ORDER BY a.sequence DESC LIMIT 1) archive ON true
  WHERE s.received_at<=p_at AND s.stored_at<=p_at
), corrections AS (
  SELECT r.previous_entry_id,min(r.effective_at) AS invalid_at FROM jt_memo.entry_relations r
  WHERE r.kind='correction' AND r.created_at<=p_at AND r.effective_at<=p_at GROUP BY r.previous_entry_id
), conflicts AS (
  SELECT r.previous_entry_id,r.current_entry_id FROM jt_memo.entry_relations r
  JOIN facts old ON old.id=r.previous_entry_id LEFT JOIN facts newer ON newer.id=r.current_entry_id
  WHERE r.kind='conflict' AND r.created_at<=p_at AND r.effective_at<=p_at
    AND NOT EXISTS (SELECT 1 FROM corrections c WHERE c.previous_entry_id=r.previous_entry_id OR c.previous_entry_id=r.current_entry_id)
    AND (NOT r.needs_review OR (old.claim_status NOT IN ('candidate','rejected') AND newer.claim_status NOT IN ('candidate','rejected')))
)
SELECT f.id, CASE WHEN f.published_at IS NULL THEN 'pending'
  WHEN c.invalid_at IS NOT NULL THEN 'superseded'
  WHEN COALESCE(f.valid_from,f.source_occurred_at,f.published_at)>p_at THEN 'scheduled'
  WHEN f.valid_until<=p_at THEN 'expired'
  WHEN EXISTS (SELECT 1 FROM conflicts r WHERE r.previous_entry_id=f.id OR r.current_entry_id=f.id) THEN 'conflicted'
  ELSE 'active' END,
  f.claim_status,f.archived,f.received_at,f.published_at,f.confirmed_at,c.invalid_at
FROM facts f LEFT JOIN corrections c ON c.previous_entry_id=f.id;
$$;

CREATE OR REPLACE VIEW jt_memo.entry_states AS
SELECT e.id,e.submission_id,e.position,e.collection,e.content,e.content_sha256,e.basis,e.scope,
  e.source_message_ids,e.project_ids,e.business_ids,e.source_session_id,f.state,
  e.entities,e.source_occurred_at,e.valid_from,e.valid_until,
  f.claim_status,f.archived,f.received_at,f.published_at,f.confirmed_at,f.invalid_at
FROM jt_memo.entries e JOIN jt_memo.entry_facts_at(CURRENT_TIMESTAMP) f ON f.entry_id=e.id;
`
