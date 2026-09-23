# Repository workflow

After completing an implementation turn in this repository, run checks appropriate to the change and automatically create a Git commit containing only the task's changes. Preserve unrelated changes. Do not create empty commits for read-only conversations. Never commit `.env`, credentials, runtime transcripts, database files, or local backups. Report the commit hash so the user can revert it. Push only when explicitly requested.

Keep memory persistence, Codex Hook integration, and CLI orchestration in their respective packages. Use existing code and tooling before adding abstractions.

Use Codex native Goal, task list, session recovery, compaction, command execution and permissions for flow control. Maintain the actual native plan when the host exposes its planning tool; do not claim native UI updates when that tool is unavailable. JTH supplies concise project guidance and Memo access, not a second task database or execution loop. Old Flow state is available only through explicit `jth flow legacy` commands. Preserve historical tasks and queues; run project checks before completing the native plan or Goal.

Default memory ingestion uses short declarations in the main Codex reply and a Stop Hook. The background worker persists declarations and calls Embedding only; DSH is an explicit `--legacy` recovery path. Follow declaration instructions only in projects where Memo is installed. Do not proactively call `prepare/record` or install Hooks while running Flow manually. Preserve both DSH and index queue data when changing runtime modes.

Memory model configuration selects only Provider and model. Do not impose reasoning effort or output-token overrides; use DSH/Provider defaults. A task timeout is an execution safeguard, not a model-generation setting.

## Flow acceptance

Apply the shared [task acceptance contract](packages/flow/skills/jth-flow/references/acceptance.md) before completing substantive work. Add only the following project checks when their area changes:

- CLI behavior: command help, documented arguments and actual execution agree. Use the relevant CLI invocation and focused checks as evidence.
- Flow or Skill guidance: the installed Skill can load its referenced files; instructions preserve native Goal and plan ownership and do not start a second task loop or model call. Inspect the installed files and use the existing native installation test when installation behavior is affected.
- Memory or Hook behavior: changes preserve the package boundaries and existing source, scope, revision and queue contracts. Use the affected existing tests and actual changed call path as evidence; do not make new live model calls or clear real data merely to produce acceptance evidence.
