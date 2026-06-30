## 1. Shared Release Engine

- [ ] 1.1 Add a shared release-history module under `src/release/` that resolves the latest real `vMAJOR.MINOR.PATCH` tag, detects first-release mode, and computes the git range for release notes
- [ ] 1.2 Implement change collection that collapses confidently associated merged pull requests into single entries and leaves unmatched changes as direct commits
- [ ] 1.3 Implement deterministic detailed-changes markdown rendering with `Pull Requests` and `Direct Commits` sections, oldest-first ordering, and empty-section omission
- [ ] 1.4 Implement structured summary inputs so the local AI release workflow can inspect PR bodies and diffs in addition to the deterministic detailed changes
- [ ] 1.5 Add source tests for tag filtering, first-release mode, PR/direct-commit classification, and markdown rendering

## 2. Rolling Next Release Draft

- [ ] 2.1 Add a GitHub Actions workflow that runs on pushes to `main` and updates a single rolling draft release titled `Next Release` on the `next-release` synthetic tag
- [ ] 2.2 Make the workflow derive its unreleased range from the latest real `vMAJOR.MINOR.PATCH` tag rather than GitHub release state
- [ ] 2.3 Implement the first-release placeholder path so the rolling draft does not emit the full historical ledger before the first real release exists
- [ ] 2.4 Verify the rolling draft body uses only the deterministic detailed-changes section

## 3. Local Release Skills

- [ ] 3.1 Add repo-local `.claude/skills/release-notes/SKILL.md` that takes exactly two refs and produces the AI summary plus deterministic detailed changes for that range
- [ ] 3.2 Add repo-local `.claude/skills/cut-release/SKILL.md` as a manual-only orchestrator that asks for the real semver tag, calls release-notes, previews the output, and supports retry/edit of the AI summary
- [ ] 3.3 Implement the `cut-release` flow to create or update the real GitHub release for the chosen tag, with draft / publish / cancel choices
- [ ] 3.4 Implement explicit maintainer confirmation for any `Breaking Changes` section before publishing or saving the real release body
- [ ] 3.5 Make rerunning the cut-release flow for the same real tag update the existing real draft release instead of creating duplicates

## 4. Release Reset And First Release Behavior

- [ ] 4.1 After a successful real release cut, reset the rolling `Next Release` draft so it tracks changes after the new real tag
- [ ] 4.2 Make the first real release summary-only while later real releases include both the summary and deterministic detailed changes

## 5. Documentation And Verification

- [ ] 5.1 Update maintainer docs (`README.md`, `ARCHITECTURE.md`, or both) to describe the tag-driven release model, the `next-release` synthetic tag, and the two release skills
- [ ] 5.2 Add verification coverage for the GitHub-release integration seams used by the rolling draft and cut-release flow
