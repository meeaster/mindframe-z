# Context Footprint Prototype

PROTOTYPE, not production code.

## Question

Can one normalized report make startup, per-step, conditional, invocation-only,
deferred, and unknown contributors readable while keeping static estimates,
historical provider usage, cache components, and capability activation evidence
separate?

The fixtures intentionally include a maximum conditional path, an unknown MCP
schema, missing skill bodies, a no-repository case, a capability that is only
historical, a current capability with no observed use, and equal window prompt
totals with different request distributions.

## Run

```sh
pnpm prototype:context
```

Use `1` through `4` to switch scenarios, `a` for both harnesses, `o` for
OpenCode, `c` for Claude Code, and `q` to quit.

The interactive report is synthetic. It does not read profiles, session stores,
MCP servers, or the filesystem. `FINDINGS.md` separately records isolated
OpenCode CLI measurements and direct MCP protocol probes used to validate the
prototype's assumptions.
