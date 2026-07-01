---
name: threads
description: Operate threads with the `mfz thread` CLI — load a thread's digest into context, or build and refresh one by discovering and ingesting sessions. Use when the user references an existing thread, wants to resume or catch up on prior multi-session work, or wants to ingest sessions into a thread.
---

# threads

A thread is a git-backed, agent-synthesized record of work across many sessions; its **digest** is the one file you read to pick the work back up. `mfz thread` operates one — **drive the CLI; never hand-edit the manifest, session files, log, or digest** unless the operator explicitly asks for manual repair.

Decide which branch the request is: just **load** a thread into context (cheap, the default), or **build** one by ingesting sessions (costs money — confirm first).

## Load a thread into context

The default whenever the user references an existing thread — resume, catch up, "the X thread", or you simply need its state in this session. Reads only; spawns nothing; costs nothing — fire it freely.

1. **Find the slug** if you don't have it — `mfz thread list`.

2. **Read the digest.** `mfz thread show <slug>` prints the current-state digest. Done when the digest answers what you came for — **stop here**; do not ingest to "freshen" it unless the user asks.

## Build or refresh a thread

Folds sessions into a thread. **Ingestion dispatches read-only agents and costs roughly $1–2 per session** — confirm the session ids with the user before you ingest.

1. **Discover the sessions.** `mfz thread discover "<prompt>" --json`

   Returns candidate ids in the `source:id` form ingest expects (e.g. `claude-code:<uuid>`, `opencode:ses_<id>`), each with a one-line rationale. Done when you have the ids to ingest, or discovery reports no match.

2. **Create the thread** (first time only). `mfz thread create <slug> --charter "<lens>" [--dest <destination>]`

   The **charter** is the synthesis lens — what this thread filters for and emphasizes; spend care on it, since every synthesis reads through it. Done when the command reports the thread created; skip when the thread already exists.

3. **Ingest.** `mfz thread ingest <source:id...> --thread <slug>`

   Folds the named sessions in — runs gather → synthesize → digest and commits the result to the thread's destination repo. Add `--no-push` to commit locally without pushing. Each id must be **source-qualified** (`claude-code:<id>` or `opencode:<id>`) — the form `discover` emits; a bare id is rejected. Requires at least one id. Done when the run shows complete in `mfz thread runs --thread <slug>`.

   **Ingest also auto-refreshes drift.** Before dispatching, it recomputes a per-session watermark for every session already in the thread — free, no agent call — and folds any that grew since the last ingest into this run alongside the ids you named, then digests once. It reports the refresh set, noting any session that vanished or shrank (which it leaves untouched). A session that was never watermarked is left alone until you name it in an ingest once.

## Refresh

`mfz thread refresh --thread <slug>` brings a thread up to date without naming new sessions: it recomputes every session's watermark and re-synthesizes only the ones that drifted, then digests once. Finding nothing drifted is a successful no-op, not an error. Add `--all` to force a full re-gather + re-synthesis of **every** session regardless of watermark — the way to rebuild after changing the charter or models (this also captures a watermark for any session that never had one).

`update_strategy` in the profile's `thread` config picks how a drifted session is refreshed: `full` (default) re-synthesizes the whole session; `delta` reads only the messages past the watermark and revises the existing file. Global; set once. `--all` always re-synthesizes in full.

## Inspect

- `mfz thread list` — known threads, each with its destination and session count.
- `mfz thread destinations` — resolved backup repos; a leading `*` marks the default.
- `mfz thread runs` — live run state across all threads, including crashed runs; add `--thread <slug>` for that thread's durable cost ledger, or `mfz thread runs <run-id> --trace` for a run's raw trace.

## Output

Every read command prints **condensed text** by default — built for reading and for piping. Add `--json` for structured output to chain commands or filter with `jq`.

## Cost levers

Model and effort trade cost against fidelity: `create` pins per-thread defaults, and `--harness` / `--synth-model` / `--effort` on `discover` and `ingest` override per run.
