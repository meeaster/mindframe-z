# thread-log Skill — Design Spec

> Design/build notes for the archived `skills/archive/thread-log` skill. Not bundled with the skill; not loaded at runtime.

## Intent

Gather a unit of work that spans many Claude Code and OpenCode sessions — across both tools and multiple repos — into one durable place, so picking the work back up does not mean re-reading scattered sessions. The skill treats sessions as an immutable **event source** and maintains two projections: an append-only **log** of cited evidence, and a **digest** regenerated from the log that states current thread state. It exists because keeping a single hand-maintained design doc current across many sessions is the task that reliably slips.

## Scope

In scope:

- Reading an existing thread's digest into context to resume or continue work.
- Creating a new thread (charter + scaffold + first ingest).
- Updating a thread by folding in newly-discovered sessions.
- Cross-store session discovery, human-approved membership, structured per-session extraction, and digest regeneration.

Out of scope:

- Reimplementing session storage mechanics — handled by the pipeline via `thread-sessions`.
- Writing to or mutating any session store.
- Cross-thread membership suggestion (designed-for via per-thread charters, deferred until more than one thread exists).
- A separate design document — forward-looking intent lives in the digest's **Direction** section.

## Users And Trigger Context

- Primary users: the user resuming multi-session work, and the agent reaching for prior context mid-session.
- Common requests: "continue the observability-pipelines thread", "catch me up on X", "start a thread-log for this", "update the X thread with recent sessions".
- Three modes: **Read** (default; cheap; spawns nothing; fires on any reference to an existing thread), **Create**, and **Update** (both run the ingest pipeline).
- Should not trigger for: single-session recap (use the session skills directly), or general session analysis unrelated to a tracked thread.

## Invocation

Model-invoked (no `disable-model-invocation`). The deciding factor is the **Read** mode: in Claude Code only one slash command runs per turn, so a user-invoked skill is unreachable when a session starts another way and then needs to pull in a thread mid-stream. Read must be model-reachable. The cost objection (model auto-running the expensive ingest) is handled structurally: Read is the default branch and spawns nothing, while Create/Update are gated behind explicit build/refresh intent plus the approval pause. One skill, three modes — not split, to spend only one granularity cut.

## Runtime Contract

- Required first action: classify the request into Read / Create / Update before doing anything else.
- Read mode: locate `~/.claude/threads/<slug>/`, load `digest.md`, stop. Touch `log.md` only for detail behind a specific point.
- Create/Update: run discover → confirm (approval gate) → extract → append/advance → regenerate digest.
- Non-negotiable constraints: never delegate discovery; never batch multiple sessions into one extraction agent; never edit a prior log entry (append supersessions); every extracted bullet carries a session-id-qualified citation; no session ruled into `excluded[]` returns to the approval gate.
- Files loaded at runtime: `SKILL.md` always; `INGEST.md` for the pipeline mechanics; `ARTIFACTS.md` read in full by the worker before extracting (the file contract — buckets, citation form, and the shape of every session file, log, and digest); `manifest.schema.json` when reading/writing the manifest.

## Dependencies

- Session-reading mechanics are supplied by the engine-owned `thread-sessions` skill, loaded into gather, triage, and discover dispatch containers. It reads stores mounted at literal paths and carries no store-discovery logic of its own — the storage maps (Claude Code JSONL layout, OpenCode sqlite schema, Archive Cache format) are the skill's contract. Because it is engine-owned, improving it is an in-repo change rather than a request against a foreign skill.
- Discovery is also pipeline-handled via `thread-sessions`, which lists recent sessions by iterating the mounted store's transcript glob or running the OpenCode session query — no separate "find a session" recipes needed.

## Data Model

Per thread at `~/.claude/threads/<slug>/`. Exact file shapes are the contract in `ARTIFACTS.md`; the schema below is the summary:

- `manifest.json` — **charter** (scope + the criterion the confirm step judges candidates against, stating out-of-scope explicitly), a two-state membership ledger (`sessions[]` included, each with a `high_water` offset for extraction idempotency; `excluded[]` rejected with a reason, for membership idempotency), and `runs[]`, the append-only per-invocation telemetry (model, wall-clock duration, turns, token usage, cost) — the thread's one place for run/process facts. Shape in `manifest.schema.json`.
- `sessions/<id>.md` — the authored per-session extraction, the single source of truth. Slim provenance frontmatter (`title`, `thread_relevance`, `gaps`, `extracted_by` as `<model>-<version> <effort>`) over the bucket schema, every line cited.
- `log.md` — regenerated whole each run: the five _event_ buckets merged into one flat, strictly timestamp-ordered stream, every line tagged and cited. Supersessions surface as later events, never in-place edits.
- `digest.md` — regenerated whole each run from the session files: current state, optional ASCII design diagram, key decisions (supersession-pruned), open questions, Intent, Vision, Direction, and Sources. Stable section skeleton with explicit "None" for empty content sections; no process/meta narration.

## Validation

- Lightweight: structural skill validation; manifest instances validate against `manifest.schema.json`; confirm citations are session-id-qualified.
- Deeper: a real Create run against a known multi-session thread, checking that the digest reads as usable resume-context and that a follow-up Update re-reads only grown sessions (high_water respected) and re-surfaces no excluded session.
- Acceptance gates: Read spawns no subagents; Create/Update pause for membership approval; no per-session extraction batches more than one session.

## Known Limitations

- Discovery is recall-bound by topic terms; a session whose title/prompts never mention the topic can be missed until manually added.
- Extraction fidelity depends on the session skills' drill-down quality and on session content still being present in the stores.
- Digest quality degrades if `superseded_by` links are not maintained as decisions evolve.

## Maintenance Notes

- Update `SKILL.md`/`INGEST.md` when the mode set or pipeline changes; update `ARTIFACTS.md` when the file contract (buckets, citation form, or the shape of the session file, log, or digest) changes.
- Push storage-mechanics changes into the session skills, not here.
- Update this spec when intent, scope, invocation, or the data model changes.
- Revisit cross-thread membership once a second thread exists.
