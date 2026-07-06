## Why

New and updated sessions only enter threads today through pull-based, human-remembered
commands (`discover`, `ingest`, `refresh`); nothing watches the host stores, so keeping
threads current is manual toil and LLM judgments made along the way (discover output,
triage reasoning) are thrown away and re-bought. This change adds the proactive half:
a sweep that detects new/changed sessions, triages them against thread charters once,
and a human review flow over the persisted verdicts.

## What Changes

- New `mfz thread sweep`: detects new and changed sessions across both harnesses
  (cheap source signals diffed against existing pins), triages quiet post-baseline
  candidates against every thread charter in one cheap-model dispatch per session,
  and reports — it never writes to a thread repo.
- New machine-local verdict ledger under `~/.mindframe-z/thread-sweep/` (never
  pushed): every triage verdict is pinned to the session watermark and a charter
  hash; agent verdicts and human passes void when a pin moves, human rejects are
  sticky. Tokens spent judging a (session, thread) pair are never re-spent while
  the pair is unchanged.
- New review commands over the ledger: `pending` (list open proposals, free),
  `reject <id> --thread <slug>` (sticky human no), `conclude` (end a review:
  remaining proposals become watermark-pinned passes, review time stamped).
  Accepting a proposal is the existing `ingest` — no new accept verb.
- Baseline: first sweep stakes `baseline_at = now`; triage never looks behind it.
  History stays reachable via `discover` + explicit `ingest`.
- Quiescence gate: sweep only triages (and reports staleness for) sessions quiet
  for a configurable window (default 30 minutes; `0` disables); hot sessions are
  reported as deferred, `--include-hot` lifts the gate for a run.
- Profile `thread.defaults` gains `triage` (model, cheap tier) and the quiescence
  window; the `threads` skill gains the review workflow (sweep → pending →
  ingest/reject → conclude).
- Existing commands (`discover`, `ingest`, `refresh`, `regenerate`) are unchanged;
  member refresh remains human-initiated — the sweep only reports drift.

## Capabilities

### New Capabilities

- `thread-sweep`: detection (source signals vs pins, baseline, quiescence gate),
  triage dispatch (one cheap pass per candidate session across all charters),
  verdict ledger storage and voiding semantics, and the sweep report.
- `thread-review`: the human review surface over the ledger — `pending` listing
  with staleness, `reject`, `conclude` pass-the-remainder semantics, and how
  `ingest` retires proposals.

### Modified Capabilities

<!-- none: watermark semantics, ingest/refresh pipeline, backup enumeration, and
     discover behavior are all unchanged at the requirement level -->

## Impact

- `src/cli/mfz.ts`: four new `thread` subcommands (`sweep`, `pending`, `reject`,
  `conclude`); handlers in `src/thread/cli.ts`.
- New `src/thread/sweep.ts` (detection + triage orchestration) and verdict-ledger
  module; new persona in `src/thread/personas.ts`; triage default in
  `src/thread/storage.ts` synthesis-defaults resolution.
- `src/core/paths.ts`: new machine-local root `~/.mindframe-z/thread-sweep/`.
- Session enumeration reused from `src/sessions/claude-source.ts` /
  `opencode-source.ts` (backup listers), with subagent exclusion (Claude
  `/subagents/` path filter; OpenCode `parent_id IS NULL` — new filter).
- Watermark reuse: `readWatermark` / `classifyWatermark` unchanged.
- `skills/threads/SKILL.md`: review workflow section.
- No changes to thread repos' schema besides none — manifests, runs.json, and the
  ingest/refresh pipeline are untouched; charter hashing is computed, not stored
  in the manifest.
