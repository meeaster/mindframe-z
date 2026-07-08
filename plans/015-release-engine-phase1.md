# Plan 015: Build the release-history engine (phase 1 of the designed release workflow, no GitHub side effects)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `ls src/release 2>/dev/null && echo EXISTS` —
> if `src/release/` already exists, this plan is stale; STOP and report.
> Also read `openspec/changes/add-release-workflow/tasks.md` section 1: if
> any 1.x task is checked, reconcile before starting.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (this phase; the risky GitHub-side phases are explicitly excluded)
- **Depends on**: none (plan 011 corrects the surrounding ledger; not blocking)
- **Category**: direction
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

The repo sits at version 0.1.0 with no tags and no release history, while a fully-converged design for a release workflow exists (`openspec/changes/add-release-workflow/` — its `design.md` ends with "Open Questions: None"). The remaining cost is execution. Its own risk section flags the GitHub-side pieces (synthetic `next-release` tag, draft-release mutation) as the delicate part — so this plan executes only **phase 1**: the pure, testable release-history engine under `src/release/`, with zero GitHub side effects. That de-risks the later workflow phases (PR association, first-release handling) where the design says the uncertainty lives.

## Current state

- The authoritative spec for what to build is in-repo — the executor MUST read these before writing code:
  - `openspec/changes/add-release-workflow/proposal.md` — the release model: real releases are immutable `vMAJOR.MINOR.PATCH` git tags; a rolling draft projects unreleased work; first release is special-cased.
  - `openspec/changes/add-release-workflow/design.md` — decisions and rationale.
  - `openspec/changes/add-release-workflow/tasks.md` section "## 1. Shared Release Engine" — the five tasks this plan implements verbatim:
    - 1.1 release-history module: resolve latest real `vMAJOR.MINOR.PATCH` tag, detect first-release mode, compute the git range
    - 1.2 change collection: collapse confidently-associated merged PRs into single entries; unmatched changes stay as direct commits
    - 1.3 deterministic detailed-changes markdown: `Pull Requests` and `Direct Commits` sections, oldest-first, empty sections omitted
    - 1.4 structured summary inputs so a local AI workflow can inspect PR bodies and diffs in addition to the deterministic list
    - 1.5 source tests for tag filtering, first-release mode, PR/direct-commit classification, markdown rendering
- Repo facts the engine must handle: branch `master` mixes merged PRs (subjects like `refactor(sync): unify unmanaged-item profile resolution (#15)`) and direct commits (e.g. `chore: update agent model configs`); `(#N)` suffixes are the primary PR-association signal; there are currently **zero** `v*` tags, so first-release mode is the live case.
- Conventions: TypeScript ESM (`.js` import extensions), strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; shell out via `execa` (see `src/thread/storage.ts:204-213` for the pattern); colocated `*.test.ts` (exemplar: `src/core/profile.test.ts`); Conventional Commits.
- `gh` may be used read-only for PR metadata (task 1.4), but design the module so git-only data (subject `(#N)` parsing) works without network — tests must not hit the network.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Fast tests | `pnpm test` | all pass (picks up `src/release/*.test.ts`) |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should create/modify):
- `src/release/**` (new module + colocated tests)
- `openspec/changes/add-release-workflow/tasks.md` (check off 1.1–1.5 when done)

**Out of scope** (do NOT touch — these are later phases of the change):
- `.github/workflows/**` — no rolling-draft workflow (tasks section 2).
- `.claude/skills/**` — no release-notes/cut-release skills (section 3).
- Anything that creates/edits tags, releases, or drafts — **zero GitHub mutations**; `gh` calls must be read-only.
- `src/cli/mfz.ts` — no CLI command in this phase; the engine is a library the later phases consume.

## Git workflow

- Branch: `advisor/015-release-engine`
- Commit(s): `feat(release): add release-history engine (tags, ranges, change collection, rendering)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the spec and sketch the module surface

Read the three openspec files above end-to-end. Propose (in code) a small surface, e.g.:

- `resolveLatestReleaseTag(cwd): Promise<string | undefined>` — strictly `vMAJOR.MINOR.PATCH` (regex-anchored; `next-release` and any other tags excluded).
- `releaseRange(cwd): Promise<{ from?: string; to: "HEAD"; firstRelease: boolean }>`
- `collectChanges(cwd, range): Promise<{ pullRequests: ...; directCommits: ... }>` — `(#N)`-suffix association from `git log` subjects; a PR's member commits collapse into one entry.
- `renderDetailedChanges(changes): string` — deterministic markdown per task 1.3.
- `summaryInputs(changes): ...` — structured data per task 1.4 (PR numbers/titles/bodies where available; body fetch via injected reader so tests stay offline).

Match the design doc where it is more specific than this sketch — the design doc wins.

**Verify**: `pnpm build` → exit 0 with the skeleton compiling.

### Step 2: Implement with git-only data first, injected `gh` reader second

Implement tag resolution + range + classification + rendering over `execa("git", ["log", ...])` output. For PR bodies (task 1.4), define a narrow injected interface (e.g. `PrReader`) with a `gh`-backed implementation, so tests inject fixtures.

**Verify**: `pnpm build` → exit 0.

### Step 3: Tests (task 1.5)

Colocated `src/release/*.test.ts`. For git-dependent functions, build a throwaway git repo in a temp dir inside the test (git init, commits with/without `(#N)` suffixes, tags including a decoy `next-release` tag) — this keeps tests hermetic. Cover at minimum: tag filtering (ignores non-semver and `next-release`), first-release mode (no tags), PR collapse vs direct commits, oldest-first ordering, empty-section omission, deterministic output (same input → identical string).

**Verify**: `pnpm test` → all pass, including the new suite.

### Step 4: Check off tasks 1.1–1.5

Mark them `[x]` in `openspec/changes/add-release-workflow/tasks.md`.

**Verify**: `grep -c '\[x\]' openspec/changes/add-release-workflow/tasks.md` → 5.

## Test plan

Step 3 is the test plan; hermetic temp-dir git repos, no network, no mocking of our own module internals (repo test conventions).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/release/` exists with implementation + tests; `pnpm test` exits 0
- [ ] `pnpm check` exits 0
- [ ] `git tag` in the repo is unchanged; no `gh` mutation commands appear in the code (`grep -rn "gh api -X\|gh release create\|gh release edit" src/release` → empty; only read-only `gh` usage)
- [ ] Tasks 1.1–1.5 checked in the openspec change
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The design doc materially contradicts this plan's sketch (design wins — but report the divergence rather than silently following either).
- PR association turns out to need the GitHub API even for the basic classification (design implies subject-suffix parsing suffices; if not, report).
- You are tempted to also build the workflow or skills "while you're in there" — later phases, out of scope.

## Maintenance notes

- Phases 2–5 of the openspec change (workflow, skills, reset behavior, docs) build directly on this module — keep its API surface small and its rendering deterministic; the rolling-draft workflow will diff its output textually.
- When phase 2 lands, plan 002's CI workflow file sits in the same directory — keep them separate files.
