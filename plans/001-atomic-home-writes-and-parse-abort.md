# Plan 001: Abort apply on unparseable local Claude JSON, and make $HOME/thread-state writes atomic

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/core/render.ts src/renderers/claude.ts src/thread/storage.ts src/thread/verdicts.ts src/thread/observability.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

`mfz apply` merges managed settings into the user's real `~/.claude/settings.json` and `~/.claude.json` (which holds OAuth state, project approvals, history, and unmanaged MCP servers). Today, if either file exists but is unparseable — a hand-edit typo, or a truncated file left by an interrupted write — the reader silently treats it as `{}` and the merge result (containing **only** mindframe-z's managed keys) is written back over the whole file. That permanently destroys all unmanaged user state. Separately, every one of these files, plus all thread state files (`manifest.json`, `runs.json`, `ledger.json`, `sweep.json`, `status.json`), is written with a truncate-in-place `writeFile`, so a crash/SIGINT/disk-full mid-write produces exactly the corrupt file that triggers the first bug. This plan closes both: parse failures abort the render loudly, and the write sites become atomic (write temp file, then `rename`).

## Current state

- `src/renderers/claude.ts` — the claude-code renderer. `readJsonObject` (lines 32–41) swallows all errors:

  ```ts
  async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  ```

  Its results feed the full-file rewrites (lines 177–195):

  ```ts
  const localSettingsPath = path.join(paths.claudeDir, "settings.json");
  const localClaudeJsonPath = path.join(paths.home, ".claude.json");
  const mergedSettings = deepMerge(await readJsonObject(localSettingsPath), settings);
  const mergedClaudeJson = mergeClaudeMcp(
    await readJsonObject(localClaudeJsonPath),
    ...
  ```

- `src/core/render.ts` — `writeLocalFiles` (lines 50–62) writes those merged files truncate-in-place:

  ```ts
  export async function writeLocalFiles(files: RenderedFile[]): Promise<void> {
    for (const file of files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      try {
        const stat = await lstat(file.path);
        if (file.ifMissing) continue;
        if (stat.isSymbolicLink()) await unlink(file.path);
      } catch {
        // Missing files are created below.
      }
      await writeFile(file.path, file.content, "utf8");
    }
  }
  ```

- Thread-state write sites, all truncate-in-place `writeFile`:
  - `src/thread/storage.ts:103-106` — `writeThreadManifest` (`manifest.json`)
  - `src/thread/storage.ts:114-117` — `writeThreadRuns` (`runs.json`)
  - `src/thread/verdicts.ts:94-100` — `writeVerdictLedger` (`ledger.json`)
  - `src/thread/verdicts.ts:108-111` — `writeSweepState` (`sweep.json`)
  - `src/thread/observability.ts:31-35` — `writeRunStatus` (`status.json`)

  A corrupt `ledger.json`/`sweep.json` makes `readVerdictLedger`/`readSweepState` (`src/thread/verdicts.ts:88-92,102-106`) throw on every subsequent run, wedging sweep until manually repaired.

- Conventions: ESM with `module: "nodenext"` — local imports use `.js` extensions (e.g. `import { pathExists } from "../core/paths.js"`). Strict TS with `exactOptionalPropertyTypes`: optional params are typed `x?: T | undefined`. There is precedent for staged-write-then-`rename` at `src/sessions/hydrate.ts:20,49`.
- The "merge, don't symlink" model for Claude settings is a documented decision (`ARCHITECTURE.md`, "Claude Code `settings.json` is intentionally not symlinked") — this plan does NOT change the merge model, only the error branch and write mechanics.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Build (typecheck) | `pnpm build` | exit 0 |
| Fast tests | `pnpm test` | all pass |
| Apply integration | `pnpm test:apply` | all pass |
| Thread tests | `pnpm test:thread` | all pass |
| Lint + fmt + build + test | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `src/core/fs.ts` (create — `writeFileAtomic`)
- `src/core/fs.test.ts` (create)
- `src/core/render.ts` (`writeLocalFiles` only)
- `src/renderers/claude.ts` (`readJsonObject` only)
- `src/thread/storage.ts` (the two write functions only)
- `src/thread/verdicts.ts` (the two write functions only)
- `src/thread/observability.ts` (`writeRunStatus` only)
- `tests/integration/apply.test.ts` (add tests)

**Out of scope** (do NOT touch, even though they look related):
- `writeRenderedFiles` in `src/core/render.ts` — writes regenerable output under `configs/<profile>/`; corruption there is repaired by re-running apply.
- `src/thread/storage.ts:315` (session `.md` writes), `writeRunTrace`, dossier writes in `observability.ts` — regenerable synthesized artifacts; deliberately deferred.
- `src/core/symlinks.ts` — already uses `rename` for backups.
- Any change to the merge semantics themselves (`deepMerge`, `mergeClaudeMcp`).

## Git workflow

- Branch: `advisor/001-atomic-home-writes`
- Conventional Commits, e.g. `fix(render): abort apply on unparseable local Claude JSON` (matches repo history, e.g. `fix(thread): resolve the Claude session store by literal mount path in dispatches`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `writeFileAtomic` in `src/core/fs.ts`

Create `src/core/fs.ts`:

```ts
import { rename, writeFile } from "node:fs/promises";

// Write via a sibling temp file + rename so a crash mid-write can never leave a
// truncated target. rename() over an existing file is atomic on POSIX. fsync is
// deliberately omitted: the threat model is interrupted processes, not power loss.
export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode?: number | undefined
): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  await rename(tmp, filePath);
}
```

The `mode` parameter is unused by this plan but is required by plan 004 — include it now so both plans don't conflict.

Create `src/core/fs.test.ts` (colocated, vitest, model after the describe/it shape of `src/core/paths.test.ts` or `src/core/profile.test.ts`) covering: writes new file with exact content; replaces existing file content; leaves no `*.tmp-*` sibling behind.

**Verify**: `pnpm test -- src/core/fs.test.ts` → all pass. `pnpm build` → exit 0.

### Step 2: Route the five thread-state writers and `writeLocalFiles` through it

- `src/core/render.ts`: replace the final `await writeFile(file.path, file.content, "utf8")` in `writeLocalFiles` with `await writeFileAtomic(file.path, file.content)`. Keep the `lstat`/`ifMissing`/symlink-`unlink` logic exactly as is (the unlink must still happen first: `rename` onto a symlink would replace the symlink, which is the desired end state, but the existing explicit unlink also covers the `ifMissing` skip path — do not restructure it).
- `src/thread/storage.ts`: `writeThreadManifest`, `writeThreadRuns` — swap `writeFile(...)` for `writeFileAtomic(...)` (note these two currently omit the `"utf8"` arg; behavior is unchanged).
- `src/thread/verdicts.ts`: `writeVerdictLedger`, `writeSweepState` — same swap.
- `src/thread/observability.ts`: `writeRunStatus` — same swap.
- Import with the `.js` extension: `import { writeFileAtomic } from "../core/fs.js";` (adjust relative path per file). Remove now-unused `writeFile` imports where applicable (oxlint will flag them).

**Verify**: `pnpm build` → exit 0. `pnpm test:thread` → all pass. `pnpm test:apply` → all pass.

### Step 3: Make `readJsonObject` abort on unparseable non-missing files

In `src/renderers/claude.ts`, replace `readJsonObject` with:

```ts
async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Refusing to render claude config: ${filePath} exists but is not valid JSON. ` +
        `Fix or remove it, then re-run apply. (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Refusing to render claude config: ${filePath} does not contain a JSON object.`
    );
  }
  return parsed as Record<string, unknown>;
}
```

Rationale the code comment should carry: this file is merged and rewritten whole; treating a parse failure as "empty" would discard every unmanaged key in the user's real `~/.claude.json`.

**Verify**: `pnpm build` → exit 0. `pnpm test:apply` → all pass (existing tests must not regress — they operate on temp homes with either absent or valid JSON files).

### Step 4: Add integration coverage for the corrupt-file abort

In `tests/integration/apply.test.ts`, following the structure of the existing apply tests and the helpers in `tests/integration/support.ts` (temp `root`/`home`, `--no-link` unless links are under test):

1. Seed the temp home's `~/.claude.json` with invalid JSON (e.g. `{"mcpServers":` truncated).
2. Run apply; assert it exits non-zero and stderr mentions the file path.
3. Assert the corrupt file's bytes are unchanged (read before/after and compare).
4. Repeat the same three assertions for `~/.claude/settings.json`.

**Verify**: `pnpm test:apply` → all pass, including the 2 new tests.

## Test plan

- New: `src/core/fs.test.ts` (3 cases, step 1) and 2 integration cases in `tests/integration/apply.test.ts` (step 4).
- Pattern exemplars: `src/core/profile.test.ts` for unit shape; existing cases in `tests/integration/apply.test.ts` for integration shape.
- Full verification: `pnpm check` → exit 0, then `pnpm test:integration` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm check` exits 0
- [ ] `pnpm test:integration` exits 0, including 2 new corrupt-file tests
- [ ] `grep -n "catch {" src/renderers/claude.ts` shows no bare catch inside `readJsonObject`
- [ ] `grep -rn "writeFileAtomic" src/thread src/core/render.ts | wc -l` ≥ 6 (5 thread/state sites + writeLocalFiles)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the live code (drift).
- Any existing test in `pnpm test:apply` or `pnpm test:thread` fails in a way that isn't explained by the new abort behavior, twice after a fix attempt.
- You find a call site that relies on `readJsonObject` returning `{}` for a *malformed* (not missing) file — that would mean the swallow was load-bearing somewhere.
- The fix appears to require touching `deepMerge`/`mergeClaudeMcp` or any out-of-scope file.

## Maintenance notes

- Plan 004 (secrets file modes) extends `writeLocalFiles` and uses `writeFileAtomic`'s `mode` parameter — land this plan first.
- Any future writer of `~/.mindframe-z` state or $HOME config should use `writeFileAtomic`; a reviewer should flag new raw `writeFile` calls on non-regenerable files.
- Deferred: atomicity for regenerable artifacts (rendered configs, session `.md`s, traces) — see Out of scope for rationale.
