## ADDED Requirements

### Requirement: Release notes are generated for an explicit git ref range

mindframe-z SHALL provide a `release-notes` workflow that takes exactly two git refs, a start ref and an end ref, and generates release notes for the changes reachable in that range.

#### Scenario: Maintainer requests release notes for a tagged range

- **WHEN** the maintainer runs the release-notes workflow for `v0.1.0` and `HEAD`
- **THEN** mindframe-z SHALL generate release notes from the git history between `v0.1.0` and `HEAD`
- **AND** the generated output SHALL not depend on GitHub release draft state

#### Scenario: Maintainer requests release notes for an arbitrary range

- **WHEN** the maintainer runs the release-notes workflow for two non-release refs such as `main~5` and `main`
- **THEN** mindframe-z SHALL generate release notes for that exact git range

### Requirement: Release notes include an AI summary and deterministic detailed changes

The release-notes workflow SHALL output two layers: an AI-written summary first, followed by a deterministic detailed-changes section.

#### Scenario: Small release produces concise summary

- **WHEN** the selected range contains a small set of changes
- **THEN** the AI summary SHALL stay concise
- **AND** the deterministic detailed-changes section SHALL still include every represented change

#### Scenario: Large release produces grouped summary

- **WHEN** the selected range contains multiple notable themes
- **THEN** the AI summary SHALL be allowed to group the changes by theme
- **AND** the deterministic detailed-changes section SHALL remain factual and unchanged in structure

### Requirement: Detailed changes are rendered as pull requests plus direct commits

The deterministic detailed-changes section SHALL render changes in two sections named `Pull Requests` and `Direct Commits`. Both sections SHALL be ordered oldest first. Empty sections SHALL be omitted.

#### Scenario: PR-backed changes are rendered once

- **WHEN** commits in the selected range can be confidently associated with a merged pull request
- **THEN** mindframe-z SHALL render one pull-request entry for that merged pull request
- **AND** the entry SHALL include the pull request title, number, and author username

#### Scenario: Unmatched changes are rendered as direct commits

- **WHEN** a commit in the selected range cannot be confidently associated with a merged pull request
- **THEN** mindframe-z SHALL render that change under `Direct Commits`
- **AND** the entry SHALL include the commit subject, short SHA, and author username

#### Scenario: No direct commits omits the section

- **WHEN** every represented change in the selected range is covered by merged pull requests
- **THEN** mindframe-z SHALL omit the `Direct Commits` section

### Requirement: Detailed changes are exhaustive and unfiltered

The deterministic detailed-changes section SHALL include every represented change in the selected range. It SHALL not filter out documentation, maintenance, tests, or other internal changes.

#### Scenario: Maintenance-only range is still included

- **WHEN** the selected range contains only maintenance, test, or documentation changes
- **THEN** mindframe-z SHALL still include those changes in the deterministic detailed-changes section

### Requirement: Summary generation inspects richer change context when available

When generating the AI summary, mindframe-z SHALL use the detailed changes as the stable base and SHALL inspect richer context when available, including pull request bodies and commit diffs.

#### Scenario: PR body is available

- **WHEN** a represented pull request has a body or other GitHub metadata available
- **THEN** mindframe-z SHALL allow the AI summary generation step to use that context when explaining or grouping changes

#### Scenario: Direct commit has no PR

- **WHEN** a represented change is a direct commit with no associated pull request
- **THEN** mindframe-z SHALL allow the AI summary generation step to use the commit diff and commit metadata for that change
