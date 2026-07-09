## MODIFIED Requirements

### Requirement: Managed zsh startup file
mindframe-z SHALL render a profile-managed zsh startup file for the active profile and link it as the user's `~/.zshrc` when dotfiles are applied.

#### Scenario: Applying managed zsh config
- **WHEN** the active profile declares managed zsh startup content and the user runs `mfz apply --target dotfiles`
- **THEN** mindframe-z renders the zsh startup file under `~/.mindframe-z/configs/<profile>/` and plans a link to `~/.zshrc`

### Requirement: Managed Powerlevel10k configuration
mindframe-z SHALL support managing portable Powerlevel10k prompt configuration as a profile-owned `.p10k.zsh` dotfile linked to the user's home directory.

#### Scenario: Applying managed p10k config
- **WHEN** the active profile declares `.p10k.zsh` content and the user runs `mfz apply --target dotfiles`
- **THEN** mindframe-z renders `.p10k.zsh` under `~/.mindframe-z/configs/<profile>/dotfiles/` and plans a link to `~/.p10k.zsh`

#### Scenario: Managed zsh config sources p10k config
- **WHEN** the managed zsh startup file is evaluated and `~/.p10k.zsh` exists
- **THEN** the shell sources `~/.p10k.zsh`

## ADDED Requirements

### Requirement: Engine bin directory on PATH
The managed zsh startup file SHALL ensure `~/.mindframe-z/bin` is present on `PATH` so the engine launcher remains resolvable regardless of node version switches or shell customization.

#### Scenario: Managed zshrc guarantees engine PATH
- **WHEN** the rendered zsh startup file is evaluated
- **THEN** `~/.mindframe-z/bin` is on `PATH` in the resulting shell
