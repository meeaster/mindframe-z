## ADDED Requirements

### Requirement: Real releases are cut from explicit semver tags

mindframe-z SHALL provide a manual `cut-release` workflow that requires the maintainer to choose the real release tag explicitly. Real release tags SHALL use the format `vMAJOR.MINOR.PATCH`.

#### Scenario: Maintainer chooses the real tag

- **WHEN** the maintainer starts the cut-release workflow
- **THEN** mindframe-z SHALL require an explicit real release tag such as `v0.3.0`
- **AND** it SHALL not infer the version automatically

### Requirement: Cut-release is tag-first and GitHub-release-second

The cut-release workflow SHALL treat the real git tag as the canonical release boundary and the GitHub release as the publication layer for that tag.

#### Scenario: Release is created for a new tag

- **WHEN** the maintainer chooses a new real semver tag
- **THEN** mindframe-z SHALL create or use that real tag before creating or updating the GitHub release for it

### Requirement: Cut-release previews and allows refinement before publish

The cut-release workflow SHALL generate release notes for the chosen range, preview the AI summary and deterministic detailed changes, and allow the maintainer to retry or edit the AI summary before proceeding.

#### Scenario: Maintainer retries summary

- **WHEN** the maintainer reviews the generated AI summary and asks for another pass
- **THEN** mindframe-z SHALL regenerate or revise the summary without changing the deterministic detailed-changes section

### Requirement: Cut-release supports draft, publish, or cancel

After previewing the generated release notes, the maintainer SHALL be able to cancel, create or update a draft real GitHub release, or publish the real GitHub release immediately.

#### Scenario: Maintainer leaves the real release as draft

- **WHEN** the maintainer chooses the draft option
- **THEN** mindframe-z SHALL create or update the real GitHub release in draft state for the chosen real tag

#### Scenario: Maintainer publishes immediately

- **WHEN** the maintainer chooses the publish option
- **THEN** mindframe-z SHALL create or update and publish the real GitHub release for the chosen real tag

### Requirement: Real release body contains summary plus deterministic detailed changes

For non-initial releases, the real GitHub release body SHALL contain the AI summary first and the deterministic detailed-changes section below it.

#### Scenario: Non-initial release body

- **WHEN** the chosen real release is not the repository's first real semver release
- **THEN** the published or draft release body SHALL contain the AI summary followed by the deterministic `Pull Requests` and `Direct Commits` sections

### Requirement: Initial release is summary-only

If no prior real semver release tag exists, the first real release SHALL be summary-only rather than including the full historical detailed-changes ledger.

#### Scenario: First real release

- **WHEN** the maintainer cuts the repository's first real semver release
- **THEN** the generated release body SHALL contain the AI summary only
- **AND** it SHALL omit the historical detailed-changes ledger

### Requirement: Breaking changes are explicitly confirmed

When the generated summary suggests a possible breaking change, mindframe-z SHALL require maintainer confirmation before presenting it as a breaking change in the real release notes.

#### Scenario: Possible breaking change is confirmed

- **WHEN** the generated summary identifies a possible breaking change and the maintainer confirms it
- **THEN** the real release notes SHALL include a dedicated `Breaking Changes` section near the top of the summary

#### Scenario: Possible breaking change is rejected

- **WHEN** the generated summary identifies a possible breaking change and the maintainer rejects it
- **THEN** the real release notes SHALL not present that change under `Breaking Changes`

### Requirement: Re-running cut-release for the same tag updates the same real release

The cut-release workflow SHALL be idempotent for a real release tag. Re-running it for the same tag SHALL update the existing real draft release instead of creating a duplicate.

#### Scenario: Existing real draft release is updated

- **WHEN** the maintainer runs cut-release again for an existing real draft release tag
- **THEN** mindframe-z SHALL update that existing release
- **AND** it SHALL not create another draft release for the same tag

### Requirement: Successful release cut resets the rolling draft baseline

After mindframe-z successfully creates or updates the real GitHub release for a new real semver tag, it SHALL reset the rolling `Next Release` draft so it starts tracking unreleased changes after that new real tag.

#### Scenario: Rolling draft resets after release cut

- **WHEN** a new real semver release has been successfully created or updated for `v0.3.0`
- **THEN** the rolling `Next Release` draft SHALL start tracking changes after `v0.3.0`
