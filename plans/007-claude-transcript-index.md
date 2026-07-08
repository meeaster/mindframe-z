# Plan 007: Build a session-id → transcript-path index once per command instead of rescanning `~/.claude/projects` per session

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/thread/watermark.ts src/thread/sweep.ts src/thread/ingest.ts src/thread/watermark.test.ts`
> Compare the excerpts below against the live code; on a mismatch, treat it
> as a STOP condition. (Plans 006/008 may have touched `sweep.ts` elsewhere —
> only the `readCachedWatermark` region matters here.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

Claude transcripts live at `~/.claude/projects/<encoded-project>/<id>.jsonl`, and the project dir is not derivable from the session id, so `locateClaudeTranscript` probes every project directory with a sequential `pathExists` per lookup. Sweep calls this (via `readWatermark`) once per active Claude session — on a store with N sessions across P project dirs that is up to N×P sequential stat calls per `mfz thread sweep`, pure interactive-CLI startup latency. One readdir-walk of `projects/` builds a complete id→path map that serves every lookup in the command.

## Current state

- `src/thread/watermark.ts:38-59` — the scanner (comment explains the lossy encoding; keep that rationale):

  ```ts
  export async function locateClaudeTranscript(
    paths: RuntimePaths,
    id: string
  ): Promise<string | undefined> {
    const projectsDir = path.join(paths.claudeDir, "projects");
    let entries: string[];
    try {
      entries = await readdir(projectsDir);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (await pathExists(path.join(projectsDir, entry, `${id}.jsonl`)))
        return path.posix.join("projects", entry, `${id}.jsonl`);
    }
    return undefined;
  }
  ```

- Callers:
  - `src/thread/watermark.ts:65` — `readClaudeWatermark` calls it per watermark read; `readWatermark` (`watermark.ts:29-36`) routes claude-code sessions there.
  - `src/thread/sweep.ts:146-157` — `readCachedWatermark` memoizes per session id but still triggers one full scan per distinct session:

    ```ts
    const watermarkCache = new Map<string, Watermark | undefined>();
    const readCachedWatermark = async (signal: SweepSessionSignal): Promise<Watermark | undefined> => {
      if (!watermarkCache.has(signal.id)) {
        watermarkCache.set(
          signal.id,
          await readWatermark(args.paths, { source: signal.source, id: signal.bareId })
        );
      }
      return watermarkCache.get(signal.id);
    };
    ```

  - `src/thread/ingest.ts:364` — `const local = await locateClaudeTranscript(paths, id);` (hands gather the exact path).
- Return-value contract to preserve exactly: store-relative POSIX subpath `projects/<entry>/<id>.jsonl`, or `undefined` when absent (including when `projects/` doesn't exist).
- Tests: `src/thread/watermark.test.ts` exists — extend it. TS conventions: strict, `exactOptionalPropertyTypes`, `.js` import extensions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Thread tests | `pnpm test:thread` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/thread/watermark.ts`
- `src/thread/sweep.ts` (only the `readCachedWatermark` region)
- `src/thread/ingest.ts` (only the `locateClaudeTranscript` call region)
- `src/thread/watermark.test.ts`

**Out of scope** (do NOT touch):
- `src/sessions/claude-source.ts` (`listClaudeItems`) — its walk serves backup listing; unifying the two walks is a bigger refactor, deliberately deferred.
- Any persistent/on-disk cache — the index lives for one command invocation only.
- OpenCode watermark reads (sqlite) — already indexed by the DB.

## Git workflow

- Branch: `advisor/007-claude-transcript-index`
- Commit: `perf(thread): index claude transcripts once per command instead of per-session scans`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the index builder and an optional index parameter

In `src/thread/watermark.ts`:

```ts
// One readdir walk of projects/ mapping <id> → store-relative transcript subpath.
// Sweep and ingest build this once per command; per-session lookups then skip the
// per-id directory probing (the id → project-dir encoding is lossy, see below).
export type ClaudeTranscriptIndex = Map<string, string>;

export async function buildClaudeTranscriptIndex(
  paths: RuntimePaths
): Promise<ClaudeTranscriptIndex> {
  const projectsDir = path.join(paths.claudeDir, "projects");
  const index: ClaudeTranscriptIndex = new Map();
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return index;
  }
  for (const entry of entries) {
    let files: string[];
    try {
      files = await readdir(path.join(projectsDir, entry));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(".jsonl"))
        index.set(file.slice(0, -".jsonl".length), path.posix.join("projects", entry, file));
    }
  }
  return index;
}
```

Then thread an optional index through the existing functions, preserving the fallback scan when no index is given:

- `locateClaudeTranscript(paths, id, index?)` → `if (index) return index.get(id);` before the scan.
- `readClaudeWatermark(paths, id, index?)` → pass through.
- `readWatermark(paths, session, claudeIndex?)` → pass through for claude-code sessions.

All optional params typed `?: ClaudeTranscriptIndex | undefined` per `exactOptionalPropertyTypes`.

**Verify**: `pnpm build` → exit 0. Existing `pnpm test:thread` still passes (fallback path unchanged).

### Step 2: Build the index once in sweep

In `runSweep` (`src/thread/sweep.ts`), immediately before the `watermarkCache` declaration, build it lazily so sweeps with zero Claude sessions pay nothing:

```ts
let claudeIndex: Promise<ClaudeTranscriptIndex> | undefined;
const getClaudeIndex = (): Promise<ClaudeTranscriptIndex> =>
  (claudeIndex ??= buildClaudeTranscriptIndex(args.paths));
```

and in `readCachedWatermark`, pass `signal.source === "claude-code" ? await getClaudeIndex() : undefined` as the new argument to `readWatermark`.

**Verify**: `pnpm build` → exit 0; `pnpm test:thread` → all pass.

### Step 3: Reuse in ingest

In `src/thread/ingest.ts`, find the call at (planning-time) line 364: `const local = await locateClaudeTranscript(paths, id);`. Determine whether the enclosing function processes multiple sessions per invocation (it is part of the ingest fan-out). If a natural once-per-ingest scope exists (e.g. the function that iterates sessions), build the index there once and pass it down; if the call is per-session with no shared scope reachable without restructuring, leave ingest on the fallback scan and note that in your report — sweep is the hot path, ingest handles few sessions per run.

**Verify**: `pnpm build` → exit 0; `pnpm test:thread` → all pass.

### Step 4: Tests

In `src/thread/watermark.test.ts`, modeled on its existing temp-store fixtures:

1. `buildClaudeTranscriptIndex` over a fixture with 2 project dirs / 3 transcripts returns exactly 3 entries with correct `projects/<dir>/<id>.jsonl` subpaths.
2. Missing `projects/` dir → empty map.
3. `locateClaudeTranscript` with an index returns the mapped path without touching unlisted ids (id absent from index → `undefined`).
4. Parity: for the same fixture, indexed and un-indexed lookups return identical results.

**Verify**: `pnpm test:thread` → all pass, including 4 new tests.

## Test plan

- The four unit tests above in `src/thread/watermark.test.ts`.
- Verification: `pnpm test:thread`; then `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "buildClaudeTranscriptIndex" src/thread/watermark.ts src/thread/sweep.ts` → defined and used in sweep
- [ ] `pnpm test:thread` exits 0, including the new tests
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- A test depends on `locateClaudeTranscript` observing files created *after* sweep start (would make a prebuilt index stale within a run) — report; that would argue for per-lookup freshness.
- Threading the index through ingest requires restructuring more than one function signature — leave ingest on the fallback and report (see step 3).

## Maintenance notes

- The index is a point-in-time snapshot per command; anything that starts long-lived processes (a future daemon/watch mode) must rebuild or invalidate it.
- If `src/sessions/claude-source.ts`'s walk and this index ever need to agree (e.g. shared cache), unify them then — flagged as the natural follow-up refactor.
