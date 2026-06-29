# Prototype answers — lapdog review validation
PROTOTYPE — wipe me after folding answers into real code / ADR.

## BLOCKER 1: Claude hooks file path (CONFIRMED via container test)

Question: Does Claude Code load hooks from ~/.claude/hooks.json?

Answer: NO. Container test results:
- hooks.json (current Dockerfile.tools line 18): hook did NOT fire
- settings.json (correct path): hook DID fire

Fix: merge hooks into ~/.claude/settings.json instead of standalone hooks.json.
The existing hooks.json content already has the correct {"hooks": {...}} wrapper,
so the fix is purely a file-path change in Dockerfile.tools line 18.

## BLOCKER 2: OpenCode event sessionID (CONFIRMED via live plugin test)

Question: Does `input.event.sessionID` exist at the top level of OpenCode event hook payloads?

Answer: NO. Live plugin test results:
- session.created event keys: ["id", "properties", "type"] — NO top-level sessionID
- sessionID lives at: input.event.properties.sessionID = "ses_0ecb..."
- Current lapdog.ts code reads input.event.sessionID which is always undefined
- sessionIdFromUnknown returns "unknown" for ALL event lifecycle hooks

Fix: read input.event.properties.sessionID. Since all Event types in the
generated SDK share this shape, no per-type switching is needed.

## lapdog-lifecycle-prototype
Question: Does startLapdogContainer treat any named container as healthy?

Answer: YES, confirmed via prototype TUI (run: pnpm pro:lc)
- "already_running" returned for stopped, wrong-image, wrong-network containers
- Should only return "already_running" when running + correct image + mfz-net

## runner-contract-prototype
Question: Does rawUsage in AgentRunResult justify a refactor?

Answer: Yes, "emit-inline" (~15 LOC) recommended (run: pnpm pro:rc)
- OpenCode rawUsage duplicates usage.input_tokens / output_tokens
- Claude rawUsage carries ~8 fields but cost-span only uses 2
- Fake runners must supply null — dead weight

## Prototype artifacts (throwaway, not committed)
- src/thread/proto-claude-hooks.sh — container test for hooks file path
- src/thread/lapdog-lifecycle-prototype.ts — container lifecycle TUI
- src/thread/runner-contract-prototype.ts — result shape comparison TUI
- src/thread/prototype-answers.md — this file
- opencode/plugins/proto-event-logger.ts — event payload logger plugin
- package.json scripts: pnpm pro:lc, pnpm pro:rc
