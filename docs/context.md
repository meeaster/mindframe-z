# `mfz context`

`mfz context` reports the current profile contributions visible to OpenCode and Claude Code without rendering, linking, or modifying either harness.

```sh
pnpm dev context
pnpm dev context --agent opencode
pnpm dev context --probe-mcp
pnpm dev context history --agent claude-code --days 30
```

Static analysis measures mfz-managed profile instructions, generated reference and extra-folder indexes, skills that are model-visible after the effective OpenCode profile, global, and inspected-project permission overrides, configured MCP exposure, and tracked or non-ignored repository instruction files. Built-in harness prompts, unmanaged plugins, bundled skills, and MCP schemas that require a connection remain outside the measured scope. A denied OpenCode skill is reported as excluded and contributes no catalogue or body estimate.

Default output shows the local `round(characters / 4)` token estimate, not provider-exact tokenization. Exact UTF-8 character and byte measurements remain in the analysis model; unavailable model-visible content is shown as unmeasured rather than zero. Skills are grouped by source root with skill counts, catalogue totals, not-advertised catalogue counts, and body inventory. Only model-visible catalogues contribute to Startup; body inventory is shown as invocation-only detail and does not contribute to Startup.

Each harness has only two top-level static phases: Startup and Per request. Startup contains Files (startup files only) and Skills (catalogues only); conditional/nested files and skill body inventory are shown as excluded detail within those groups. Per request contains MCP servers when their loading is established. When Claude MCP loading remains unknown, Per request is marked not established and its visible MCP schema inventory is explicitly excluded from that phase. Group totals and estimates use deterministic compact values such as `1k`, `1.1k`, `1m`, and `1b`. Loading classes distinguish startup, per-step, path-conditional, invocation-conditional, deferred, and unknown content. Conditional path totals select the largest cumulative path rather than adding mutually exclusive sibling directories.

Startup and Per request totals remain separate. A phase with only unmeasured contributors reports that condition rather than a misleading zero estimate, and unknown loading is excluded from either phase rather than counted as zero.

`mfz context history --days <days>` is a separate, telemetry-only command. It reports session metadata and usage rollups, not current instructions, skills, or MCP configuration. `mfz context` never opens session stores. History reads OpenCode SQLite and Claude JSONL stores read-only, scoped by recorded worktree paths; it does not print prompts, assistant text, tool arguments, tool results, secrets, or attachment bodies.

History reports observed model steps separately from usage-bearing requests. Prompt input is uncached input plus cache reads and cache creation or writes. Window totals are traffic measurements; averages use only usage-bearing requests; maximums are observed prompt-input occupancy including cached tokens, not provider context limits or full prompt-plus-output peaks. Missing usage remains unavailable instead of being fabricated as zero, while omitted optional cache counters are treated as zero when prompt usage is otherwise present.

When stores provide structural activation names, history reports only compact aggregate activity counts. It does not join those observations to the current profile or recommend disabling a capability.

MCP schema measurement is opt-in and probes each unique, effectively enabled server sequentially across the selected active harnesses. Omit `--agent` to include every active supported harness:

```sh
pnpm dev context --probe-mcp
pnpm dev context --agent opencode --probe-mcp
```

Probe totals and per-server measurements appear inline in the harness's Per request phase, preserving the server's effective membership and loading classification. The header retains a disabled-server count without listing disabled rows. Unprobed schemas are explicitly marked unmeasured, while unavailable probes and unknown harness loading are counted separately. Server instructions are probe metadata and excluded from the phase total. The report prints one global safety warning: the probe performs `initialize` and `tools/list` only, but each contacted local process or remote endpoint is not sandboxed and may have its own side effects. It supports local stdio and remote streamable HTTP; unavailable and remote SSE servers do not block other probes. It does not make a provider request or call an MCP tool, and it never prints credentials, server content, arguments, or results. Temporary mfz/OpenCode state is isolated and removed afterward.
