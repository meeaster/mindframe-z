# Plan 009: Add fast unit tests for manifest loading/validation and the Claude renderer merge logic

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/core/manifests.ts src/renderers/claude.ts`
> Plan 001 is EXPECTED to have changed `readJsonObject` in `claude.ts` —
> verify plan 001's status in `plans/README.md` and test the post-001
> behavior (abort on unparseable). Any other mismatch with the excerpts is a
> STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-atomic-home-writes-and-parse-abort.md
- **Category**: tests
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

`src/core/manifests.ts` (~470 LOC) owns every Zod schema and the load/validate entry points all commands depend on, and is the repo's single most-churned source file — yet it has no colocated unit tests; only happy-path parsing is touched indirectly. The renderers (`claude.ts` 198 LOC, `opencode.ts` 271 LOC) have zero colocated tests; their riskiest logic — the merge into the user's real `~/.claude/settings.json` and `~/.claude.json` — is guarded only by slow, spawn-based integration tests a developer must remember to run. Fast characterization tests pin the current behavior before the next schema or merge change, and make regressions visible in `pnpm test` (and CI, once plan 002 lands).

## Current state

- `src/core/manifests.ts` key surfaces (verified at planning time):
  - `readYaml` (line ~295): missing file → returns `fallback`; existing file → `schema.parse(YAML.parse(...))`, so invalid YAML or schema violations **throw**.

    ```ts
    export async function readYaml<T>(file: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
      if (!(await exists(file))) return fallback;
      const parsed = YAML.parse(await readFile(file, "utf8"));
      return schema.parse(parsed);
    }
    ```

  - `validateManifests(root, home?)` (line ~314): builds a file/schema list (shared/refs.yml, skills.yml, mcp.yml, machine config, every `profiles/*/profile.yml`) and returns `ManifestValidationResult[]` where each entry is `{ file, ok: true }` or `{ file, ok: false, error }` — missing files return `null` internally and are omitted.
- `src/renderers/claude.ts` module-private helpers to test:
  - `mergeClaudePermissions(existing, generated)` (lines ~15–30): union+dedupe of `allow`/`deny` arrays; non-object `existing` resets to `{}`.
  - `mergeClaudeMcp(existingClaudeJson, managedMcp, managedServerNames)` (lines ~74+): merges managed servers into `mcpServers`, preserving unmanaged entries and pruning stale managed ones. Read the implementation before writing tests — characterize what it *does*.
  - `readJsonObject` (post-plan-001): `ENOENT` → `{}`; unparseable/non-object → throws.
- Test-seam convention for private functions (from `src/thread/runner.ts:367,394`): `export const <name>ForTest = <name>;` — use it; do not restructure the modules.
- Unit test exemplar: `src/core/profile.test.ts` — plain vitest `describe`/`it`, builds inputs with `profileSchema.parse(...)`, regression comments above tricky cases. Match it.
- `pnpm test` runs `vitest run src opencode` — colocated tests are picked up automatically.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Fast tests | `pnpm test` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `src/core/manifests.test.ts` (create)
- `src/renderers/claude.test.ts` (create)
- `src/renderers/claude.ts` (ONLY to add `...ForTest` export aliases)
- `src/core/manifests.ts` (ONLY if a `...ForTest` alias is needed; `readYaml`/`validateManifests` are already exported)

**Out of scope** (do NOT touch):
- Any behavior change in either module — these are characterization tests; if you find a bug, record it in your report, do not fix it here.
- `src/renderers/opencode.ts` tests — valuable but deferred; this plan pins the $HOME-merge logic first (highest stakes).
- `tests/integration/**` — existing integration coverage stays as-is.

## Git workflow

- Branch: `advisor/009-manifest-renderer-tests`
- Commit: `test: characterize manifest loading and claude renderer merges`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `src/core/manifests.test.ts`

Using temp dirs (`fs.mkdtemp` under `os.tmpdir()`), cover at minimum:

1. `readYaml`: missing file returns the exact `fallback` object.
2. `readYaml`: invalid YAML syntax → rejects.
3. `readYaml`: valid YAML violating the schema (e.g. `refsManifestSchema` with a ref entry missing `url`) → rejects with a Zod error.
4. `validateManifests`: a root with one valid `shared/refs.yml` and one invalid `shared/skills.yml` → returns entries with `ok: true` for the former and `ok: false` + non-empty `error` for the latter; files that don't exist are absent from results.
5. `validateManifests`: profile discovery — a `profiles/<name>/profile.yml` with an invalid shape appears as `ok: false`.
6. Schema rejection spot-checks on 2–3 high-value shapes you confirm exist in `manifests.ts` (e.g. machine config `extra_folders` entry missing `path`; a thread-defaults field with the wrong type). Read the schemas first; test what is actually declared.

**Verify**: `pnpm test -- src/core/manifests.test.ts` → all pass.

### Step 2: Test seams + `src/renderers/claude.test.ts`

Add to `claude.ts` (bottom of file, matching the runner.ts convention):

```ts
export const mergeClaudeMcpForTest = mergeClaudeMcp;
export const mergeClaudePermissionsForTest = mergeClaudePermissions;
```

Then write `src/renderers/claude.test.ts` — pure in-memory input→output, no filesystem:

`mergeClaudePermissions`:
1. Merges generated `allow`/`deny` into existing arrays with dedupe.
2. Non-object `existing` (string/array/null) → result contains only generated entries.
3. Existing keys outside `allow`/`deny` are preserved.

`mergeClaudeMcp` (read the implementation first; characterize precisely):
4. Adds a managed server absent from existing `mcpServers`.
5. Overwrites a managed server whose definition changed.
6. Preserves an unmanaged server (name not in `managedServerNames`).
7. Prunes a stale managed server (in `managedServerNames` but absent from `managedMcp`).
8. Preserves unrelated top-level keys of `existingClaudeJson` (e.g. `projects`, `oauthAccount`-shaped keys) byte-for-byte.
9. Existing `mcpServers` that is not an object → characterize whatever the code does (read it; assert that).

**Verify**: `pnpm test -- src/renderers/claude.test.ts` → all pass.

### Step 3: Full gate

**Verify**: `pnpm check` → exit 0 (lint must accept the new `...ForTest` exports; oxlint config already tolerates this pattern in `runner.ts`).

## Test plan

This plan *is* the test plan: ~15 new cases across two new colocated files, patterned on `src/core/profile.test.ts`. Verification: `pnpm test` → all pass including the new files; `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/core/manifests.test.ts` and `src/renderers/claude.test.ts` exist with ≥6 and ≥8 cases respectively
- [ ] `git diff --stat src/renderers/claude.ts src/core/manifests.ts` shows only `...ForTest` export additions (no logic changes)
- [ ] `pnpm test` exits 0
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 001 is not DONE (the `readJsonObject` behavior you'd characterize is about to change under you).
- While characterizing `mergeClaudeMcp` you find behavior that looks like a data-loss bug (e.g. unmanaged servers dropped) — STOP and report with the failing input; fixing belongs in its own change.
- A helper cannot be tested without restructuring `claude.ts` beyond adding export aliases.

## Maintenance notes

- These are characterization tests: when merge behavior is *intentionally* changed later, update the tests in the same commit and say so in the message.
- Natural follow-up (deferred): the same treatment for `src/renderers/opencode.ts` (its markdown/permission rendering) — model on `claude.test.ts` once it exists.
- Once plan 002's CI is live, these tests run on every push — that pairing is the point.
