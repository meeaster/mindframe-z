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

   Returns candidate session ids, each with its source and a one-line rationale. Done when you have the ids to ingest, or discovery reports no match.

2. **Create the thread** (first time only). `mfz thread create <slug> --charter "<lens>" [--dest <destination>]`

   The **charter** is the synthesis lens — what this thread filters for and emphasizes; spend care on it, since every synthesis reads through it. Done when the command reports the thread created; skip when the thread already exists.

3. **Ingest.** `mfz thread ingest <id...> --thread <slug>`

   Runs gather → synthesize → digest and commits the result to the thread's destination repo. Add `--no-push` to commit locally without pushing. Done when the run shows complete in `mfz thread runs --thread <slug>`.

## Inspect

- `mfz thread list` — known threads, each with its destination and session count.
- `mfz thread destinations` — resolved backup repos; a leading `*` marks the default.
- `mfz thread runs` — live run state across all threads, including crashed runs; add `--thread <slug>` for that thread's durable cost ledger, or `mfz thread runs <run-id> --trace` for a run's raw trace.

## Output

Every read command prints **condensed text** by default — built for reading and for piping. Add `--json` for structured output to chain commands or filter with `jq`.

## Cost levers

Model and effort trade cost against fidelity: `create` pins per-thread defaults, and `--harness` / `--synth-model` / `--effort` on `discover` and `ingest` override per run.
