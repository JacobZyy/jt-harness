# Repository workflow

After completing an implementation turn in this repository, run checks appropriate to the change and automatically create a Git commit containing only the task's changes. Preserve unrelated changes. Do not create empty commits for read-only conversations. Never commit `.env`, credentials, runtime transcripts, database files, or local backups. Report the commit hash so the user can revert it. Push only when explicitly requested.

Keep memory persistence, Codex Hook integration, and CLI orchestration in their respective packages. Use existing code and tooling before adding abstractions.

Default memory ingestion uses Codex Hooks and the background DSH Agent. Do not proactively call in-session `memo record` under the retired automatic inline instructions. Preserve both DSH and index queue data when changing runtime modes.
