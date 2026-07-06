## Context

The `mfz thread` pipeline (mfz-thread change, implemented) is entirely pull-based:
`discover` judges sessions against a free-text prompt and throws the judgment away;
`ingest`/`refresh` re-synthesize when a human names a thread. Nothing watches the host
stores, and no judgment is persisted anywhere. The pieces a proactive detector needs
already exist elsewhere: cross-harness session enumeration with cheap timestamps was
built for backup (`listClaudeItems`/`listOpencodeItems`, `needsUpload` +
`FRESHNESS_MARGIN_MS`), exact tail signatures and drift classification exist in
`src/thread/watermark.ts`, and the containerized read-only dispatch primitive exists in
`src/thread/dispatch.ts`/`runner.ts`. This design composes them.

The design was grilled across two sessions; the domain language (sweep, triage,
verdict, pass, reject, pending proposal, baseline, quiescence gate, source signal,
review) is recorded in the repo `CONTEXT.md` glossary and used here without
re-definition.

## Goals / Non-Goals

**Goals:**
- Sweep as a pure detector/judge: spends tokens only on judgment (cheap-model triage),
  writes only machine-local state, never touches a thread repo.
- Every triage judgment persisted and never re-bought while its pins (session
  watermark, charter hash) are unchanged.
- A review surface (`pending`/`reject`/`conclude`) where accepting is the existing
  `ingest` — no duplicate verb, no second thread-write path.
- All heavy work (refresh, ingest, digest regen, push) stays human-initiated through
  existing commands.

**Non-Goals:**
- No daemon, no session-end hooks, no scheduler — sweep is a command; external
  schedulers can call it (composition, not design).
- No auto-accept and no auto-refresh flags in v1 (additive later; the reverse is not).
- No backfill mode: triage never looks behind the baseline. Deep history is
  `discover` + explicit `ingest` (deliberate, in-sitting).
- Discover is unchanged: pre-thread drafting, ephemeral output, no ledger writes.
- No cross-machine ledger sync; the ledger describes this machine's stores.

## Decisions

### Sweep is detect + triage + report; existing verbs do all thread writes

A detector that also runs gather/synth/digest/push per stale thread is the whole
pipeline on a timer, and it made approval asymmetric (ask for proposals, silent-write
for refreshes). Instead sweep reports drift and names the existing command
(`refresh --thread <slug>`); `ingest` retires proposals. Alternative rejected:
auto-refresh during sweep (original Q3 lean) — superseded for UX consistency, sweep
latency, and because `refresh` already exists.

### Candidates from cheap signals diffed against existing pins — no new watermark store

"Where we left off" already lives in two places: member watermarks in thread manifests
and verdicts in the ledger. A third per-session record would drift. Sweep enumerates
cheap source signals (Claude file mtime via the backup lister; OpenCode
`max(time_updated, latest message time_created)`), and a session is a candidate when
it has no pin for some thread, its verdict's charter hash is stale, or its signal is
newer than its pin time minus the backup's freshness margin. Only candidates get an
exact `readWatermark` + `classifyWatermark`. A single machine-local `last_sweep_at`
exists for reporting only, never correctness. Subagent sessions are excluded at
enumeration (Claude `/subagents/` relPath filter; OpenCode `parent_id IS NULL`).

### One triage dispatch per candidate session, all applicable charters in one pass

Cost scales with new sessions, not thread count: the transcript read (cheap model,
read-only mounts, `agent-sessions` skill — same shape as gather) is the expensive
part; charters are a page of prose each. The dispatch returns one fit/no-fit + reason
per charter as structured text; TypeScript fans it into per-(session, thread) verdict
rows. Triage returns judgments only — no dossiers (dossiers are charter-lensed and
belong to ingest, which re-gathers at the accepted watermark). Alternative rejected:
per session×thread dispatches (N×M transcript re-reads).

### Verdict ledger: machine-local, pinned, three grades

Rows keyed `(source:id, thread-slug)` holding: verdict (`fits` / `no_fit` /
`pass` / `reject`), reason, `judged_at`, the session watermark at judgment, and the
charter hash (sha256 of the manifest charter string, computed on demand — not stored
in the manifest). Voiding rules: agent verdicts (`fits`/`no_fit`) and human `pass`
void when watermark or charter hash moves; human `reject` survives both until a human
overrides (explicit `ingest` or clearing). A pending proposal is derived, never
stored: `fits ∧ not a member ∧ no human verdict`. Location:
`~/.mindframe-z/thread-sweep/` (sibling of `thread-runs/`; the `threads/` root is the
git-pushed store — the mfz-thread design.md's `threads/runs/` path is stale, the
implementation moved run state to `thread-runs/`). Shape: `ledger.json` +
`sweep.json` (`baseline_at`, `last_sweep_at`, `last_review_at`) — single-writer
(sweep/review commands), read-modify-write like `recordSessions`.

### Baseline: staked at first sweep, gates triage only, never advances

First sweep with no `sweep.json` writes `baseline_at = now` and proceeds — no flag,
no prompt (the CLI's primary caller is an agent; an interactive prompt or a
first-run-only flag are both wrong shapes). Sessions whose signal predates the
baseline are never triage candidates; member refresh detection is ungated by it. New
threads need no special case: post-baseline sessions have no verdict against a new
charter, so the "no pin" rule triages them on the next sweep automatically.
Alternatives rejected: full backfill (triages years of noise); look-back prompt/flag
(interaction shape); rolling window (a session can age out while deferred — the
cursor bug).

### Quiescence gate: default 30 minutes, informative, three doors out

Sweep only triages (and reports member staleness for) sessions with no activity for
the window; hot sessions are named in the report as deferred, never silently skipped.
Window from profile `thread.defaults` (minutes; `0` disables); `--include-hot` lifts
it per run; `ingest`/`refresh` are always ungated. Hot verdicts would void on the
next message — the gate avoids buying them. Deferral is safe with pin-based
candidacy: a deferred session stays unpinned, so it is re-detected next sweep (this
is why there is no sweep cursor).

### Review: pending is a derived view; conclude writes passes; reject is the rare sticky no

`pending` is a free read (no dispatch) listing open proposals with reason, target
thread, and staleness (verdict already void → flagged, not dropped). `conclude` ends
a review: every proposal still pending becomes a human `pass` pinned at its current
watermark, and `last_review_at` is stamped. Reviewing without concluding records
nothing — half-finished reviews leave the queue intact. `reject` exists for the one
case `pass` cannot handle: a growing session that keeps re-proposing. Accepting is
`ingest` (membership retires the proposal structurally). The review workflow itself
(sweep → pending → ingest/reject → conclude) lives in the `threads` skill, not the
CLI — the CLI stays primitive verbs an agent composes.

### Triage model resolution follows the existing defaults chain

`resolveSynthesisDefaults` gains a `triage` role (cheap tier, like gather's default)
resolved profile `thread.defaults.triage` → per-run flag. No manifest-level override:
triage is cross-thread by nature, so a per-thread synthesis override makes no sense.

## Risks / Trade-offs

- [Triage misjudges fit] → verdicts are advisory routing, not synthesis; the human
  accept gate is downstream, and `discover`/explicit `ingest` bypass triage entirely.
- [Thread freshness now depends on review cadence] → accepted: for durable
  cross-session memory, lag is correct; sweep reports drift so staleness is visible.
- [Claude mtime is a heuristic (backups, hydration, touch)] → false-positive
  candidates are corrected by the exact watermark comparison; false negatives are
  effectively impossible for append-only stores; freshness margin reused from backup.
- [Ledger grows unbounded] → rows are tiny JSON; voided rows are overwritten in
  place on re-triage, not appended. Revisit only if real-world size ever matters.
- [Structured triage output parsing] → same mitigation as discover/gather: strict
  persona output discipline plus a TS-side parser that tolerates and reports
  malformed lines (unparseable → no verdict written, named in the report).
- [Concurrent sweep and review mutate the ledger] → same posture as the rest of the
  CLI (single-user, single-writer read-modify-write); `pid`-style liveness is already
  the pattern if contention ever shows up.

## Migration Plan

Purely additive: new commands, new machine-local root, one new persona and defaults
entry, a skill section. No manifest schema change, no data migration. Rollback =
remove the commands; the ledger directory is inert state that can be deleted.

## Open Questions

- Exact triage dispatch output grammar (per-charter verdict lines) — settle during
  implementation against the discover persona's `source:id reason` precedent.
- Whether `pending`/`conclude` need `--thread` scoping in v1 or operate globally
  (lean: global; per-thread filtering is a `--json` + jq concern first).
