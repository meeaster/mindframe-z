# Plan 002: Add a CI workflow that enforces `pnpm check` and the integration suite

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `ls .github/workflows 2>/dev/null`
> If a workflows directory already exists with a CI workflow, this plan is
> stale — STOP and report.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

The repo has a complete one-command verification pipeline (`pnpm check` = lint → format check → build → fast tests) plus an isolated integration suite, but **nothing runs any of it automatically** — there is no `.github/workflows/` directory at all, and the only pre-commit hook is a gitleaks secrets scan. `main` (branch name: `master`) mixes merged PRs and direct commits, so regressions can land silently. One small workflow closes this. Note: the un-landed OpenSpec change `openspec/changes/add-release-workflow` is about release-notes drafting, NOT a validation gate — it does not overlap with this plan.

## Current state

- No `.github/` directory exists.
- `package.json` scripts (verified):
  - `"check": "pnpm lint && pnpm fmt:check && pnpm build && pnpm test"`
  - `"test:integration": "vitest run tests/integration"`
- Toolchain versions pinned in `profiles/base/mise.toml`: `node = "24"`, `pnpm = "11"`. `package.json` has **no** `packageManager` field, so `pnpm/action-setup` needs an explicit version.
- Integration tests use temp `root`/`home` dirs and override `OPENCODE_CONFIG_DIR`/`CLAUDE_CONFIG_DIR` (see `AGENTS.md` "Testing And Safety") — they are CI-safe. `smoke-opencode` skips when the `opencode` binary is missing. **Unknown**: whether `tests/integration/sandbox.test.ts` requires docker; step 3 verifies this.
- Repo/user conventions for workflows (must follow):
  - Pin all actions to full commit SHAs (not tags).
  - Validate with `actionlint` and `zizmor --min-severity high`.
  - Conventional Commits.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Local full gate | `pnpm check` | exit 0 |
| Integration suite | `pnpm test:integration` | exit 0 |
| Look up an action's SHA | `gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha` | 40-char SHA |
| Lint workflow | `actionlint` (or `mise x actionlint@latest -- actionlint`) | exit 0, no findings |
| Security-lint workflow | `zizmor --min-severity high .github/workflows/ci.yml` | exit 0, no findings |

## Scope

**In scope** (the only files you should create/modify):
- `.github/workflows/ci.yml` (create)

**Out of scope** (do NOT touch):
- `openspec/changes/add-release-workflow/**` — separate, un-landed release-notes change; do not implement any of it here.
- `package.json` / `pnpm-workspace.yaml` — no `packageManager` field addition unless a STOP is reported first (it changes local developer behavior).
- Branch-protection settings — repository admin state, not code.

## Git workflow

- Branch: `advisor/002-ci-workflow`
- Commit: `ci: run pnpm check and integration tests on push and PR`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Resolve pinned SHAs

Resolve the current SHA for the latest stable major tag of each action (record tag→SHA in a comment next to each pin):

```sh
gh api repos/actions/checkout/git/ref/tags/v5 --jq .object.sha
gh api repos/pnpm/action-setup/git/ref/tags/v4 --jq .object.sha
gh api repos/actions/setup-node/git/ref/tags/v6 --jq .object.sha
```

If a listed tag doesn't exist, list tags (`gh api repos/<o>/<r>/tags --jq '.[].name'`) and use the latest stable major.

**Verify**: each command printed a 40-character SHA.

### Step 2: Write `.github/workflows/ci.yml`

Shape (fill in the real SHAs from step 1; `# vN` comment after each pin):

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA> # vN
      - uses: pnpm/action-setup@<SHA> # vN
        with:
          version: 11
      - uses: actions/setup-node@<SHA> # vN
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm test:integration
```

Keep it to this single job unless step 3 forces a split.

**Verify**: `actionlint` → no findings; `zizmor --min-severity high .github/workflows/ci.yml` → no findings. If either tool is unavailable and cannot be obtained via `mise x` / `uvx`, note it in your report rather than skipping silently.

### Step 3: Prove the commands pass in a clean-ish environment

Run locally, in order: `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm test:integration`. All must exit 0. While `test:integration` runs, note whether any test requires docker or the `opencode` binary: if a test **fails** (not skips) due to a missing external binary, drop `pnpm test:integration` from the workflow, keep `pnpm check`, and record the exclusion + failing test name in your report and in a YAML comment.

**Verify**: the exact command sequence in the workflow exits 0 locally.

## Test plan

No new tests — the workflow *is* the test infrastructure. Verification is step 3 plus the two workflow linters.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` exists; every `uses:` is a 40-char SHA with a version comment
- [ ] `actionlint` exits 0 on the repo
- [ ] `zizmor --min-severity high .github/workflows/ci.yml` exits 0 (or tool-unavailability recorded)
- [ ] `pnpm check && pnpm test:integration` exits 0 locally
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A workflows directory with CI already exists (drift).
- `pnpm check` fails locally on master for reasons unrelated to this plan — report the failing step; do not fix unrelated breakage inside this plan.
- You are tempted to add a `packageManager` field, extra jobs (release, matrix), or caching beyond `setup-node`'s pnpm cache — that's scope creep; report instead.

## Maintenance notes

- When the `add-release-workflow` OpenSpec change lands, its workflow belongs in the same `.github/workflows/` dir; keep CI and release workflows separate files.
- If integration tests were excluded (step 3), re-adding them once the external-binary dependency is handled is the natural follow-up.
- Reviewers: check that future action bumps keep SHA pinning (renovate-style tag pins would regress the convention).
