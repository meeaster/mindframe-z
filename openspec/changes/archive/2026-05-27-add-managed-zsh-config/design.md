## Context

mindframe-z currently treats files placed directly in `profiles/<profile>/` as profile-owned dotfiles. Parent and child profile files with the same name are concatenated, rendered into `configs/<profile>/dotfiles/`, and linked into the user's home directory during `mfz apply --target dotfiles` or `--target all`.

That model is enough for simple files like `.npmrc`, but zsh startup config often mixes portable shell behavior with secrets and host-specific details. The desired operating model is that mindframe-z owns `~/.zshrc` for consistency across machines, while secret environment variables live in a separate local folder that agents cannot read or edit.

## Goals / Non-Goals

**Goals:**
- Render and link a managed `~/.zshrc` from the active profile.
- Render and link portable prompt config such as `.p10k.zsh` through the existing dotfiles model.
- Keep managed zsh content small, comment-light, and suitable for agent edits.
- Source a protected local secrets file from managed zsh startup when it exists.
- Create the protected zsh secrets file when missing during real apply without overwriting existing content.
- Source a machine-local non-secret zsh customization file when it exists.
- Render agent permissions that deny access to the zsh secrets folder while preserving normal access to managed config.

**Non-Goals:**
- Install oh-my-zsh, Powerlevel10k, fonts, or zsh plugins.
- Store secret values in profiles, rendered configs, schemas, tests, or docs.
- Build a full shell framework manager with plugin installation or update orchestration.
- Preserve arbitrary existing `~/.zshrc` content automatically beyond the existing symlink conflict/backup behavior.

## Decisions

### mindframe-z owns `~/.zshrc`

The managed zsh config will be rendered and linked as the active `~/.zshrc`, rather than requiring each machine's existing `.zshrc` to source mindframe-z.

This favors consistent terminal behavior across machines and keeps the mental model aligned with existing dotfile management. The alternative, leaving machine `.zshrc` as primary, is less invasive but makes source order and behavior differ per host.

### Secrets live outside the managed dotfile tree

The managed zsh config will source a local secrets file from the existing mindframe local dot folder, for example `~/.mindframe-z/secrets/zsh.env`.

This avoids storing secrets in git or rendered profile output without creating another top-level home directory. The nested secrets path is explicitly denied in agent permissions even when agents can read other generated indexes in `~/.mindframe-z`.

### Local non-secret customization remains file-based

The managed zsh config will also source a non-secret local file such as `~/.zshrc.local` when present.

This keeps host-specific PATH tweaks and one-off shell behavior possible without expanding the profile schema. A before/after hook pair and snippet directory were considered but are unnecessary for the initial capability.

### Powerlevel10k config is managed, installation is not

The generated `.p10k.zsh` file is portable prompt configuration and will be managed as a normal profile-owned dotfile. The Powerlevel10k theme repository and oh-my-zsh installation remain local prerequisites.

This keeps mindframe-z responsible for configuration, not shell framework installation or update lifecycle. A managed installer was considered but would add dependency ownership, rollback, and update policy that the current dotfiles capability does not need.

### Keep zsh support convention-first

The first version should use explicit rendered files and documented conventions instead of a large structured zsh schema.

This keeps implementation close to the existing dotfiles renderer while still establishing the security boundary needed for secrets. A future change can introduce structured zsh snippets or plugin metadata if real usage shows that plain managed files are too limiting.

## Risks / Trade-offs

- Existing `~/.zshrc` or `~/.p10k.zsh` conflicts with the managed symlink -> use the existing link conflict and backup flow; users split portable content into profile files and machine-only content into local files.
- Secrets path is visible in `~/.zshrc` -> acceptable because the boundary is denying secret contents, not hiding the existence of the include.
- Agent deny semantics differ between tools -> choose a separate secrets directory and render the strongest available deny rules for each agent target; document any residual limitations.
- Concatenating parent and child `.zshrc` files can produce duplicate shell setup -> keep initial profile content intentionally small and consider structured zsh snippets only if duplication becomes a real problem.
