## Purpose

Define how mindframe-z manages zsh startup and prompt configuration while keeping local shell secrets outside repository-managed files.

## Requirements

### Requirement: Managed zsh startup file
mindframe-z SHALL render a profile-managed zsh startup file for the active profile and link it as the user's `~/.zshrc` when dotfiles are applied.

#### Scenario: Applying managed zsh config
- **WHEN** the active profile declares managed zsh startup content and the user runs `mfz apply --target dotfiles`
- **THEN** mindframe-z renders the zsh startup file under `~/.mindframe-z/configs/<profile>/` and plans a link to `~/.zshrc`

### Requirement: Protected zsh secrets include
The managed zsh startup file SHALL source a machine-local zsh secrets file when that file exists, and secret values SHALL NOT be stored in profile manifests or rendered profile config.

#### Scenario: Secrets file exists
- **WHEN** the rendered zsh startup file is evaluated and the configured zsh secrets file exists
- **THEN** the shell sources the secrets file

#### Scenario: Secrets file is absent
- **WHEN** the rendered zsh startup file is evaluated and the configured zsh secrets file is absent
- **THEN** shell startup continues without an error

### Requirement: Zsh secrets file initialization
mindframe-z SHALL create an empty machine-local zsh secrets file when applying managed dotfiles if that file does not already exist, and SHALL NOT overwrite an existing zsh secrets file.

#### Scenario: Secrets file is missing during real apply
- **WHEN** the active profile declares managed zsh startup content and the user runs `mfz apply --target dotfiles`
- **THEN** mindframe-z creates an empty `~/.mindframe-z/secrets/zsh.env` file

#### Scenario: Secrets file already exists during real apply
- **WHEN** `~/.mindframe-z/secrets/zsh.env` already contains local secrets and the user runs `mfz apply --target dotfiles`
- **THEN** mindframe-z leaves the existing file content unchanged

#### Scenario: Dotfiles are rendered without linking
- **WHEN** the active profile declares managed zsh startup content and the user runs `mfz apply --target dotfiles --no-link`
- **THEN** mindframe-z does not create or modify `~/.mindframe-z/secrets/zsh.env`

### Requirement: Agent access denied for zsh secrets
mindframe-z SHALL render agent permissions that deny read and edit access to the zsh secrets directory while preserving normal access to managed zsh configuration files.

#### Scenario: Agent permissions are rendered
- **WHEN** mindframe-z renders agent configuration for a profile with managed zsh support
- **THEN** the rendered agent configuration denies access to the zsh secrets directory

### Requirement: Machine-local non-secret zsh customization
The managed zsh startup file SHALL source a machine-local non-secret zsh customization file when that file exists.

#### Scenario: Local customization file exists
- **WHEN** the rendered zsh startup file is evaluated and the local customization file exists
- **THEN** the shell sources the local customization file

#### Scenario: Local customization file is absent
- **WHEN** the rendered zsh startup file is evaluated and the local customization file is absent
- **THEN** shell startup continues without an error

### Requirement: Managed Powerlevel10k configuration
mindframe-z SHALL support managing portable Powerlevel10k prompt configuration as a profile-owned `.p10k.zsh` dotfile linked to the user's home directory.

#### Scenario: Applying managed p10k config
- **WHEN** the active profile declares `.p10k.zsh` content and the user runs `mfz apply --target dotfiles`
- **THEN** mindframe-z renders `.p10k.zsh` under `~/.mindframe-z/configs/<profile>/dotfiles/` and plans a link to `~/.p10k.zsh`

#### Scenario: Managed zsh config sources p10k config
- **WHEN** the managed zsh startup file is evaluated and `~/.p10k.zsh` exists
- **THEN** the shell sources `~/.p10k.zsh`

### Requirement: Engine bin directory on PATH
The managed zsh startup file SHALL ensure `~/.mindframe-z/bin` is present on `PATH` so the engine launcher remains resolvable regardless of node version switches or shell customization.

#### Scenario: Managed zshrc guarantees engine PATH
- **WHEN** the rendered zsh startup file is evaluated
- **THEN** `~/.mindframe-z/bin` is on `PATH` in the resulting shell

### Requirement: Shell dependency installation out of scope
mindframe-z SHALL NOT install oh-my-zsh, the Powerlevel10k theme repository, fonts, or zsh plugins as part of managed zsh config rendering.

#### Scenario: Applying zsh config with oh-my-zsh references
- **WHEN** the managed zsh startup file references oh-my-zsh, a theme, or plugins
- **THEN** mindframe-z renders and links the startup config without installing those dependencies
