## 1. Schemas: destinations and synthesis defaults

- [x] 1.1 Add `thread.destinations` (name, repo, default) to the **machine** config Zod schema in `src/core/manifests.ts`
- [x] 1.2 Add `thread.destinations` and `thread.defaults` (discover, gather, synthesize model IDs in `harness:model@effort` format, plus `session_sources`) to the **profile** schema in `src/core/manifests.ts`
- [x] 1.3 Add the per-thread `manifest.json` schema (charter, destination, membership ledger, per-session `high_water`, `synthesis` override) and the `runs.json` schema (append-only run records with per-dispatch breakdown)
- [x] 1.4 Regenerate `schemas/*.schema.json` via `pnpm schemas`; update `machine-config.example.yml` and `profiles/base/profile.yml` with the new fields
- [x] 1.5 Add path helpers for the local thread store (`~/.mindframe-z/threads/<slug>/`), destination working copies (`~/.mindframe-z/thread-destinations/<name>/`), and the run-folder/`cli.log` roots in `src/core/paths.ts`

## 2. Destination resolution and storage

- [x] 2.1 Add `src/thread/storage.ts` that composes destinations from resolved profile + machine config at runtime (union, dedupe, default selection)
- [x] 2.2 Implement local working-copy preparation per destination (clone if a remote repo, init if absent) and thread routing
- [x] 2.3 Implement manifest + runs.json read/write helpers and watermark advancement (TS is the sole writer)
- [x] 2.4 Implement commit-and-push on ingest with a `--no-push` opt-out. Extract shared `pushIfRemote` helper
- [x] 2.5 Implement `syncThreadDestination` (fetch, pull --rebase --autostash, copy back with `manifest.json` guard)
- [x] 2.6 Implement `deleteThreadFromDestination` (remove from destination repo, commit deletion, reuse `pushIfRemote`)
- [x] 2.7 Implement qualified `source:id` parsing (`parseSessionId`, `sessionSource`, `bareSessionId`) with `ses_` heuristic fallback
- [x] 2.8 Implement `resolveSessionSources` (flag override or profile default for discover)
- [x] 2.9 Tests: destination composition precedence, manifest/runs split, watermark self-healing, sync with remote + empty remote, delete from destination

## 3. Dispatch runner port and harness adapters

- [x] 3.1 Define the `AgentRunner` port in `src/thread/runner.ts` (assemble persona + skills + prompt, run, return parsed result with cost/usage/duration)
- [x] 3.2 Implement the lightweight `docker run --rm -i` executor with read-only credential mounts (subscription auth only; refuse `ANTHROPIC_API_KEY`), prompt on stdin
- [x] 3.3 Implement the Claude Code adapter (`claude -p --output-format stream-json`, write/edit denied, model/effort) and parse the JSON envelope for cost/usage
- [x] 3.4 Implement the OpenCode adapter (`opencode run --format json`, write/edit denied, model/variant) and parse cost/usage
- [x] 3.5 Add the tools image (`Dockerfile.tools`: Debian slim + pinned `claude` + `opencode` + `jq` + `sqlite3`) and a build/ensure step
- [x] 3.6 Implement unified `harness:model@effort` model resolution (`parseModelId`, `resolveSynthesisDefaults`) with precedence: run flag > manifest synthesis > profile defaults
- [x] 3.7 Tests with a fake runner seam: layering assembly, model resolution precedence, write-denial assertion, no-API-key assertion

## 4. Personas and the new skills

- [x] 4.1 Author the gather, synthesize, digest, and explore personas (thin; leading words; output discipline for text-return)
- [x] 4.2 Author the new `skills/thread-contract/` skill (buckets, digest sections, citation format, session-file layout, append/supersede rules) — the artifact spec
- [x] 4.3 Wire explore + gather dispatches to load the existing `claude-code-sessions` / `opencode-sessions` reader skills, dynamically selected based on `sessionSources`
- [x] 4.4 Author the new slim `skills/threads/` operator skill (load-into-context branch first, then build/refresh, sync, delete), and demote `skills/thread-log/` to user-invoked
- [x] 4.5 Register both new skills in `shared/skills.yml` and profile skill targets; assert `skills/thread-log/` is untouched
- [x] 4.6 Update discover persona to output qualified `source:id` candidates

## 5. Create and discover commands

- [x] 5.1 Implement `mfz thread create <slug> --dest <d> [--discover-model|--gather-model|--synthesize-model <harness:model@effort>]` (deterministic, no dispatch; writes manifest + charter; refuses duplicates; prepares working copy)
- [x] 5.2 Implement `mfz thread discover "<prompt>" [--sources <comma-sep>] [--json]` as a containerized agent dispatch loading reader skills for the active sources, judging relevance against the prompt, returning qualified `source:id` candidates
- [x] 5.3 Tests: create writes/pins/refuses-duplicate and performs no dispatch; discover returns prompt-matched candidates with qualified source:id + rationale; --sources filtering

## 6. Ingest pipeline

- [x] 6.1 Implement `mfz thread ingest <ids…> --thread <slug>`: require existing thread/charter; parse qualified or bare session ids
- [x] 6.2 Run per-session gather (Haiku) → synthesize (capable) dispatches in parallel; TS writes each `sessions/<source>-<bareId>.md`, then advances `high_water`
- [x] 6.3 Regenerate `log.md` deterministically (merge buckets, sort by timestamp; no dispatch)
- [x] 6.4 Run one capable digest dispatch reading the session files; TS writes `digest.md`
- [x] 6.5 Append the run record to `runs.json`; commit and push (unless `--no-push`). Store bare id + source separately in the manifest ledger
- [x] 6.6 Persist this run's dossiers to the run folder so the deferred batch-fidelity digest mode stays cheap to add later
- [x] 6.7 Tests: two-stage split (synth never sees transcript), parallelism, deterministic log, single digest per run from session files, qualified id parsing, session filename convention

## 7. Observability and read commands

- [x] 7.1 Implement per-run folder lifecycle: create `status.json`, update `current_step` across pipeline steps, record pid, finalize on completion
- [x] 7.2 Persist raw JSONL dispatch traces under the run folder (machine-local, never pushed)
- [x] 7.3 Implement `cli.log` appending for every `mfz thread` invocation
- [x] 7.4 Implement `mfz thread runs [--thread <slug>] [<run-id> [--trace]]` globbing run folders; distinguish running vs crashed by pid liveness
- [x] 7.5 Implement `mfz thread list` and `mfz thread show <slug>` (outputs `digest.md`) and `mfz thread destinations`
- [x] 7.6 Implement the condensed-default / `--json` output convention shared by discover, list, destinations, and runs
- [x] 7.7 Tests: cross-thread runs view without reading threads, crashed-run detection, JSON round-trips condensed output

## 8. Delete, sync, and lifecycle commands

- [x] 8.1 Implement `mfz thread delete <slug> [--no-push]` (remove local thread + destination copy, commit deletion)
- [x] 8.2 Implement `mfz thread sync [--all] [<slug>...]` (prepare destination if needed, fetch, pull --rebase --autostash, copy committed threads back to store)
- [x] 8.3 Tests: delete reports slug, delete skips uncommitted destination, sync with no remote, sync with remote

## 9. CLI wiring, validation, and docs

- [x] 9.1 Register the `mfz thread` command and subcommands (create, discover, ingest, list, show, runs, destinations, delete, sync) in `src/cli/mfz.ts`, importing run* functions from `src/thread/cli.ts` (mirroring the sandbox module pattern)
- [x] 9.2 Add `testing` destination with GitHub remote to `profiles/base/profile.yml` for end-to-end remote testing
- [x] 9.3 Run `pnpm check` (lint, fmt, build, test) green
- [x] 9.4 Update `ARCHITECTURE.md` and `README.md` with the `mfz thread` surface, the storage model, and the deferred-features list
- [x] 9.5 Update thread `threads` operator skill with sync-before-operations workflow and delete command
