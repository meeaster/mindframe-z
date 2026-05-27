## Why

mindframe-z already shares arbitrary dotfiles across profiles, but shell startup files need a safer convention because they commonly mix portable aliases, PATH setup, prompt configuration, and machine-local secrets. Supporting managed zsh config lets machines share the same terminal behavior while keeping secret environment variables outside agent-editable profile files.

## What Changes

- Add support for mindframe-z-owned zsh startup config, with `~/.zshrc` rendered from the active profile and linked like other managed dotfiles.
- Define a protected machine-local secrets include for zsh environment variables, stored under the existing mindframe local dot folder and outside the profile/config render tree.
- Create an empty zsh secrets file when applying managed dotfiles if it does not already exist, without overwriting existing secrets.
- Manage portable Powerlevel10k configuration as a profile-owned dotfile while leaving theme installation out of scope.
- Ensure rendered agent permissions can allow interaction with managed zsh config while denying access to the secrets folder.
- Keep machine-specific non-secret customization possible through a local zsh include file.
- Do not manage oh-my-zsh installation, p10k installation, fonts, or secret values in repository profiles.

## Capabilities

### New Capabilities
- `managed-zsh-config`: Profile-managed zsh startup config with protected local secret loading and machine-local extension hooks.

### Modified Capabilities

None.

## Impact

- Profile manifests and/or profile-owned dotfile conventions for zsh startup files.
- Dotfiles rendering and symlink planning for `~/.zshrc` and related shell files.
- Agent permission rendering for OpenCode and Claude Code secret-folder deny rules.
- Documentation and tests covering zsh rendering, local includes, and secret-folder isolation.
