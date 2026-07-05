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
- **Merger** - reads the PR description, diff, verification, and reviewer comment, then decides approve/deny.
- **Chair** - coordinates role handoffs and reports the decision to the user.

The same agent should not be both gardener and reviewer, or reviewer and merger, unless the user explicitly accepts the weaker gate.

## 0. Identify Your Role

Before doing any work, decide which role you are playing in this invocation. Only run the sections for that role.

- **Claude chair** - You are Claude Code and the user invoked `quality-garden` directly. Run sections 1-2, wait for the gardener's PR, then run sections 7, 9, and 11. Do not run the reviewer or merger section yourself.
- **OpenCode gardener** - You are OpenCode and the prompt asks you to perform the garden pass. Run sections 3-6. Stop after returning the PR URL, branch, verification results, and residual risk. Do not review your own PR.
- **OpenCode chair** - You are OpenCode and the user invoked `quality-garden` directly. Run sections 1 and 3-7, dispatch independent Claude agents for sections 8 and 10, then run section 11. Do not run the reviewer or merger section yourself.
- **Claude reviewer** - You are Claude Code and the prompt asks you to review an existing garden PR. Run section 8. Do not edit files.
- **Claude merger** - You are Claude Code and the prompt asks you to make the final quality-garden merge decision. Run section 10. Do not edit files.

If the prompt does not make your role clear, ask one short clarification before starting. Do not silently choose a role that would make you both gardener and reviewer.

Done when you can name your role and the sections you will run.

## 1. Chair: Choose The Handoff

Load the `thermo-nuclear-code-quality-review` skill so you understand the quality bar the gardener and reviewer will apply. Do not use it to explore the codebase or choose a target; that remains gardener-owned.

Pick the direction that matches the invoking environment:

- **Claude chair -> OpenCode gardener -> independent reviewer -> independent merger**: Claude writes the brief, dispatches OpenCode to garden and create the PR, dispatches a separate reviewer, then dispatches a separate merger for the final approve/deny decision.
- **OpenCode chair/gardener -> independent reviewer -> independent merger**: OpenCode gardens and creates the PR, then dispatches separate Claude agents for review and merge decision.

Use the best available model for each role. Default to OpenCode GPT-5.5 for the gardener when available, a general reviewer subagent on Claude Opus 4.8/high effort when available, and Claude Code `fable`/high effort for the merger when available. Treat those as defaults, not requirements. Record which agent/model performed each role.

The chair does not explore the codebase, choose the target, run verification, perform the merge-gate review, or make the final merge decision. Those belong to the gardener, reviewer, and merger.

Mode defaults to **manual**. Use **auto** only when the user explicitly says to auto-run, auto-approve/deny, or otherwise authorizes the merger to perform the final GitHub action without another confirmation. Pass the mode to the merger unchanged.

Done when the chair knows who is gardening, who is reviewing, and what command or prompt will hand off to the next role.

## 2. Chair: Write The Gardener Brief

Write a lean brief for the gardener. Do not duplicate the gardener rules from this skill; the gardener will load the skill and follow its own role sections.

The brief should contain only:

- The instruction to load `quality-garden` and assume the **OpenCode gardener** role.
- Any user-provided scope, exclusions, preferred area, or risk tolerance for this run.
- The base branch or PR context if already known.
- The chair identity and where to return the PR URL, branch, verification results, changed files, existing garden PRs checked, and residual risk.

Do not preselect a code target unless the user explicitly supplied one. Target selection belongs to the gardener.

Example brief:

```text
Load the quality-garden skill and assume the OpenCode gardener role.

Run one behavior-preserving garden pass in this repository. No user-specified target; choose one according to the skill. Return the PR URL, branch, verification results, changed files, existing quality-garden PRs checked, and residual risk to the chair.
```

Example OpenCode dispatch shape:

```bash
opencode run "<garden brief>" -m openai/gpt-5.5 --variant high
```

Done when the gardener has the role instruction plus run-specific context, with no copied checklist from this skill.

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

Before exploring new code, check existing open garden work:

```bash
gh label list --search quality-garden --json name
gh pr list --state open --label quality-garden --json number,title,url,body,headRefName,baseRefName,files
```

If the label does not exist, treat that as no existing garden PRs and continue; create the label before opening this run's PR. If the label exists, read the title and body for every open `quality-garden` PR. Read changed file lists for all of them. Read the actual diff only for PRs that might overlap the area you are considering. Do not duplicate an existing garden PR; either choose a different target or, if the existing PR already covers the best target, stop and report that to the chair.

Use the thermo-nuclear quality lens to find one target with high leverage and low behavior risk. Explore only enough code to choose the target.

Test confidence is part of target selection. If the attractive refactor has no isolated integration coverage, usually pivot the garden target to the test gap first. A garden PR that adds the missing integration seam or behavior test is a successful pass even if the production refactor is deferred.

Prefer these garden categories:

- **Refactor** - remove duplicated branches, collapse unnecessary helpers, delete shallow wrappers, or move logic to the canonical layer.
- **Integration-test gap** - add or strengthen a behavior-level test so future refactors are safer.
- **Seam** - make an ownership boundary clearer so future agents can work in fewer files with less cross-module context.
- **Deletion** - remove dead, redundant, or over-general code while preserving behavior.
- **DX** - improve local verification, error messages, command ergonomics, or docs that directly affect maintainability.
- **Performance** - simplify obviously wasteful orchestration or repeated work when the faster path is also clearer.

Do not edit until you can state:

- The target in one sentence.
- The files likely involved.
- The behavior that must stay fixed.
- The integration or behavior-level proof that will catch regressions.
- Which open `quality-garden` PRs you checked and why this target does not duplicate them.
- Why this is the best small garden cut.

Done when the target is narrow enough that the PR can be reviewed as one coherent maintenance change.

## 5. Gardener: Require Isolated Behavior Proof

Find the narrowest verification that proves behavior. Favor integration tests because garden changes should survive internal reshaping.

Integration tests must be safe to run in isolation from the user's live setup. They should use temporary roots/homes and override tool config locations instead of touching real files such as `~/.config/opencode`, `~/.claude`, `~/.claude.json`, `~/.config/mise`, or the user's active shell/dotfiles. In this repo, prefer temp `root` and `home` fixtures plus environment overrides such as `MFZ_ROOT`, `MFZ_HOME`, `OPENCODE_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, and XDG paths.

Treat missing test isolation as a garden target. If a real behavior cannot be tested without affecting local state, the correct maintenance change may be adding a CLI flag, environment variable, dry-run path, dependency injection seam, or fixture helper that lets integration tests exercise the behavior safely.

Do not perform a refactor just because it looks maintainable if you cannot prove the behavior still works. First try to add isolated coverage. If adding coverage is bigger than the refactor, make the PR about the coverage gap and explain the deferred follow-up refactor.

Use this order:

1. Existing integration test that exercises the public behavior.
2. New or strengthened integration test through the real CLI, API, renderer, or user-facing interface.
3. Source-level test only when the behavior has no practical integration seam.
4. Build, lint, or typecheck only as supporting evidence, not the main proof.

If no meaningful isolated test can be added in scope, say that explicitly in the PR body and keep the code change smaller. The PR should make the missing proof obvious enough that the reviewer can decide whether to hold the change.

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

Label the PR as `quality-garden`. If the label does not exist, create it first:

```bash
gh label create quality-garden --description "Behavior-preserving maintenance garden" --color 2da44e
gh pr edit <pr> --add-label quality-garden
```

Return the PR URL, branch name, verification results, changed files, existing garden PRs checked, and residual risk to the chair. Do not review your own PR.

Done when the PR exists and the gardener has stopped.

## 7. Chair: Dispatch The Reviewer

Send the finished PR to an independent reviewer. Prefer a general subagent on Claude Opus 4.8/high effort when available. The reviewer gets a read-only task: inspect the PR diff, post the review as a PR comment, and return merge/hold.

The chair must not perform the review in its own context. Reviewing a PR from the same orchestrator context that dispatched the gardener weakens the two-party gate.

Reviewer prompt shape:

```text
Review this PR as a behavior-preserving quality garden pass. Apply the thermo-nuclear code quality rubric. Decide whether this should merge.

Return:
- Verdict: Merge / Hold
- Confidence: 1-5
- Findings: blocking issues first, with file references
- Test confidence: what verifies the changed behavior, whether the isolated integration or behavior-level proof is enough, and what regressions it would catch
- Residual risk: what the human should consider before approving

Post the same review as a comment on the PR so the PR page contains the merge-gate context.
```

Done when the reviewer has the PR URL, branch/base, and read-only instructions to comment on the PR.

## 8. Reviewer: Read-Only Merge Gate

Read the PR diff and apply the thermo-nuclear code quality rubric. Do not assume the PR is good because the gardener wrote it.

Check especially:

- Behavior stayed unchanged.
- The target stayed scoped.
- The isolated integration or behavior-level proof is enough.
- If isolated proof is missing, the PR is usually Hold unless it is explicitly a testability-enabling change or the production change is tiny and low risk.
- The change improved maintainability, seams, deletion, DX, or performance.
- The PR did not add fallback paths, speculative abstraction, or unrelated cleanup.

This is a read-only review phase. Do not edit files unless the user asks for a follow-up pass.

Post the review as a PR comment before returning to the chair:

```bash
gh pr comment <pr> --body-file <review-file>
```

The comment should include the verdict, confidence, findings, test confidence, and residual risk. Do not rely on chat-only output; the PR should be understandable later from GitHub alone.

Keep process bookkeeping out of the PR comment. Do not mention that the gardener checked existing `quality-garden` PRs, avoided another PR, followed the skill, used a particular orchestration path, or returned required fields unless that fact is itself a review finding. Include overlap with another PR only when it creates a real merge risk, duplicated work, or a reason to hold.

Done when you have posted the review comment and returned a real merge/hold verdict, not a generic summary.

## 9. Chair: Dispatch The Merger

Send the finished PR and reviewer comment to an independent merger. Prefer Claude Code `fable` with high effort when available. The merger gets a read-only decision task unless the user explicitly requested `auto` mode.

The chair must not make the final approve/deny decision in its own context. The merger is the final gate that weighs the PR description, code changes, verification, and reviewer comment.

Merger prompt shape:

```text
Load the quality-garden skill and assume the Claude merger role.

Decide whether this quality-garden PR should be approved or denied. Read the PR description, changed files, diff, verification details, and posted reviewer comment. Use Claude Code fable/high effort if available.

Mode: <manual|auto>

Post a PR comment with the decision, then return:
- Decision: Approve / Deny
- Confidence: 1-5
- Basis: concise reasons grounded in PR body, diff, verification, and reviewer comment
- Action taken: PR comment only in manual mode; exact GitHub action in auto mode

In manual mode, do not change PR state beyond the decision comment. In auto mode, perform the approve or deny action after posting the decision comment.
```

Done when the merger has the PR URL, review comment context, mode, and read-only/default action rules.

## 10. Merger: Final Approve Or Deny

Read the PR as a whole. Do not re-run the garden review from scratch unless the reviewer comment is missing, low quality, or contradicted by the diff.

Use these inputs:

- PR title and body.
- Changed files and diff.
- Verification commands and what they cover.
- Reviewer PR comment and verdict.
- Any unresolved checks, comments, merge conflicts, or stale base branch state.

Decide:

- **Approve** - the PR is scoped, behavior-preserving, verified enough, and the reviewer found no blocker.
- **Deny** - the PR has a blocker, insufficient proof, duplicated active work, unclear behavior risk, or a reviewer `Hold` that was not resolved.

Post the merger decision as a PR comment. The comment should include decision, confidence, basis, and any action taken. Keep it short; do not repeat the full reviewer comment.

In manual mode, stop after posting/commenting the decision and return the recommended action to the chair. Do not mark ready, approve, merge, close, or request changes.

In auto mode, perform the decision after posting the comment:

- For **Approve**, mark the PR ready if it is draft, approve it, and merge it using the repository's normal merge method.
- For **Deny**, request changes with the decision comment. Close the PR only if the user or run-specific instruction explicitly says denied PRs should be closed.

Useful commands:

```bash
gh pr comment <pr> --body-file <decision-file>
gh pr ready <pr>
gh pr review <pr> --approve --body-file <decision-file>
gh pr merge <pr>
gh pr review <pr> --request-changes --body-file <decision-file>
```

Done when the merger has posted the decision and either returned a manual recommendation or completed the requested auto action.

## 11. Chair: Hand The Decision To The User

Report:

- PR URL.
- Gardener, reviewer, and merger agent/model.
- One-line garden scope.
- Verification commands and results.
- Reviewer verdict and confidence.
- Merger decision and confidence.
- Links or notes that the reviewer and merger comments were posted on the PR.

In manual mode, ask the user whether to approve, deny, request changes, merge, close, or continue gardening the same PR. In auto mode, report the action the merger already took.
