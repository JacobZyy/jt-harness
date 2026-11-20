---
name: jth-memo
description: JTH project memory — read/write/search using AIOS-style file-based memo. You decide what to remember, correct, and mark useful. TRIGGER: 记忆、memory、memo、remember、recall、记住、之前、结论
---

# JTH Memory

Working directory: project root. Memory is stored in `.jth-memo/` under the project root.

## Principle: you decide, the harness executes

The harness only *provides capabilities*. Judging **whether a fact is durable**, **what to persist**, **what to correct**, and **which recalled memory was useful** is entirely your job.

## Capabilities

```sh
jth memo core add "<fact>"                      # Persist a durable fact (lands as candidate)
jth memo core add "<corrected>" --supersedes <eventId>  # Supersede a wrong fact
jth memo core search "<query>" [--limit N]      # Search prior memos
jth memo core recall [query]                    # Human-readable session recall digest
jth memo core useful <eventId>                  # Mark a recalled memory that shaped your work
jth memo core checkpoint "<one-line takeaway>"  # Pin a milestone (surfaced first on recall)
jth memo core read <eventId>                    # Read a specific entry
```

## When to persist

Persist a durable, verified fact a future session will need — a root cause, a confirmed fix, a decision rule. Do **not** persist chatter, in-progress noise, or unverified hypotheses.

## Entry shape

One entry = one fact = one evidence. Five fields:

- `fact`: durable statement understandable without context.
- `entities`: files, commands, symbols, concepts the fact touches.
- `date`: absolute ISO date (never relative: "昨天" → `2026-11-20`).
- `evidence_ref`: ONE backing reference — a command with exit code, a `file:line`, a doc path.
- `confidence`: `high` (ran and verified) or `medium` (established but indirect).

## Declaration block (at end of reply)

```
<!--memory: verified=yes|no, useful=<eventId1,eventId2>, conclusion=<one-line takeaway> -->
```

- `verified=yes` only when this turn produced a confirmed, durable fact.
- `useful=` lists recalled eventIds you actually referenced.
- `conclusion=` one line capturing the takeaway.
