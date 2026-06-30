## Why

mindframe-z has no coherent release workflow yet. We need one release model that works with this repo's mix of merged pull requests and direct commits to `main`, gives maintainers a trustworthy rolling view of unreleased work, and supports a human-reviewed AI summary when cutting a real GitHub release.

## What Changes

- Add a deterministic release-notes workflow that generates release notes for an explicit git ref range, combining an AI-written summary with a factual detailed-changes section.
- Add a rolling `Next Release` GitHub draft release, maintained from git history on `main` and backed by a synthetic mutable tag `next-release`.
- Add a manual `cut-release` workflow that asks for the real semver tag, previews and allows retry/edit of the AI summary, creates or updates the real GitHub release, and can either leave it draft or publish it immediately.
- Special-case the first release so the rolling draft shows an initial-release placeholder and the first real release is summary-only rather than dumping the entire historical commit ledger.
- Keep real release boundaries tag-driven: real releases use immutable `vMAJOR.MINOR.PATCH` git tags, while the rolling draft is only a projection of unreleased work.

## Capabilities

### New Capabilities
- `release-notes`: Generate release notes for an explicit git ref range, including an AI summary and deterministic detailed changes.
- `next-release-draft`: Maintain a single rolling `Next Release` GitHub draft release from the latest real semver tag to `HEAD`.
- `release-cut`: Cut a real GitHub release from an explicit semver tag using a previewable, human-in-the-loop workflow.

### Modified Capabilities
- None.

## Impact

- New release-history collection and rendering code, likely under a shared `src/release/` module with tests.
- New GitHub Actions workflow(s) to update the rolling `Next Release` draft on pushes to `main`.
- New repo-local skills for `release-notes` and `cut-release`, plus any supporting docs/scripts they need.
- README / architecture / maintainer docs describing the new release model, including the `next-release` synthetic tag.
