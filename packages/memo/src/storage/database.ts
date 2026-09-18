import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { MemoStorageError } from './contract.ts'
import { storageManagementSchema } from './schema-v3.ts'
import { intakeSchema } from './schema-v5.ts'
export const schemaVersion = 5

/** All transaction statements use one checked-out connection. */
const transactionDepth = new WeakMap<PoolClient, number>()
export async function transaction<T>(database: Pool | PoolClient, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = database instanceof Pool ? await database.connect() : database
  const depth = transactionDepth.get(client) ?? 0
  const savepoint = `memo_${depth}`
  transactionDepth.set(client, depth + 1)
  let broken = false
  try {
    await client.query(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN')
    const result = await operation(client)
    await client.query(depth ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
    return result
  } catch (error) {
    try {
      await client.query(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK')
    } catch (rollbackError) {
      broken = true
      throw new AggregateError([error, rollbackError], '记忆事务失败，且无法确认回滚；重试前读取提交回执')
    }
    throw error
  } finally {
    if (depth) transactionDepth.set(client, depth)
    else transactionDepth.delete(client)
    if (database instanceof Pool) client.release(broken)
  }
}

const schema = `
CREATE TABLE jt_memo.jobs (
  id text PRIMARY KEY,
  content_hash text NOT NULL,
  payload jsonb NOT NULL,
  execution jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (id = payload->>'submission_id')
);
CREATE INDEX jobs_pending ON jt_memo.jobs(created_at, id) WHERE status = 'queued';
CREATE TABLE jt_memo.submissions (
  id text PRIMARY KEY,
  content_hash text NOT NULL,
  source jsonb NOT NULL,
  extraction jsonb NOT NULL,
  extraction_run jsonb NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (id = source->>'submission_id')
);
CREATE TABLE jt_memo.entries (
  id uuid PRIMARY KEY,
  submission_id text NOT NULL REFERENCES jt_memo.submissions(id),
  position integer NOT NULL CHECK (position >= 0),
  collection text NOT NULL CHECK (collection IN ('memories', 'proposals')),
  content text NOT NULL CHECK (length(content) > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  basis text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('user', 'project', 'business', 'current_task', 'unspecified')),
  source_message_ids text[] NOT NULL CHECK (cardinality(source_message_ids) > 0),
  project_ids text[] NOT NULL,
  business_ids text[] NOT NULL,
  source_session_id text NOT NULL,
  UNIQUE (submission_id, position),
  UNIQUE (id, submission_id),
  CHECK ((collection = 'memories' AND basis IN ('user_statement', 'user_confirmed', 'tool_observation'))
    OR (collection = 'proposals' AND basis IN ('assistant_proposal', 'agent_inference'))),
  CHECK (scope <> 'project' OR cardinality(project_ids) > 0),
  CHECK (scope <> 'business' OR cardinality(business_ids) > 0)
);
CREATE TABLE jt_memo.embedding_spaces (
  id text PRIMARY KEY,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  definition jsonb NOT NULL,
  UNIQUE (id, dimensions)
);
CREATE TABLE jt_memo.index_commits (
  id uuid PRIMARY KEY,
  submission_id text NOT NULL REFERENCES jt_memo.submissions(id),
  space_id text NOT NULL REFERENCES jt_memo.embedding_spaces(id),
  vector_hash text NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  indexed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (submission_id, space_id)
);
CREATE TABLE jt_memo.embeddings (
  entry_id uuid NOT NULL,
  submission_id text NOT NULL,
  space_id text NOT NULL,
  dimensions integer NOT NULL,
  embedding public.vector NOT NULL,
  PRIMARY KEY (entry_id, space_id),
  FOREIGN KEY (entry_id, submission_id) REFERENCES jt_memo.entries(id, submission_id),
  FOREIGN KEY (space_id, dimensions) REFERENCES jt_memo.embedding_spaces(id, dimensions),
  FOREIGN KEY (submission_id, space_id) REFERENCES jt_memo.index_commits(submission_id, space_id),
  CHECK (public.vector_dims(embedding) = dimensions),
  CHECK (public.vector_norm(embedding) > 0)
);
CREATE INDEX entries_scope ON jt_memo.entries(scope, source_session_id);
CREATE INDEX embeddings_space ON jt_memo.embeddings(space_id);
`

const revisionSchema = `
ALTER TABLE jt_memo.index_commits ADD COLUMN relation_decisions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE jt_memo.index_commits ADD COLUMN reconciliation_run jsonb;
CREATE TABLE jt_memo.entry_relations (
  id uuid PRIMARY KEY,
  submission_id text NOT NULL,
  space_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('correction', 'supplement', 'conflict')),
  previous_entry_id uuid NOT NULL REFERENCES jt_memo.entries(id),
  current_entry_id uuid REFERENCES jt_memo.entries(id),
  revision_index integer CHECK (revision_index BETWEEN 0 AND 79),
  explanation text NOT NULL,
  evidence_submission_id text NOT NULL REFERENCES jt_memo.submissions(id),
  source_message_ids text[] NOT NULL CHECK (cardinality(source_message_ids) > 0),
  evidence_quote text NOT NULL,
  origin_relation_id uuid REFERENCES jt_memo.entry_relations(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submission_id, space_id) REFERENCES jt_memo.index_commits(submission_id, space_id),
  CHECK (previous_entry_id <> current_entry_id),
  CHECK ((current_entry_id IS NOT NULL AND revision_index IS NULL)
    OR (kind = 'conflict' AND current_entry_id IS NULL AND revision_index IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (submission_id, kind, previous_entry_id, current_entry_id, revision_index)
);
CREATE INDEX relations_previous ON jt_memo.entry_relations(previous_entry_id, kind);
CREATE UNIQUE INDEX one_correction_per_entry ON jt_memo.entry_relations(previous_entry_id) WHERE kind = 'correction';
CREATE INDEX relations_current ON jt_memo.entry_relations(current_entry_id, kind);
CREATE VIEW jt_memo.entry_states AS
  SELECT e.*, CASE
    WHEN NOT EXISTS (SELECT 1 FROM jt_memo.embeddings v WHERE v.entry_id = e.id) THEN 'pending'
    WHEN EXISTS (SELECT 1 FROM jt_memo.entry_relations r WHERE r.kind = 'correction' AND r.previous_entry_id = e.id) THEN 'superseded'
    WHEN EXISTS (
      SELECT 1 FROM jt_memo.entry_relations r
      WHERE r.kind = 'conflict' AND (r.previous_entry_id = e.id OR r.current_entry_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM jt_memo.entry_relations c WHERE c.kind = 'correction'
          AND (c.previous_entry_id = r.previous_entry_id OR c.previous_entry_id = r.current_entry_id))
    ) THEN 'conflicted' ELSE 'active' END AS state
  FROM jt_memo.entries e;
`

/** Explicit additive migrations; original source, bodies, vectors and receipts stay intact. */
export async function prepareDatabase(pool: Pool, initializeSchema: boolean): Promise<void> {
  if (initializeSchema) {
    await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('jt_memo:schema', 0))")
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('jt_memo:worker', 0))")
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('jt_memo:index-worker', 0))")
      await client.query('CREATE SCHEMA IF NOT EXISTS jt_memo')
      await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
      await client.query('CREATE TABLE IF NOT EXISTS jt_memo.schema_version (singleton boolean PRIMARY KEY CHECK (singleton), version integer NOT NULL)')
      const existing = await client.query<{ version: number }>('SELECT version FROM jt_memo.schema_version WHERE singleton = true')
      let version = existing.rows[0]?.version ?? 0
      if (existing.rows.length === 0) {
        await client.query(schema)
        await client.query('INSERT INTO jt_memo.schema_version VALUES (true, 1)')
        version = 1
      } else if (![1, 2, 3, 4, 5].includes(version)) {
        throw new MemoStorageError('SCHEMA_NOT_READY', '记忆库版本未知；拒绝升级或降级')
      }
      if (version === 1) {
        await client.query(revisionSchema)
        version = 2
      }
      if (version === 2) {
        await client.query(storageManagementSchema)
        version = 3
      }
      if (version === 3) {
        await client.query("ALTER TABLE jt_memo.jobs ADD COLUMN kind text NOT NULL DEFAULT 'legacy' CHECK (kind IN ('legacy','index'))")
        await client.query("ALTER TABLE jt_memo.jobs ADD COLUMN record_plan jsonb")
        await client.query("UPDATE jt_memo.jobs SET status='queued' WHERE kind='legacy' AND status='running'")
        version = 4
      }
      if (version === 4) await client.query(intakeSchema)
      await client.query('UPDATE jt_memo.schema_version SET version = $1 WHERE singleton = true', [schemaVersion])
    })
  }
  const result = await pool.query<{ version: number }>('SELECT version FROM jt_memo.schema_version WHERE singleton = true')
  if (result.rows[0]?.version !== schemaVersion) throw new MemoStorageError('SCHEMA_NOT_READY', `记忆库需要 v${schemaVersion}；请运行 jth memo init 完成保留数据的升级`)
  await pool.query('SELECT public.vector_dims($1::public.vector)', ['[1]'])
}
