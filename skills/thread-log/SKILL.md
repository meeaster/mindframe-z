---
name: thread-log
description: Read, create, or update a thread-log — a cited, append-only record of work spanning many Claude Code and OpenCode sessions, with a regenerated current-state digest. Use when the user asks to continue, resume, or catch up on prior multi-session work, references an existing thread, asks to start or update a thread-log, or asks to capture the current session into a thread.
---

# Thread-log

A unit of work — an investigation, a feature, a design — sprawls across many sessions in two tools, and the decisions, learnings, mistakes, and the user's own **intent** and **vision** scatter with it. A **thread-log** gathers that scatter into one place: an append-only **log** of cited evidence, and a **digest** regenerated from it that says where the thread stands now — current state, plus the **why** behind the work and the **vision** of where it is heading.

The model is **event sourcing**. The sessions are the immutable event source. The log is the append-only projection — never rewritten; when something is invalidated, the invalidation is *appended*. The digest is the materialized current-state view — disposable, rebuilt from the log every run.

This skill **reads sessions only through** the [`claude-code-sessions`](../claude-code-sessions/SKILL.md) and [`opencode-sessions`](../opencode-sessions/SKILL.md) skills. It does not reimplement their storage knowledge — load the relevant one **with the Skill tool, never by Read-ing its `SKILL.md`** (the links above are references, not a fetch instruction), and use its recipes. This holds in the main session as much as in a subagent. It only ever **reads** sessions.

## Modes

First decide which of five the request is:

- **Read** — the default whenever the user references an existing thread (continue, resume, catch up, "the X thread"). Locate `~/.claude/threads/<slug>/`, read `digest.md` into context, and stop. Consult `log.md` only when the user needs the detail behind a specific point. Cheap; spawns nothing; fire it freely. **Read depth scales with purpose:** to *resume or catch up*, the digest alone is enough — stop there. But to **implement** an area of the thread, the digest is the **index, not the payload** — it compresses away the exact queries, gotchas, and full reasoning that the implementing session needs. Follow the citations on the relevant decisions and Direction items into their `sessions/<id>.md` and read those for the area you are about to build. (`log.md` is for tracing *when* something happened; the session file is for the *detail behind it*.)
- **Create** — no thread exists for this work yet. Scaffold the files (below) and **plan** the ingest.
- **Update** — fold newly-discovered sessions into an existing thread. **Plan** the ingest.
- **Capture-self** — fold *the session you are running inside* into a thread, on the user's explicit say-so. A **plan** with a pre-given work-list — see [Capture-self](#capture-self). **User-invoked only:** never offer it and never remind the user to log; capturing is the user's call, not yours.
- **Ingest (the worker)** — extract sessions and regenerate the views from a given work-list. **A prompt beginning `ingest <slug>: …` is this mode, unconditionally** — never Create/Update. **Not user-facing**: the plan phase launches it headless. See the [Worker phase](#ingest-pipeline-plan-then-ingest).

**Create, Update, and Capture-self are the *plan* phase; Ingest is the *worker* phase** — the pipeline is split across two processes (below). The plan phase spends a capable model on judgment (which sessions, where the charter lands) and a Haiku Explorer on the legwork; the worker does the token-heavy extraction in isolation. Both spawn subagents and read sessions, so confirm the user wants to build or refresh a thread before planning.

**Update is incremental by default:** the work-list is only what is new — sessions never ruled on, and content past each member's `high_water`. Only when the user **explicitly asks for a full refresh** does the work-list become *every* member, re-read from offset 0 ignoring watermarks (the schema and extraction contract have improved and the user wants the whole history re-read against it). A full refresh re-reads but still **appends** — it never discards the existing session files until the fresh extraction replaces them.

## Files

A thread lives at `~/.claude/threads/<slug>/`, in three tiers — **authored** sources and **regenerated** views. The exact shape of every file is the file contract in [ARTIFACTS.md](ARTIFACTS.md); the roles below are the map.

| File | Tier | Role |
| ---- | ---- | ---- |
| `manifest.json` | authored | The **charter** (scope), the membership ledger — `sessions[]` (included, each with a `high_water` offset) and `excluded[]` (rejected, with a reason) — `read_subagents`, the thread's **floor** for subagent depth (default off, on for meta/process threads), and `runs[]`, the append-only run telemetry. A session that **exercises a skill** reads deep regardless of the floor — see [INGEST.md](INGEST.md) worker step 4. |
| `sessions/<id>.md` | authored | One **per-session extraction** — the deep, durable detail bucketed, every line timestamped and cited. The event store. **Never reduced**: when a session grows, this file is updated, not summarized away. Its frontmatter carries provenance — `title`, `thread_relevance`, `gaps`, and **`extracted_by`**. |
| `log.md` | regenerated | The chronological **event stream** across all sessions — flat, timestamped, deduplicated. Atomic references, not detail. |
| `digest.md` | regenerated | Current-state resume context: state, ASCII design diagram, key decisions, open questions, **Intent** (the why), **Vision** (where it's heading), Direction, and Sources. |

The split exists so detail is never lost. The session files are the single source of truth and hold the full extraction; `log.md` and `digest.md` are cheap derived views regenerated from them. If a synthesis ever drops something valuable, the source detail is still in the session file, untouched. Immutability of the log comes from sessions being immutable plus timestamp ordering — not from manual append discipline.

The **charter** does triple duty: the human-readable "what this thread is", the criterion the confirm step judges new candidates against (in scope, and explicitly out), *and* a statement of the thread's **purpose** — why it exists and what it is for. Purpose is a **lens**, not just scope: it shapes how every run reads and extracts. A thread that **logs a unit of work** — a design worked through, a feature built (e.g. `datadog-cost`) — is mined for decisions, learnings, and state. A thread whose purpose is **feedback on the process itself** — how skills are used, what to improve (e.g. `thread-log-usage`) — is mined for friction and behavior, and sets `read_subagents: true` to see how the work was actually done. State the purpose so a future run inherits the lens, not just the membership rule.

The **ledger** has two states so membership is decided once. `sessions[]` gives extraction idempotency (re-runs only read a session past its `high_water`); `excluded[]` gives membership idempotency (a rejected session never returns to the approval gate). See [manifest.schema.json](manifest.schema.json) for the shape.

**Manifest ownership is partitioned across the two phases.** The **plan** phase writes the judgment fields — charter, `sessions[]` membership (new members added with `high_water` unset), `excluded[]`, `read_subagents` — and appends the `runs[]` cost record after the worker returns (only the caller sees `total_cost_usd`). The **worker** is the *sole* writer of each session's `high_water`, and only after it has actually read to that offset. So a watermark always reflects a completed read: if the worker dies mid-run, the untouched watermark correctly reads "not yet ingested" and the next run re-reads from where it left off — self-healing, no split-brain over one file.

## Ingest pipeline (plan, then ingest)

The pipeline runs across **two processes**, and **this skill is read by both**. Before doing anything, identify which you are from how you were invoked, then run **only that phase's steps**:

- **You are the plan phase** if a user invoked you (Read / Create / Update / Capture-self). Decide *what* to ingest, then hand off. Run steps 1–3; ignore steps 4–6.
- **You are the worker** if you were invoked headless with a prompt beginning `ingest <slug>: …`. Extract and regenerate from the given work-list. Run steps 4–6; the plan steps are already done — do not repeat them.

The plan phase does as little as possible: it judges and hands off the token-heavy extraction to the worker.

### Plan phase — steps 1–3 (a user invoked you)

1. **Discover.** Spawn a **Haiku Explorer subagent** to run the cross-store discovery sweep in [INGEST.md](INGEST.md). It **retrieves and over-collects** — no relevance filtering — and returns the raw candidate set as text. Relevance is judgment; it stays with you, not the Explorer. (On Capture-self there is no discovery — the work-list is given.)
2. **Confirm membership (approval gate).** Subtract `sessions[]` and `excluded[]` from the candidates, leaving **only sessions never ruled on**. Score each against the charter (cheap: title + first prompt) and present them with a relevance hint. The user approves or rejects each. Approved → `sessions[]`; rejected → `excluded[]` with a reason. Never absorb a session silently. If the approved set stretches the charter, propose a charter update for approval too. **Done when every new candidate has been ruled on and `manifest.json` is written.**
3. **Hand off to the worker.** Launch the slim headless worker (below) via `Bash`, blocking, with an **explicit session-id work-list** — never "all", always the literal ids. Full refresh phrases it `"do a full refresh of these sessions: <ids>"` (read each from offset 0); incremental phrases it `"ingest these new sessions: <ids>"` (read each from its `high_water`). The manifest is the **registry** of what *may* be ingested; the work-list is the **work order** of what to ingest *this run*. Report the worker's verdict from its JSON `result`; surface any `permission_denials`. Then **append a telemetry record to `manifest.json` `runs[]`** — `{at, mode, sessions, model, duration_ms, num_turns, usage, cost_usd}`. Take `model` from the `--model`/`--effort` you launched with (format `<model>-<version> <effort>`, e.g. `opus-4.8 high`); take `duration_ms` (wall-clock), `num_turns`, `usage` (`input`/`output`/`cache_read`/`cache_creation` tokens), and `cost_usd` from the worker's headless JSON result. Only the plan phase sees these (they are in the result returned *to the caller*), so the worker never writes `runs[]`. The telemetry is the thread's **one place for run/process facts** — keep such facts out of the content files (see [ARTIFACTS.md](ARTIFACTS.md)).

   ```bash
   CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
   CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
   CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 \
   CLAUDE_CODE_SUBAGENT_MODEL=haiku \
   claude -p "/thread-log ingest <slug>: <full refresh of these sessions|ingest these new sessions>: <id, id, …>" \
     --model us.anthropic.claude-opus-4-8 \
     --effort high \
     --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
     --add-dir ~/.claude \
     --permission-mode bypassPermissions \
     --output-format json
   ```

   The `CLAUDE_CODE_DISABLE_*` env vars and `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` strip the worker to a **slim runtime** — no CLAUDE.md/AGENTS.md memory, no auto-memory, no bundled skills, no MCP servers — so the fat system prompt is not re-billed as cache-read on every one of the worker's many turns. It keeps your `~/.claude/skills/` (so `thread-log` and the session skills still load via the Skill tool — unlike `--bare`, which would disable them) and the thread store under `--add-dir ~/.claude`. This is the single largest cost lever after synthesis discipline; keep it local — no container, no Vercel sandbox.

### Worker phase — steps 4–6 (invoked headless with `ingest <slug>: …`)

The plan phase is done; do not re-discover, re-confirm, or launch another `claude` process — **whatever model you are**, you do the extraction in *this* process: spawn the Haiku **gatherer**, then synthesize its dossier yourself. **Before extracting, read [ARTIFACTS.md](ARTIFACTS.md) in full** — it is the contract for every file you write (the buckets, the citation form, and the shape of each session file, log, and digest). For each id in the work-list:

4. **Extract — gather, then synthesize.** Run the **two-stage** extraction in [INGEST.md](INGEST.md): a cheap **gatherer** (Haiku, an Explore subagent via the `Agent` tool) reads the whole transcript and returns raw verbatim evidence — every user quote, fork, and test result, over-included on purpose; then **you, the synthesizer**, read only that dossier and write the bucketed `sessions/<id>.md` (**every bullet timestamped and session-id-cited**, to the contract in [ARTIFACTS.md](ARTIFACTS.md)) in a **single write per file** — see the write discipline in [INGEST.md](INGEST.md). The cheap model does the **reading**, you do the **judgment**, and you never pay to read the raw transcript. Stages stay **paired per session**: a session's dossier feeds only its own synthesis, never pooled across sessions. **Done when every work-list session has a complete, cited extraction file.**
5. **Advance.** Stamp each processed session's `high_water` in `manifest.json` to its latest ingested offset — the worker is the *only* writer of watermarks.
6. **Regenerate views.** Rebuild `log.md` and `digest.md` whole from the session files (see [INGEST.md](INGEST.md)), each in a single write. The session files keep the full history; the log orders it; the digest states the present.

## Capture-self

The user, finishing a session they want preserved, asks to capture it. This is a **plan phase with the work-list already given** — the session you are inside, its id from `$CLAUDE_CODE_SESSION_ID`. No discovery, no approval gate: membership is the user's request. Add the id to `sessions[]` if absent (watermark unset), then hand off to the **same slim worker** as a normal Update with a one-id work-list — `"ingest these new sessions: <session-id>"`. Capturing through the worker matters twice over: you **cannot cleanly ingest a session you are inside** (its tail, including this capture turn, is not yet flushed to disk), and routing it through the worker keeps the token-heavy extraction out of *this* session's context.

The worker's `high_water` lands just short of the true end — this capture turn is not flushed yet. That is fine and self-correcting: the next capture is a normal incremental Update that reads only past `high_water` and folds in the tail.

**The fidelity lever is the synthesizer's model** (`--model` on the hand-off command). A weak synthesizer keeps the settled *outcome* but flattens the *why*, the rejected alternatives, and the user's thinking-aloud; a strong one preserves them — which is the whole point of spending on it while confining the cheap Haiku gatherer to retrieval, where it does no judgment. Default to a capable synthesizer; reserve `--effort max` for a foundational session where the last increment of rationale fidelity is worth the cost. `CLAUDE_CODE_SUBAGENT_MODEL=haiku` pins the gatherer (an Explore subagent); **use the bare alias `haiku`, not a full `us.anthropic.claude-haiku-…` id** — the env var resolves aliases, and a full id the deployment does not expose makes every gatherer fail with `400 invalid model identifier`.

## Extraction schema

The buckets every per-session file fills, the citation form, the events-vs-state split, and the superseding rule are the **file contract** in [ARTIFACTS.md](ARTIFACTS.md), alongside the shape of the log and digest. The worker reads it in full before extracting; it is the single source for what each file contains.

## Cross-thread membership (not yet built)

Threads are independent: a session may belong to more than one (e.g. a broad `logging-initiative` thread that subsumes `observability-pipelines`), appearing in each manifest's `sessions[]` and extracted independently per charter. Membership and exclusion are always per-thread.

Because every thread carries a charter, a discovered session can in principle be scored against *all* threads' charters — surfacing "this session looks like it belongs to thread X" during any run. Deferred until more than one thread exists; the charter-per-thread structure is what will make it cheap to add.
