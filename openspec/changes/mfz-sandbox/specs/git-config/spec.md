## ADDED Requirements

### Requirement: Managed git identity via include without clobbering host config

mindframe-z SHALL manage git identity (`user.name`, `user.email`) through a native git
`[include]` directive rather than by overwriting `~/.gitconfig`, so existing
user-curated git config (aliases, signing, `includeIf`, credential helpers) is
preserved. During apply, mindframe-z SHALL render the identity into a machine-local
fragment (e.g. `~/.mindframe-z/gitconfig`) sourced from machine config
(`~/.mindframe-z/config.yml`), and SHALL ensure `~/.gitconfig` contains an idempotent
`[include] path = <fragment>` entry. Identity values SHALL NOT be stored in profile
manifests or committed config.

#### Scenario: Existing host git config is preserved

- **WHEN** `~/.gitconfig` already contains unrelated keys and the operator runs `mfz apply`
- **THEN** those keys are left unchanged and only an include directive plus the
  machine-local identity fragment are managed

#### Scenario: Include directive is idempotent

- **WHEN** `mfz apply` runs more than once
- **THEN** at most one include directive for the managed fragment is present in
  `~/.gitconfig`

#### Scenario: Identity is rendered from machine config

- **WHEN** machine config declares git identity and the operator runs `mfz apply`
- **THEN** the machine-local fragment contains that `user.name` and `user.email`

#### Scenario: Identity is never committed

- **WHEN** the rendered profile config and repository are inspected
- **THEN** no git `user.name` or `user.email` value is present in profile manifests or
  committed config

#### Scenario: Missing identity writes no identity fields

- **WHEN** machine config declares no git identity and the operator runs `mfz apply`
- **THEN** mindframe-z does not write `user.name` or `user.email` into the fragment

### Requirement: Sandbox uses the same git identity via a clean composed config

The sandbox SHALL provide the container with the same git identity and global ignore
behavior as the host by mounting a clean composed git config into the container's fresh
`$HOME` (which has no pre-existing `~/.gitconfig` to preserve). The composed config
SHALL include the managed identity fragment and the global git ignore file
(`~/.config/git/ignore`) read-only. Git authentication SHALL remain brokered through
Agent Vault `GH_TOKEN` and SHALL NOT be carried in the mounted git config.

#### Scenario: Container has host git identity

- **WHEN** the sandbox launches after apply rendered the git identity fragment
- **THEN** git commands inside the container use the same `user.name` and `user.email`
  as the host

#### Scenario: Container git config carries no auth token

- **WHEN** the mounted git config is inspected inside the container
- **THEN** it contains no GitHub token or other credential, and push auth is injected
  only by the Agent Vault broker
