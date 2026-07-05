## Why

The `thread-log` skill — an immutable, cited cross-session work record with a
regenerated current-state digest — works today, but it lives entirely inside Claude
Code. Discovery, membership confirmation, the headless worker handoff, cost
telemetry, and view regeneration are all fused into one in-harness skill run. That
locks the system to a single harness, hides cost and observability, keeps sensitive
thread data in an unrouted, unbacked-up `~/.claude/threads`, and makes automation
impossible.

The design thread (`thread-log-system`) settled the target: evolve thread-log into a
**CLI-driven orchestration layer inside mindframe-z** that drives subscription-harness
agents headlessly, owns the deterministic work in TypeScript, and runs the judgment
steps as isolated container dispatches. This change builds that v1 — observability,
backup, and containerized dispatch — while leaving the existing skill **completely
untouched** as the working in-Claude-Code path.

## What Changes

- Add a `mfz thread` command surface: `create` (deterministic, sets charter +
  destination), `discover` (prompt-driven agent search for candidate sessions),
  `ingest` (the gather→synthesize pipeline), `list` / `show` (read a thread),
  `runs` (observability), and `destinations` (resolved backup targets).
- Drive ingestion as **container dispatches** of Claude Code *and* OpenCode running
  headless behind a runner port. Dispatched agents are **read-only and return text**;
  TypeScript owns every disk write. This is a lightweight `docker run` executor,
  separate from the developer `mfz sandbox`.
- Split each dispatched agent's instructions across three layers: a thin **persona**
  (disposition + guardrails), a loaded **skill** (artifact spec / how-to-read), and a
  per-run **prompt** (the variable data). Use the `agent-sessions` reader skill for
  explore + gather; author a new **thread-contract** skill for the synthesizer.
- Author a new slim **threads** skill that teaches an interactive agent how to operate
  the `mfz thread` CLI — the new entry point that the demoted, now user-invoked
  `thread-log` skill's in-harness role is migrating toward.
- Store threads in **per-destination git repositories**, composed at runtime from
  `thread.destinations` declared across the profile (public defaults) and machine
  config (private/work). `ingest` commits and pushes. Threads stay sensitive and
  separate from the public `mindframe-z` config.
- Capture observability as **two kinds of state**: a durable per-thread `runs.json`
  cost ledger that travels with the thread, and machine-local per-run folders
  (`status.json` + raw JSONL traces) plus a `cli.log` that never leave the machine.
- Make every read command default to **condensed, agent-optimized output** with an
  optional `--json` flag for structured, jq-able results.

## Capabilities

### New Capabilities
- `threads`: the `mfz thread` command surface and the condensed-default / `--json`
  output convention shared by every read command.
- `thread-create`: deterministic thread creation — author the charter (the synthesis
  lens), pin the backup destination, and layer per-thread synthesis config over
  profile defaults into the manifest.
- `thread-discover`: prompt-driven, agent-judged search that returns candidate
  sessions matching a free-text description of the work.
- `thread-ingest`: the ingestion pipeline — parallel per-session Haiku gather →
  capable synthesize → TS write + watermark, deterministic `log.md` regeneration, and
  one capable digest dispatch built from the session files.
- `thread-dispatch`: the lightweight container runner port, the Claude Code and
  OpenCode headless adapters, the read-only text-returning agent contract, the
  persona/skill/prompt layering, and model/effort resolution.
- `thread-storage`: per-destination git repositories, runtime composition of
  destinations from profile + machine config, commit-and-push backup, and the
  manifest (charter + membership + watermarks + synthesis config) vs. `runs.json`
  file split.
- `thread-observability`: the two-kinds-of-state model — durable per-thread
  `runs.json` (pushed) and machine-local per-run folders + `cli.log` (never pushed) —
  and the `mfz thread runs` operational view.
- `thread-skills`: the new `threads` operator skill and `thread-contract` synthesizer
  skill, the reuse of existing reader skills for explore + gather, and the demotion of
  the existing `thread-log` skill to user-invoked.

## Impact

- New CLI surface in `src/cli/mfz.ts`; new thread orchestration module under
  `src/thread/` (sibling to `src/sandbox/`), including the runner port, harness
  adapters, pipeline, storage, and observability.
- New container image (`Dockerfile.tools`-style: Debian slim + `claude` + `opencode` +
  `jq`) built and invoked by the runner; credentials mounted read-only.
- Profile schema (`src/core/manifests.ts`) gains `thread.defaults`; machine schema
  gains `thread.destinations`; `schemas/*.schema.json` regenerated; example configs
  updated.
- New skills authored under `skills/` (`threads`, `thread-contract`); the existing
  `skills/thread-log/` is demoted to user-invoked (`disable-model-invocation: true`,
  description trimmed to a human-facing one-liner).
- New machine-local state under `~/.mindframe-z/threads/` (per-destination clones,
  per-run folders, `cli.log`).
- Defers (written down, not built): thread relationships, higher-level grouping,
  ChatGPT ingestion, the dev-time eval suite, dossier-fed batch-fidelity digests,
  LLM-assisted charter drafting, the MCP-server interface, the UI/automation layer,
  and cross-machine session refresh.
