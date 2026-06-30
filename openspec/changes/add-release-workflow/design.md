## Context

mindframe-z currently has no release workflow beyond manual git and GitHub operations. The repo mixes merged pull requests with direct commits to `main`, which makes PR-only release tooling a bad fit for the factual change ledger. At the same time, maintainers want two distinct experiences:

- a continuously updated `Next Release` draft that shows all unreleased work in GitHub
- a local, human-in-the-loop release cut flow that uses AI to write a better release summary without hiding the full set of changes

The design therefore needs one shared release-history engine, one deterministic representation of detailed changes, and two surfaces that consume it differently: a GitHub Action for the rolling draft and local skills for cut-time orchestration.

## Goals / Non-Goals

**Goals:**
- Make real release boundaries tag-driven using immutable `vMAJOR.MINOR.PATCH` tags
- Maintain one rolling `Next Release` GitHub draft backed by a clearly synthetic mutable tag `next-release`
- Generate deterministic detailed changes that work for both pull requests and direct commits
- Support a portable `release-notes` skill that works on an explicit git ref range
- Support a manual `cut-release` skill that previews AI notes, allows retry/edit, and creates or updates the real GitHub release
- Special-case the first release so maintainers do not get a giant historical ledger dump

**Non-Goals:**
- Automated semver selection
- Prerelease support (`-rc`, `-beta`, etc.)
- Release asset building or upload
- Replacing git tags with GitHub Releases as the source of truth

## Decisions

### Decision 1: Build one shared release-history engine under source control

**Choice**: Add a shared release module, likely under `src/release/`, that:
- finds the latest real semver tag
- computes the release range
- associates commits with merged pull requests when GitHub can do so confidently
- renders the deterministic detailed-changes markdown
- provides richer structured data for AI summary generation

The rolling draft workflow and the local release skills both consume this same engine.

**Why**: The Action and the skills must agree on what changed. Two independent implementations would drift on edge cases such as PR association, first-release handling, and ordering.

**Alternatives considered**:
- Use `release-drafter` directly: rejected because it is PR-centered and does not make direct commits first-class ledger entries.
- Let the skills and GitHub Action each shell out to separate ad-hoc scripts: rejected because it would duplicate core range and rendering logic.

### Decision 2: Separate deterministic detailed changes from AI summary generation

**Choice**: The release-history engine produces deterministic detailed changes plus structured inputs for an AI summary, but the rolling draft publishes only the deterministic section. The AI summary is used only in the local `release-notes` / `cut-release` flow and the final real release body.

**Why**: The rolling draft should be an auditable ledger, not a mutable interpretation. AI belongs in the maintainer-reviewed cut-time path.

**Alternatives considered**:
- Put AI summaries into the rolling draft: rejected because it makes the live draft less trustworthy and more expensive to maintain.
- Skip AI entirely: rejected because the user explicitly wants a better maintainer-facing summary on real releases.

### Decision 3: Use a single synthetic mutable tag for the rolling GitHub draft

**Choice**: Keep one draft release titled `Next Release` attached to the mutable synthetic tag `next-release`.

**Why**: GitHub draft releases are tag-backed. A synthetic tag is the least-bad way to get the desired rolling-draft GitHub UX while preserving immutable real release tags as the actual release boundaries.

**Alternatives considered**:
- No synthetic tag, and store the rolling view in a file or issue: rejected because the user wants the rolling view to live in GitHub Releases.
- Reuse a semver-like next tag: rejected because it blurs the line between real releases and the synthetic draft marker.

### Decision 4: Keep the local UX skill-driven and manual

**Choice**: Ship exactly two repo-local skills:
- `release-notes`: generic, portable, takes two refs, and produces the AI summary plus deterministic detailed changes
- `cut-release`: manual-only orchestrator that chooses the real tag, calls release-notes, previews or retries the summary, creates or updates the real GitHub release, and optionally publishes it

The canonical checked-in definitions live in `.claude/skills/` so both Claude Code and OpenCode can discover them.

**Why**: This matches the requested human workflow better than adding another public CLI surface. It also keeps the risky publish step manual while still making the note-generation primitive reusable.

**Alternatives considered**:
- Expose the whole flow as a public `mfz release` command first: rejected because the user explicitly wants an AI-assisted maintainer workflow, not only a non-interactive CLI.
- Fold everything into one skill: rejected because `release-notes` should remain portable and reusable.

### Decision 5: First release is a deliberate special-case

**Choice**: When no real semver tag exists, treat the initial commit as the base for later calculations, but:
- show only a short placeholder in the rolling draft
- generate a summary-only first real release body

**Why**: A repository that already has history would get a noisy and low-value first changelog if we rendered the entire ledger immediately.

**Alternatives considered**:
- Require a bootstrap SHA or tag: rejected for this repo because the user prefers the initial commit as the conceptual origin.
- Render full history on the first release: rejected because it would bury the useful summary in historical noise.

## Risks / Trade-offs

**[Risk] `next-release` can be mistaken for a real release tag** → Mitigation: keep the name obviously synthetic, document it in maintainer docs, and ensure all real-release logic filters strictly to `vMAJOR.MINOR.PATCH` tags.

**[Risk] GitHub PR association can be incomplete or laggy** → Mitigation: only collapse commits into PR entries when the association is confident; otherwise keep them as direct commits.

**[Risk] AI summary can overstate or misclassify breaking changes** → Mitigation: require maintainer confirmation before rendering a `Breaking Changes` section in the final release notes.

**[Risk] Repo-local `.claude/skills/` definitions diverge from the existing `skills/` catalog pattern** → Mitigation: limit this exception to repo-owned release workflows, and document that these are project-local operational skills rather than globally installed catalog skills.

## Migration Plan

1. Add the shared release-history engine and tests.
2. Add the rolling `Next Release` workflow and create the first synthetic `next-release` draft.
3. Add the repo-local `release-notes` and `cut-release` skills.
4. Document the release model for maintainers.
5. Cut the first real release manually using the new skill flow.

## Open Questions

- None at proposal time; the design decisions above are sufficient to proceed to implementation.
