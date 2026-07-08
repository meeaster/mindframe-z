# Plan 006: Warn instead of silently skipping when a thread manifest fails to load

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/thread/sweep.ts src/thread/sweep.test.ts`
> Compare the `loadThreads` excerpt below against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

If one thread's `manifest.json` is truncated or fails schema validation, `loadThreads` silently drops that thread from every sweep: its members stop being drift-checked and its pending proposals vanish from `pending`/`conclude` — with zero operator-visible signal. Corruption is exactly the failure mode a truncated write produces (plan 001 reduces the cause; this plan makes any residual case visible instead of invisible).

## Current state

- `src/thread/sweep.ts:357-386` — `loadThreads`:

  ```ts
  async function loadThreads(paths: RuntimePaths): Promise<SweepThread[]> {
    const threads: SweepThread[] = [];
    try {
      for (const entry of await readdir(threadStoreRoot(paths), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "runs") continue;
        try {
          const manifest = await readThreadManifest(path.join(threadStoreRoot(paths), entry.name));
          threads.push({ ... });
        } catch {
          continue;
        }
      }
    } catch {
      return [];
    }
    return threads.sort((a, b) => a.slug.localeCompare(b.slug));
  }
  ```

- `readThreadManifest` (`src/thread/storage.ts:97-101`) throws on JSON parse or zod validation failure.
- The outer `catch { return [] }` (store root missing — no threads yet) is legitimate and stays.
- Console conventions in this codebase: tab-separated `console.warn`/`console.error` lines, e.g. `console.warn(\`No git remote for ${destination.name} — skipping push\`)` at `src/thread/storage.ts:210` and `console.error(\`failed\t${key}\t...\`)` at `src/sessions/backup.ts:80`.
- Tests: `src/thread/sweep.test.ts` exists with fixtures that build thread stores in temp dirs — model the new test on its existing cases.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Thread tests | `pnpm test:thread` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/thread/sweep.ts` (the inner catch in `loadThreads` only)
- `src/thread/sweep.test.ts` (add one test)

**Out of scope** (do NOT touch):
- `readThreadManifest` / schema — throwing is correct.
- The outer `catch { return [] }` — missing store root is a normal state.
- `listRunStatuses` in `src/thread/observability.ts` — a similar swallow, but over disposable per-run status files; deliberately not in scope.
- Making sweep *fail* on a corrupt manifest — one bad thread must not block sweeping the healthy ones; warn-and-continue is the intended behavior.

## Git workflow

- Branch: `advisor/006-corrupt-manifest-warning`
- Commit: `fix(thread): surface corrupt thread manifests instead of silently skipping`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Emit a warning on the skip path

Change the inner catch to capture the error and warn:

```ts
} catch (error) {
  console.warn(
    `corrupt thread manifest — skipping\t${entry.name}\t${error instanceof Error ? error.message : String(error)}`
  );
  continue;
}
```

**Verify**: `pnpm build` → exit 0.

### Step 2: Test it

In `src/thread/sweep.test.ts`, add a case modeled on the existing fixture setup: create two thread dirs, one valid and one whose `manifest.json` contains invalid JSON. Spy on `console.warn` (`vi.spyOn(console, "warn").mockImplementation(() => {})`). Run the code path the existing tests use to exercise `loadThreads` (e.g. `runSweep` with a stub runner, matching the file's current pattern). Assert:

1. The valid thread is processed (present in the report/threads as the existing tests assert).
2. `console.warn` was called once with a first argument containing the corrupt dir's name.

**Verify**: `pnpm test:thread` → all pass, including the new test.

## Test plan

- One new test in `src/thread/sweep.test.ts` (step 2), following that file's existing temp-store fixtures.
- Verification: `pnpm test:thread`; then `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "corrupt thread manifest" src/thread/sweep.ts` → 1 match
- [ ] `pnpm test:thread` exits 0, including the new test
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `loadThreads` no longer matches the excerpt (drift).
- You find sweep output is consumed programmatically somewhere that would break on the extra stderr line (check `src/thread/cli.ts` JSON output paths — warn goes to stderr via `console.warn`, JSON to stdout, so they should not collide; if they do, report).

## Maintenance notes

- If sweep later grows a structured report section for store-level problems, this warning is the natural candidate to move into `SweepReport` (e.g. a `corrupt_threads` array) — deferred now to keep the change minimal.
- Reviewers of future `loadThreads` changes: keep the guarantee that one bad thread never aborts the sweep of the others.
