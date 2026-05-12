---
name: mise
description: "Use when the user asks about mise basics: installing or adding global tools, choosing a mise backend, managing global mise environment variables, checking mise config, or getting concise mise command guidance. Prefer slim command-first answers; fetch current mise docs when this skill does not cover the request."
---

# mise Basics

Use this skill as lightweight mise command memory, not a full tutorial. The model should still reason normally and look up current docs when the hints below are not enough.

## Hints

- Global tools usually use `mise use --global <tool>@<version>`.
- Common language runtimes can use direct names: `node`, `python`, `go`, etc.
- For a named app/tool, try the bare default first: `mise use --global <tool>@latest`.
- If the exact bare name is uncertain, check the registry first: `mise registry | grep -i <name>`.
- If the tool is in `mise registry`, use the bare shorthand and do not specify the backend.
- If it is not in `mise registry`, choose and specify the appropriate backend.
- After installing, do not assume the command is immediately on `PATH`; verify with `mise exec -- <cmd> --version` or check shell activation.
- CLI tools often work best through their ecosystem backend:
  - npm packages: `npm:<package>`
  - Python CLIs: `pipx:<package>`
  - Rust crates: `cargo:<crate>`
  - GitHub release binaries: `github:<owner>/<repo>`
  - aqua registry tools: `aqua:<registry-name>`
- Prefer the tool's official distribution channel when choosing a backend.
- If backend choice, flags, or config behavior is uncertain, look up current mise docs before answering.

## Useful Commands

Global tools:

```bash
mise use --global node@lts
mise use --global npm:prettier@latest
mise use --global pipx:black@latest
mise use --global cargo:ripgrep@latest
mise use --global --remove node
mise exec -- uv --version
mise registry | grep -i uv
```

Global env vars:

```bash
mise set --global KEY=value
mise unset --global KEY
mise env --redacted
```

Inspect config/backends:

```bash
mise backends ls
mise config ls
mise edit --global
mise doctor
```

Global config is usually `~/.config/mise/config.toml`, but prefer `mise config ls` when exact active config matters.
