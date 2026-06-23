## ADDED Requirements

### Requirement: Upgrade refreshes git skills
`mfz skills upgrade` SHALL run `npx skills update` for each git-sourced skill enabled in the resolved profile.

#### Scenario: Upgrade updates git skills
- **WHEN** a git-sourced skill is enabled in the profile
- **THEN** `mfz skills upgrade` calls `npx skills update <skill-name> -g -y`

#### Scenario: Upgrade skips local skills
- **WHEN** a locally-sourced skill is enabled in the profile
- **THEN** `mfz skills upgrade` skips it and does not call `npx skills update`

### Requirement: Upgrade never reconciles membership
`mfz skills upgrade` SHALL NOT add or remove skills from the installed set.

#### Scenario: Upgrade does not change installed skill list
- **WHEN** `mfz skills upgrade` is invoked
- **THEN** only `npx skills update` commands are executed; no `npx skills add` or `npx skills remove` commands are run
