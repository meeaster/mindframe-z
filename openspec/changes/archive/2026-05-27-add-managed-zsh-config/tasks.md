## 1. Model And Rendering

- [x] 1.1 Decide whether managed zsh startup content uses the existing dotfiles map or a minimal zsh-specific profile field.
- [x] 1.2 Add rendering for a managed `~/.zshrc` that includes shared profile content, a protected secrets include, and a non-secret local include.
- [x] 1.3 Ensure dotfile apply links the rendered zsh startup file to `~/.zshrc` using the existing safe symlink flow.
- [x] 1.4 Keep secret values out of profiles, rendered configs, schemas, fixtures, and tests.

## 2. Agent Permissions

- [x] 2.1 Define the default zsh secrets directory path outside the managed profile/config tree.
- [x] 2.2 Render OpenCode permissions that deny access to the zsh secrets directory.
- [x] 2.3 Render Claude Code permissions that deny access to the zsh secrets directory.
- [x] 2.4 Verify managed zsh files remain readable/editable by agents while the secrets directory is denied.

## 3. Profile Content And Migration

- [x] 3.1 Add profile-owned zsh startup content for the shared terminal setup without oh-my-zsh template comments.
- [x] 3.2 Move secret environment variable examples into documentation as placeholders only, not real values.
- [x] 3.3 Document how users split an existing `.zshrc` into managed content, secret env vars, and local non-secret overrides.

## 4. Tests And Documentation

- [x] 4.1 Add integration coverage for rendering and linking managed `~/.zshrc`.
- [x] 4.2 Add coverage that absent secrets and local include files do not break shell startup content.
- [x] 4.3 Add coverage for rendered agent deny permissions for the zsh secrets directory.
- [x] 4.4 Update architecture or usage documentation if the dotfiles model or permission model changes.
- [x] 4.5 Run `pnpm schemas` if manifest schemas change.
- [x] 4.6 Run the relevant test suite and `pnpm check` when implementation is complete.
