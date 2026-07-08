# Plan 011: Reconcile the OpenSpec change ledger with what has actually shipped

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `ls openspec/changes` — if the five changes
> named below are no longer present (already archived), this plan is done or
> stale; STOP and report.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

`openspec/changes/` is supposed to list work in flight, but five fully- or near-fully-implemented changes were never archived, and the `lapdog-thread-observability` change claims 0/26 tasks done while part of its surface (`mfz thread observe up/down/status`) is shipped and wired. The "active changes" view is unreadable as a signal: of 7 non-archive entries, only ~2 are genuinely un-started. Any human or agent picking up work from this ledger risks re-doing landed work. This is a docs/process reconcile — no product code changes.

## Current state

Verified at planning time (`grep -c '\[x\]' / '\[ \]'` on each `tasks.md`):

| Change | Tasks done | Reality |
|---|---|---|
| `openspec/changes/thread-sweep/` | 16/16 | implemented |
| `openspec/changes/mfz-thread/` | 52/52 | implemented |
| `openspec/changes/repo-scoped-skills/` | 14/14 | implemented |
| `openspec/changes/thread-session-phases/` | 12/12 | implemented |
| `openspec/changes/mfz-sandbox/` | 38/39 | one task unchecked — investigate |
| `openspec/changes/lapdog-thread-observability/` | 0/26 | **contradicts code**: `mfz thread observe up/down/status` is registered at `src/cli/mfz.ts:545-566` and implemented in `src/thread/cli.ts:415-436`, and `src/thread/observability.ts` exists |
| `openspec/changes/add-release-workflow/` | 0/~ | genuinely un-started; leave alone |

- `openspec/changes/archive/` exists and holds previously archived changes — follow its naming convention (look at the existing entries; they are dated).
- The repo uses the `@fission-ai/openspec` workflow (`openspec/config.yaml`); an `openspec` CLI may be available (try `npx openspec --help`). Archiving may also sync delta specs into `openspec/specs/` — that is expected output of the archive flow, not scope creep.
- `docs/handoff-lapdog-threads-observability.md:6` says "No code written yet" — also stale, same contradiction.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Task counts | `grep -c '\[x\]' openspec/changes/<name>/tasks.md` | matches table above |
| OpenSpec CLI (if present) | `npx openspec --help` | usage text |
| Validate (if supported) | `npx openspec validate` | exit 0 |
| Fast tests (unchanged) | `pnpm test` | all pass (no code touched) |

## Suggested executor toolkit

- If the `openspec-archive-change` skill is available in your environment, use it for each archive — it encodes the repo's archive flow (including spec syncing). Otherwise mirror the structure of existing entries in `openspec/changes/archive/`.
- If the `openspec-verify-change` skill is available, run it on `mfz-sandbox` in step 2 before deciding.

## Scope

**In scope** (the only files you should modify):
- `openspec/changes/**` (moves into `archive/`, task-checkbox edits, status notes)
- `openspec/specs/**` (only as produced by the archive/sync flow)
- `docs/handoff-lapdog-threads-observability.md` (the stale "No code written yet" line only)

**Out of scope** (do NOT touch):
- Any file under `src/`, `tests/`, `opencode/`, `skills/`, `profiles/`, `shared/` — this plan changes no code.
- `openspec/changes/add-release-workflow/` — genuinely pending; leave exactly as is.
- Writing new specs or new change proposals.

## Git workflow

- Branch: `advisor/011-openspec-reconcile`
- Commits: one per archived change is fine, or a single `docs(openspec): archive implemented changes and correct lapdog status`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Archive the four fully-done changes

For each of `thread-sweep`, `mfz-thread`, `repo-scoped-skills`, `thread-session-phases`: run the archive flow (skill or CLI; else move the directory into `openspec/changes/archive/` following the existing archive entries' naming, and perform whatever spec-sync the existing archived entries show evidence of).

**Verify**: `ls openspec/changes` no longer lists the four; `ls openspec/changes/archive` includes them; if the CLI offers `validate`, it exits 0.

### Step 2: Resolve `mfz-sandbox` (38/39)

Find the unchecked task in `openspec/changes/mfz-sandbox/tasks.md`. Check the code for whether it was actually implemented (grep for the feature it names). Then:
- Implemented → check the box (with a one-line evidence note if the file's style allows), archive as in step 1.
- Not implemented → leave the change active, and add a short status note at the top of its `tasks.md` stating the single remaining task, so the ledger reads truthfully.

**Verify**: either archived, or `git diff openspec/changes/mfz-sandbox` shows only the status note.

### Step 3: Correct the lapdog change and the stale handoff line

In `openspec/changes/lapdog-thread-observability/tasks.md`: identify which tasks correspond to the already-shipped `mfz thread observe up/down/status` surface and `src/thread/observability.ts`, and mark those `[x]`. Do not mark anything not verifiable in code (`src/cli/mfz.ts:545-566`, `src/thread/cli.ts:415-436` are the evidence anchors). The container/hooks/cost-span tasks remain unchecked. In `docs/handoff-lapdog-threads-observability.md`, replace the "No code written yet" claim with one sentence stating the observe CLI surface is shipped and the container/hooks/cost-span work is not.

**Verify**: `grep -c '\[x\]' openspec/changes/lapdog-thread-observability/tasks.md` > 0; `grep -n "No code written yet" docs/handoff-lapdog-threads-observability.md` → no matches.

## Test plan

No code tests. `pnpm test` must still pass untouched (proves no code was modified): run it once at the end.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `ls openspec/changes` shows only `archive/`, `add-release-workflow`, `lapdog-thread-observability`, and (only if its last task is real) `mfz-sandbox`
- [ ] `grep -rn "No code written yet" docs/` → no matches
- [ ] `git diff --stat -- src tests opencode skills profiles shared` → empty
- [ ] `pnpm test` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The openspec CLI's archive command wants to modify files outside `openspec/**` (other than nothing) — report what it wants to do first.
- A "done" change's tasks turn out NOT to match shipped code when you spot-check (i.e. checkboxes were aspirational) — report which; don't archive a change whose implementation you can't evidence.
- You cannot determine the archive flow from the skill, CLI, or existing archive entries.

## Maintenance notes

- Process fix that prevents recurrence: archive a change in the same PR that completes its last task. Consider noting this in `AGENTS.md` later (not in this plan's scope).
- The corrected lapdog task state feeds plan 017 (cost-span spike) — its scoping assumes the observe surface exists.
