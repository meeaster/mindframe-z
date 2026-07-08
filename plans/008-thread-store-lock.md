# Plan 008: Serialize concurrent `mfz thread` invocations with an advisory lockfile

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/thread/verdicts.ts src/thread/storage.ts src/thread/cli.ts src/thread/sweep.ts src/thread/ingest.ts`
> Plans 001/005/006/007 legitimately touch some of these files. What matters
> here: the read-modify-write shapes in the "Current state" excerpts still
> exist. On a mismatch there, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-atomic-home-writes-and-parse-abort.md (recommended — atomic writes bound the damage while this lands)
- **Category**: bug
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

Thread state is mutated with unguarded read-modify-write cycles: the sweep verdict ledger is read once and rewritten whole per triage dispatch, thread manifests are read-merged-rewritten by `recordSessions`, and every ingest does `cp` + `git add .` + `git commit` in a shared destination repo. No lock primitive exists anywhere in the repo. Two overlapping `mfz thread` processes — a scheduled sweep racing a manual ingest, or two commands started close together — clobber each other last-writer-wins (dropped verdicts, lost ledger entries) or race concurrent `git commit`s. A per-store advisory lockfile with stale-lock detection makes overlap a clean, explained failure instead of silent data loss.

## Current state

- `src/thread/verdicts.ts:88-100` — whole-file ledger read/write (`readVerdictLedger` / `writeVerdictLedger`); `src/thread/sweep.ts:110-116` reads the ledger once per sweep and `sweep.ts:244-246` rewrites the whole file after each triage dispatch.
- `src/thread/storage.ts:366-378` — `recordSessions` read-modify-writes `manifest.json`; its comment scopes the batching guarantee to *intra*-process fan-out only: "Batched so the parallel ingest fan-out cannot lose updates."
- `src/thread/storage.ts:216-229` — `commitThreadChanges`: `cp` + `git add .` + `git commit` in the shared destination working copy.
- `src/thread/observability.ts:74-81` — an existing liveness probe to reuse for stale-lock detection:

  ```ts
  async function pidState(pid: number): Promise<string> {
    try {
      process.kill(pid, 0);
      return "running";
    } catch {
      return "crashed";
    }
  }
  ```

- CLI command wiring lives in `src/thread/cli.ts` (each subcommand has a `run...` entry function) — the lock wraps at this layer, not inside storage functions, so one lock covers a whole command's read→dispatch→write span.
- Store root helpers are in `src/core/paths.ts` (e.g. `threadSweepRoot`; a `threadStoreRoot`-style helper is imported by `sweep.ts` — locate the exact name there).
- TS conventions: strict, `exactOptionalPropertyTypes`, `.js` import extensions, colocated `*.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Thread tests | `pnpm test:thread` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `src/thread/lock.ts` (create)
- `src/thread/lock.test.ts` (create)
- `src/thread/cli.ts` (wrap mutating commands)
- `src/core/paths.ts` (only if a lockfile-path helper is needed)

**Out of scope** (do NOT touch):
- `src/thread/storage.ts`, `verdicts.ts`, `sweep.ts`, `ingest.ts` internals — the lock lives at the command boundary; no per-function locking.
- Read-only commands (`thread list`, `show`, `runs`, `pending` listing) — they must keep working while a lock is held.
- Cross-machine locking (destinations are git remotes; git itself arbitrates pushes) — host-local processes only.
- `mfz sessions backup` — S3 conditional semantics are out of scope here.

## Git workflow

- Branch: `advisor/008-thread-store-lock`
- Commit: `fix(thread): serialize mutating thread commands with an advisory store lock`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Implement `withThreadStoreLock` in `src/thread/lock.ts`

Semantics:

- Lock file: `<thread store root>/.lock` (same root `sweep.ts`'s `threadStoreRoot`-style helper resolves; add a helper in `src/core/paths.ts` if none fits).
- Acquire: `writeFile(lockPath, JSON.stringify({ pid: process.pid, command, started_at }), { flag: "wx" })`. `wx` makes creation the atomic test-and-set.
- On `EEXIST`: read the lock, check its pid with the `pidState` approach above. If the process is dead → `unlink` and retry acquisition **once**. If alive → throw `Error` naming the holder: `another mfz thread command is running (pid <pid>, <command>, since <started_at>); retry when it finishes`.
- Release: `unlink` in a `finally` — the lock must release on command failure and on plan-005 dispatch timeouts.
- Shape: `export async function withThreadStoreLock<T>(paths: RuntimePaths, command: string, fn: () => Promise<T>): Promise<T>`.
- Ensure the parent dir exists before the `wx` write (`mkdir recursive`), mirroring `writeVerdictLedger`.

**Verify**: `pnpm build` → exit 0.

### Step 2: Wrap the mutating CLI commands

In `src/thread/cli.ts`, wrap the body of each command that writes thread/sweep state: sweep, ingest, refresh, reject, conclude, create, delete/remove (enumerate by grepping `cli.ts` for handlers that reach `writeVerdictLedger`, `writeSweepState`, `writeThreadManifest`, `writeThreadRuns`, `commitThreadChanges`, or `regenerate`). Pattern:

```ts
await withThreadStoreLock(paths, "sweep", () => runSweep({ ... }));
```

Leave read-only commands unwrapped. List in your report exactly which commands you wrapped.

**Verify**: `pnpm build` → exit 0; `pnpm test:thread` → all existing tests pass (they run one command at a time, so acquiring an uncontended lock must be transparent).

### Step 3: Tests

Create `src/thread/lock.test.ts` (temp-dir `RuntimePaths` fixture — reuse the pattern from other thread tests):

1. Uncontended: `withThreadStoreLock` runs `fn`, returns its value, and the lock file is gone afterward.
2. Contended by a live pid: pre-create `.lock` with `pid: process.pid` (this test process is definitionally alive) → rejects with a message containing that pid; the pre-existing lock file is untouched.
3. Stale lock: pre-create `.lock` with an unlikely dead pid (e.g. spawn `sleep 0`, wait for exit, use its pid — or use a very large pid and assert on the reclaim behavior if `process.kill` throws for it) → acquisition succeeds and `fn` runs.
4. Release on throw: `fn` rejects → the error propagates AND the lock file is gone.

**Verify**: `pnpm test:thread` → all pass, including 4 new tests.

## Test plan

- `src/thread/lock.test.ts` as above. No test drives two real concurrent CLI processes — the `wx` atomicity is the OS's guarantee; the tests cover the states around it.
- Verification: `pnpm test:thread`; then `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/thread/lock.ts` exists; `grep -n "withThreadStoreLock" src/thread/cli.ts` shows every mutating command wrapped
- [ ] `pnpm test:thread` exits 0, including the 4 new lock tests
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- You find an existing lock/serialization mechanism this plan would duplicate.
- Wrapping a command at the CLI layer is impossible because state writes happen outside `cli.ts`'s control flow (e.g. in a callback owned by another module) — report where.
- A CLI command both reads interactively (prompts mid-run) and holds the lock for the whole prompt — human-paced lock holds may be unacceptable; report the command instead of shipping a lock that blocks sweeps for minutes.
- pid-reuse concerns: if the reviewer/tests surface that `pidState` false-positives (recycled pid) matter in practice, report rather than adding boot-time heuristics.

## Maintenance notes

- Every future mutating `mfz thread` subcommand must be wrapped — reviewers should check for `withThreadStoreLock` in any new cli handler that writes state.
- Interaction with plan 005: a dispatch timeout inside a locked command must still release the lock via the `finally`; verify once both are landed.
- Deferred: finer-grained per-thread locks (lower contention) — not worth the complexity until scheduled sweeps actually contend with manual work in practice.
