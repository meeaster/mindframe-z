## ADDED Requirements

### Requirement: A single rolling Next Release draft is maintained on main

mindframe-z SHALL maintain exactly one rolling GitHub draft release titled `Next Release`, attached to the synthetic mutable tag `next-release`.

#### Scenario: Push to main updates the rolling draft

- **WHEN** new commits land on `main`
- **THEN** mindframe-z SHALL update the existing `Next Release` draft in place rather than creating another rolling draft release

### Requirement: Rolling draft content is derived from real semver tags

The rolling draft SHALL be derived from git history between the latest real semver tag matching `vMAJOR.MINOR.PATCH` and `HEAD`. The `next-release` synthetic tag and GitHub release state SHALL not be treated as the source of truth for this range.

#### Scenario: Existing real release tag defines the base

- **WHEN** the repository already contains a latest real tag such as `v0.2.0`
- **THEN** the rolling draft SHALL represent unreleased changes between `v0.2.0` and `HEAD`

### Requirement: Rolling draft body uses deterministic detailed changes only

The rolling `Next Release` draft SHALL contain the deterministic detailed-changes section only. It SHALL not include the AI summary.

#### Scenario: Draft update preserves factual view

- **WHEN** the rolling draft is updated after new work lands on `main`
- **THEN** the draft body SHALL show only the deterministic `Pull Requests` and `Direct Commits` sections for the current unreleased range

### Requirement: First-release mode uses a placeholder instead of full history

If the repository has no real semver release tags yet, mindframe-z SHALL treat the release base as the initial commit for later real-release calculations, but the rolling `Next Release` draft SHALL show a short initial-release placeholder instead of enumerating the entire historical ledger.

#### Scenario: No real release tags yet

- **WHEN** no tag matching `vMAJOR.MINOR.PATCH` exists in the repository
- **THEN** the rolling `Next Release` draft SHALL show an initial-release placeholder message
- **AND** it SHALL not render the full historical `Pull Requests` and `Direct Commits` ledger
