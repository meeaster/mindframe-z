## Context

The `thread-log` skill already implements a working two-stage ingestion pipeline:
a cheap Haiku *gatherer* reads a full transcript and returns a text dossier; a capable
*synthesizer* reads only that dossier and writes a bucketed session file; `log.md` and
`digest.md` are regenerated as views. Critically, the skill's worker handoff is
*already* a headless dispatch — `claude -p "/thread-log ingest …" --output-format json`
— and the plan phase already parses that JSON to record `runs[]` cost telemetry. The
hard part the design thread feared ("drive a subscription harness as the reasoner,
which no off-the-shelf engine can do") is therefore already proven; it is just
constructed *inside* Claude Code by a fat plan phase.

This change re-homes that orchestration into TypeScript. The plan phase (discovery,
membership, handoff, telemetry) and the deterministic transforms (watermarks, `log.md`
regeneration, run records) move into `mfz thread`. The judgment steps (gather,
synthesize, digest) stay LLM dispatches — but now as isolated container runs that
`mfz` drives, capturing cost from each. The existing skill is kept as-is, the working
in-harness path, so this change carries zero risk to what works.

## Goals / Non-Goals

**Goals:**
- A `mfz thread` CLI that creates, discovers, ingests, reads, and reports on threads.
- Containerized, read-only agent dispatch for both Claude Code and OpenCode behind a
  runner port; TypeScript owns all disk writes.
- Observability as a first-class, cross-cutting concern: per-dispatch cost/usage, a
  durable per-thread ledger, machine-local raw traces, and a live run view.
- Sensitive thread data stored separately from the public `mindframe-z` config, in
  per-destination git repositories backed up on every ingest.
- The existing `thread-log` skill left byte-for-byte untouched.

**Non-Goals (deferred, with constraints recorded):**
- **Thread relationships** (links, parent/child) — deferred until a real split or
  cross-reference forces the shape.
- **Higher-level grouping** above threads and thread compaction — deferred.
- **ChatGPT ingestion** — designed-for via the source-adapter shape, built in v2+.
- **Eval suite** — a post-v1 dev-time regression suite that will answer whether a
  session-file-derived digest is faithful; wraps the CLI when built.
- **Dossier-fed batch-fidelity digest** — an escape hatch (below); v1 builds the
  digest from session files only.
- **LLM-assisted charter drafting** — charters are authored by hand in v1.
- **MCP-server interface, UI, and automation** — designed-for over the same core,
  built later.
- **Cross-machine session refresh** and the canonical shared work/personal
  destination — v1 is single-machine; provenance recording deferred with it.
- **Reusing `mfz sandbox` / Agent Vault** for dispatch isolation — the developer
  sandbox is a different shape (interactive workspace session, not a headless
  prompt→text dispatch). v1 uses the lighter executor; Agent Vault can slot behind the
  runner port later.

## Key Decisions

### Re-home the plan phase to TS; keep the skill untouched, alongside

The skill is not modified or wrapped. `mfz thread` is a parallel reimplementation of
the orchestration in TypeScript; the skill remains the standalone in-Claude-Code path.
This honors "build the new core separately alongside, zero risk to what works."

### Dispatched agents are pure read-only text-returners (Option A)

Following the x-tweet-ingestion pattern, dispatched agents run with write/edit tools
**denied** and return their result as text on stdout. The gatherer returns a dossier;
the synthesizer returns the session-file body; the digest dispatch returns `digest.md`.
TypeScript parses cost from the JSON stream and performs **every** disk write —
session files, watermarks, `log.md`, `digest.md`, run records, git commits. This makes
each dispatch trivially observable (we capture exactly what it produced) and trivially
sandboxable (read-only mount, no write-exfiltration path), and it puts all determinism
in TS where it belongs.

*Escape hatch (deferred):* Option B — let the synthesizer write into a mounted
workspace — is preserved as a possible future setting, not built.

### Lightweight container runner, both harnesses, behind a port

Dispatch uses a `docker run --rm -i` executor against a single tools image (Debian
slim + `claude` + `opencode` + `jq`), with the prompt on stdin and `--output-format
stream-json` / `--format json` parsed for cost/usage. Credentials are mounted
**read-only** from the host (`~/.claude/.credentials.json`, opencode `auth.json`);
subscription auth only (no `ANTHROPIC_API_KEY`). The runner is a port with `claude` and
`opencode` adapters, so a stronger Agent-Vault-backed runner can replace it later
without touching the pipeline. This is intentionally **separate** from `mfz sandbox`,
which serves interactive developer sessions.

### Three instruction layers: persona, skill, prompt

Each dispatched agent is assembled from:
- **Persona** (Claude Code `--system-prompt`; OpenCode prompt prefix with a fixed
  read-only `--agent`) — *who the agent is, its stance, hard guardrails, output
  discipline*. Invariant per role. Uses a leading word (`gatherer`, `synthesizer`).
- **Skill** (loaded) — *what it knows / the artifact spec*. Explore + gather reuse the
  existing `claude-code-sessions` / `opencode-sessions` reader skills. Synthesize loads
  the new `thread-contract` skill (the bucket/format spec). Skills are portable across
  both harnesses.
- **Prompt** (stdin) — *the variable per-run data*: session locator, dossier text, and
  thread charter (the lens). The watermark is a per-session ISO timestamp recorded in
  the manifest, not a transcript offset; gather always reads the full session.

The persona/skill line is drawn by *disposition vs. artifact*: how the agent behaves →
persona; the structure of what it returns → skill.

### The ingestion pipeline

```
mfz thread ingest <ids…> --thread <slug>

  per session (parallel):
    ① gather   HAIKU    · loads reader skill · reads transcript → dossier text
    ② synth    CAPABLE  · loads thread-contract skill · reads ONLY dossier → session md
    ③ TS writes sessions/<id>.md                                 (deterministic)
  ④ TS advances every session's high_water in one batched manifest write (deterministic)
  ⑤ TS regenerates log.md (merge buckets, sort by timestamp)    (deterministic)
  ⑥ digest   CAPABLE   · loads thread-contract · reads ALL session files → digest.md
  ⑦ TS writes digest.md, persists dossiers to the run folder, appends runs.json, git commit + push (deterministic)
```

- **Gather and synth stay two dispatches** — the cheap model absorbs the cost of
  *reading* the transcript; the capable model reads only the small dossier. Folding
  them re-bills full transcripts on the expensive model.
- **Digest is one dispatch per run**, after all sessions, reading the distilled
  (cheap) session files.

### Digest is built from session files, not dossiers (Option C)

Dossiers are transient (they exist only during a run); the system is incremental
(`high_water`). On any later run the old dossiers are gone, so the digest *must* be a
function of the durable session files or it is not reproducible. The session file is
the single source of truth; the digest is a view of it. Information loss is fixed by a
richer session-file contract, not by feeding dossiers to the digest.

*Escape hatch (deferred):* a batch-fidelity mode where a run's digest also sees the
fresh in-memory dossiers for just-added sessions. Cheap to add (persist dossiers, pass
them in) but costs reproducibility; gated on what the eval suite shows.

### Storage: per-destination git repos, composed at runtime

Threads are sensitive; `mindframe-z` is public. `thread.destinations` are declared
across the **profile** (public defaults, e.g. a personal threads repo in `base`) and
**machine config** (private/work repos), and **composed at runtime** by reading both
resolved manifests — no rendered file, no `apply` dependency, always fresh. Each
destination is a git repo; a thread is routed to one at `create`, recorded in its
manifest, and `ingest` commits and pushes there. Local working copies live under
`~/.mindframe-z/threads/<destination>/<slug>/`.

The per-thread `manifest.json` holds slow-changing identity (charter, membership,
watermarks, synthesis config); the per-thread `runs.json` holds the append-only run +
cost ledger. Both are pushed.

### Observability: two kinds of state

- **Durable history** (per-thread, pushed): `runs.json` — one record per ingest run
  with a per-dispatch breakdown (role, model, cost, tokens, ms) and a total. This is
  also the "which model did which action" history, and it travels with the thread.
- **Operational state** (machine-local, never pushed): one folder per run under
  `~/.mindframe-z/threads/runs/<run-id>/` containing `status.json`
  (thread, mode, pid, `current_step`, started/finished, cost) and the raw `*.jsonl`
  dispatch traces; plus a rolling `cli.log`.

`mfz thread runs` globs `runs/*/status.json` for a cross-thread operational view
without reading any thread; `current_step` gives live introspection; `pid` separates
"running" from "crashed". Raw traces stay local because they quote session content —
the same rule the design thread set for raw transcripts.

No single shared state file: it is a write-contention magnet and duplicates
per-run/per-thread state. State lives where it is produced; cross-cutting views glob.

### Config layering and output convention

Model / harness / effort resolve **profile `thread.defaults` → manifest `synthesis`
override → per-run flag**. Every read command (`discover`, `list`, `destinations`,
`runs`) defaults to **condensed, agent-optimized text** and accepts `--json` for
structured, jq-able output, because an interactive agent driving the CLI via the
`threads` skill is the primary caller.

## Risks

- **Session-file fidelity** — if the contract drops rationale, the digest degrades.
  Mitigated by investing in the `thread-contract` skill and validated later by the
  eval suite; the batch-fidelity escape hatch remains if needed.
- **Clean stdout discipline** — Option A requires the synthesizer to emit only the file
  body. Mitigated by the persona's output discipline and parsing the JSON envelope, not
  raw stdout, for content.
- **Push on every ingest** touches the network; a failed push is recoverable (commit is
  local) and `--no-push` is available.
