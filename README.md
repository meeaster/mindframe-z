# mindframe-z

Profile-aware AI tool configuration renderer. Reads YAML manifests from profiles and renders runtime config for OpenCode and Claude Code. Machine-local config can add per-host OpenCode permission rules and reference directories.

## Commands

```sh
npm install
npm run build
npm test
npm run dev -- doctor
npm run dev -- apply --profile personal --target all --dry-run
npm run dev -- smoke-opencode --home /tmp/mindframe-z-home
npm run dev -- refs list
```

By default, commands use the current repository as the config root. Override with `--root <path>` or `MFZ_ROOT`.

Integration tests use temporary directories and do not touch `~/.config/opencode` or `~/.claude`.

OpenCode plugins can be developed in `opencode/plugins/`. Enabled plugins are copied into `.runtime/opencode/plugins/` and referenced from rendered `opencode.jsonc` with `file://` plugin entries. This avoids taking ownership of an existing global `~/.config/opencode/plugins` directory.

Skills are installed by `npx skills`/skills.sh into agent-owned locations such as `~/.agents/skills`; OpenCode auto-loads that directory. The renderer does not create or point OpenCode at `.runtime/opencode/skills`.

`smoke-opencode` renders OpenCode config into `.runtime/opencode` and runs `opencode debug config` with `OPENCODE_CONFIG_DIR` pointed at that runtime directory. It also redirects XDG config/data/cache/state paths under the provided `--home` directory so the check does not touch normal OpenCode state. If the `opencode` binary is unavailable, the check is skipped.
