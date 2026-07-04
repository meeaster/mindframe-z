---
name: quality-garden
description: Quality garden - coordinate one behavior-preserving maintenance PR with separate gardener and reviewer roles. User-invoked.
disable-model-invocation: true
---

# Quality Garden

Run a **garden** pass: one small, behavior-preserving improvement that leaves the codebase easier to maintain, easier to test, or easier for agents to navigate.

The garden is not a feature sprint and not an open-ended audit. It ends in a branch, a draft PR, and an explicit merge-or-hold recommendation. Behavior should stay the same unless the user approves a behavior change.

Keep the roles separate:

- **Gardener** - explores, chooses one target, changes code, verifies behavior, commits, pushes, and opens the draft PR.
- **Reviewer** - reads the finished PR diff, applies the thermo-nuclear quality bar, and returns merge/hold.
- **Chair** - coordinates role handoffs and reports the decision to the user.

The same agent should not be both gardener and reviewer unless the user explicitly accepts the weaker review gate.

## 0. Identify Your Role

Before doing any work, decide which role you are playing in this invocation. Only run the sections for that role.

- **Claude chair** - You are Claude Code and the user invoked `quality-garden` directly. Run sections 1-2, wait for the gardener's PR, then run sections 7-9.
- **OpenCode gardener** - You are OpenCode and the prompt asks you to perform the garden pass. Run sections 3-6. Stop after returning the PR URL, branch, verification results, and residual risk. Do not review your own PR.
- **OpenCode chair** - You are OpenCode and the user invoked `quality-garden` directly. Run sections 1 and 3-6, dispatch Claude for sections 7-8, then run section 9.
- **Claude reviewer** - You are Claude Code and the prompt asks you to review an existing garden PR. Run sections 7-8. Do not edit files.

If the prompt does not make your role clear, ask one short clarification before starting. Do not silently choose a role that would make you both gardener and reviewer.

Done when you can name your role and the sections you will run.

## 1. Chair: Choose The Handoff

Pick the direction that matches the invoking environment:

- **Claude chair -> OpenCode gardener -> Claude reviewer**: Claude writes the brief, dispatches OpenCode to garden and create the PR, then reviews the PR.
- **OpenCode chair/gardener -> Claude reviewer**: OpenCode gardens and creates the PR, then dispatches Claude to review it.

Use the best available model for each role. Default to OpenCode GPT-5.5 for the gardener when available and Claude Opus for the reviewer when available, but treat those as defaults, not requirements. Record which agent/model performed each role.

The chair does not explore the codebase, choose the target, or run verification. That belongs to the gardener.

Done when the chair knows who is gardening, who is reviewing, and what command or prompt will hand off to the next role.

## 2. Chair: Write The Gardener Brief

Write a brief for the gardener. The brief should load or apply the `thermo-nuclear-code-quality-review` skill and ask the gardener to explore just enough code to find one target with high leverage and low behavior risk.

The brief must require:

- One target only; no unrelated cleanup batching.
- Behavior-preserving changes only unless the user explicitly approves otherwise.
- A one-sentence target statement before editing.
- The behavior contract that must remain unchanged.
- Isolated integration or behavior-level proof wherever practical.
- A draft PR with branch, verification results, and residual risk returned to the chair.

Prefer these garden categories:

- **Refactor** - remove duplicated branches, collapse unnecessary helpers, delete shallow wrappers, or move logic to the canonical layer.
- **Integration-test gap** - add or strengthen a behavior-level test so future refactors are safer.
- **Seam** - make an ownership boundary clearer so future agents can work in fewer files with less cross-module context.
- **Deletion** - remove dead, redundant, or over-general code while preserving behavior.
- **DX** - improve local verification, error messages, command ergonomics, or docs that directly affect maintainability.
- **Performance** - simplify obviously wasteful orchestration or repeated work when the faster path is also clearer.

Example OpenCode dispatch shape:

```bash
opencode run "<garden brief>" -m openai/gpt-5.5 --variant high
```

Done when the gardener has a narrow mission and the chair has not preselected a code target.

## 3. Gardener: Set Workspace Guardrails

Inspect the repo before choosing work:

```bash
git status --short
git branch --show-current
git remote -v
```

Pick the base branch from the current PR when one exists, otherwise from the repository default branch:

```bash
gh pr view --json baseRefName --jq '.baseRefName'
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

If the worktree already has unrelated user changes, do not revert them. Either work around them or ask before touching the same files.

Create a branch if not already on a suitable feature branch:

```bash
git switch -c quality-garden/<short-target>
```

Done when the gardener knows the current branch, base branch, worktree state, and whether it is safe to edit.

## 4. Gardener: Hunt One Target

Use the thermo-nuclear quality lens to find one target with high leverage and low behavior risk. Explore only enough code to choose the target.

Do not edit until you can state:

- The target in one sentence.
- The files likely involved.
- The behavior that must stay fixed.
- Why this is the best small garden cut.

Done when the target is narrow enough that the PR can be reviewed as one coherent maintenance change.

## 5. Gardener: Require Isolated Behavior Proof

Find the narrowest verification that proves behavior. Favor integration tests because garden changes should survive internal reshaping.

Integration tests must be safe to run in isolation from the user's live setup. They should use temporary roots/homes and override tool config locations instead of touching real files such as `~/.config/opencode`, `~/.claude`, `~/.claude.json`, `~/.config/mise`, or the user's active shell/dotfiles. In this repo, prefer temp `root` and `home` fixtures plus environment overrides such as `MFZ_ROOT`, `MFZ_HOME`, `OPENCODE_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, and XDG paths.

Treat missing test isolation as a garden target. If a real behavior cannot be tested without affecting local state, the correct maintenance change may be adding a CLI flag, environment variable, dry-run path, dependency injection seam, or fixture helper that lets integration tests exercise the behavior safely.

Use this order:

1. Existing integration test that exercises the public behavior.
2. New or strengthened integration test through the real CLI, API, renderer, or user-facing interface.
3. Source-level test only when the behavior has no practical integration seam.
4. Build, lint, or typecheck only as supporting evidence, not the main proof.

If no meaningful isolated test can be added in scope, say that explicitly in the PR body and keep the code change smaller.

Done when the behavior contract is named and either covered by an isolated test or consciously documented as a residual risk.

## 6. Gardener: Change, Verify, And Open PR

Make the smallest behavior-preserving change that improves the target. Prefer deletion and consolidation over new abstractions. Avoid fallback paths, compatibility layers, speculative options, and broad rewrites.

Keep a running check against the garden categories:

- Did maintainability improve in the touched area?
- Did test confidence improve or stay strong?
- Did the change reduce code, branches, casts, or cross-file context?
- Did public behavior stay the same?

Run the narrowest meaningful verification first, then broader checks only when the touched area justifies them:

```bash
pnpm test -- <focused-file>
pnpm test:integration
pnpm build
pnpm check
```

If verification fails, fix in scope. If a failure is unrelated and not small, report the exact command and diagnostic instead of hiding it.

Review the final branch before writing the PR:

```bash
git status --short
git diff --stat
git diff <base>...HEAD
git log <base>..HEAD --oneline
```

Commit only the intended files. Use a Conventional Commit that names the maintenance outcome, not the tool or agent:

```bash
git add <intended-files>
git commit -m "refactor: tighten <area>"
git push -u origin HEAD
```

Load the `pr-writer` skill if available. If it is not enabled, read `skills/pr-writer/SKILL.md` or follow its reader-first doctrine: write for the reviewer, not as a changelog or test transcript.

Create or update a draft PR with `gh`. The PR body should say, in reader-first prose:

- What maintainability problem this garden pass addressed.
- Why this target was chosen over broader cleanup.
- What behavior is intended to remain unchanged.
- What integration or behavior-level verification protects that behavior, without adding a generic test-plan section.
- Any test gap or residual risk the reviewer should know.

Return the PR URL, branch name, verification results, changed files, and residual risk to the chair. Do not review your own PR.

Done when the PR exists and the gardener has stopped.

## 7. Chair: Dispatch The Reviewer

Send the finished PR to the reviewer. The reviewer gets a read-only task: inspect the PR diff and return merge/hold.

Reviewer prompt shape:

```text
Review this PR as a behavior-preserving quality garden pass. Apply the thermo-nuclear code quality rubric. Decide whether this should merge.

Return:
- Verdict: Merge / Hold
- Confidence: 1-5
- Findings: blocking issues first, with file references
- Test confidence: whether the isolated integration or behavior-level proof is enough
- Residual risk: what the human should consider before approving
```

Done when the reviewer has the PR URL, branch/base, and read-only instructions.

## 8. Reviewer: Read-Only Merge Gate

Read the PR diff and apply the thermo-nuclear code quality rubric. Do not assume the PR is good because the gardener wrote it.

Check especially:

- Behavior stayed unchanged.
- The target stayed scoped.
- The isolated integration or behavior-level proof is enough.
- The change improved maintainability, seams, deletion, DX, or performance.
- The PR did not add fallback paths, speculative abstraction, or unrelated cleanup.

This is a read-only review phase. Do not edit files unless the user asks for a follow-up pass.

Done when you have returned a real merge/hold verdict, not a generic summary.

## 9. Chair: Hand The Decision To The User

Do not merge automatically. Report:

- PR URL.
- Gardener and reviewer agent/model.
- One-line garden scope.
- Verification commands and results.
- Reviewer verdict and confidence.
- Your recommendation: merge or hold, with the reason.

Ask the user whether to approve, request changes, or continue gardening the same PR.
