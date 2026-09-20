# Repository workflow

After completing an implementation turn in this repository, run checks appropriate to the change and automatically create a Git commit containing only the task's changes. Preserve unrelated changes. Do not create empty commits for read-only conversations. Never commit `.env`, credentials, runtime transcripts, database files, or local backups. Report the commit hash so the user can revert it. Push only when explicitly requested.

Keep memory persistence, Codex Hook integration, and CLI orchestration in their respective packages. Use existing code and tooling before adding abstractions.

Default memory ingestion uses short declarations in the main Codex reply and a Stop Hook. The background worker persists declarations and calls Embedding only; DSH is an explicit `--legacy` recovery path. Follow declaration instructions only in projects where Memo is installed. Do not proactively call `prepare/record` or install Hooks while running Flow manually. Preserve both DSH and index queue data when changing runtime modes.

Memory model configuration selects only Provider and model. Do not impose reasoning effort or output-token overrides; use DSH/Provider defaults. A task timeout is an execution safeguard, not a model-generation setting.
