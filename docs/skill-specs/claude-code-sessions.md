# claude-code-sessions Skill — Design Spec

> Design/build notes for the `skills/claude-code-sessions` skill. Not bundled with the skill; not loaded at runtime.

## Intent

Help agents safely inspect Claude Code's local session files — JSONL under `~/.claude`, with no database or query CLI — while keeping reads token-conscious and evidence-driven. The skill is general-purpose for session-file inspection, with strong support for analyzing prior sessions to improve guidance, skills, MCP usage, and subagent workflows.

## Scope

In scope:

- Locating the config root and the lossy-encoded project/session files.
- Read-only `jq` patterns over `history.jsonl`, session transcripts, and subagent sidecars.
- Outline-first workflows for large transcripts and tool payloads.
- Session behavior analysis for tool use, skill use, MCP usage, subagent delegation, failures, and guidance improvements.

Out of scope:

- Writing, editing, or deleting anything under `~/.claude`.
- Replacing Claude Code as the authority for the on-disk layout, which shifts between versions.
- Persisting private session content or secrets as examples.

## Users And Trigger Context

- Primary users: AI agents assisting with Claude Code session inspection or prior-session analysis.
- Common user requests: find a past session by prompt/project/recency, inspect another session, trace its tool calls or subagents, review permission events, or learn from a prior session.
- Should not trigger for: unrelated JSONL/jq questions, or general Claude Code usage that does not involve local session-file inspection.

## Runtime Contract

- Required first actions: resolve the config root (`$CLAUDE_CONFIG_DIR` else `~/.claude`); glob the projects dir and confirm the encoded name against the `cwd` field — never hand-reconstruct it (the encoding is lossy).
- Required outputs: describe inspected scope, summarize evidence, and state sampling/full-read status when analyzing behavior.
- Non-negotiable constraints: never mutate or surface secrets; always read with `jq`, never the Read tool (a transcript routinely exceeds Read's size cap); outline before slicing full records, and expand deliberately when full evidence is needed.
- Files loaded at runtime: `SKILL.md` always; `SESSIONS.md` disclosed when analyzing a prior session.

## Source And Evidence Model

Authoritative sources:

- Live files under the config root — `history.jsonl`, `~/.claude.json`, `projects/<encoded>/<sid>.jsonl`, and the `subagents/` sidecars.
- The session JSONL's own records for metadata, titles, tool calls, and results; confirm a file/field exists before relying on it, as the layout shifts between versions.

Useful improvement sources:

- Positive examples: sessions where skill/MCP/subagent guidance worked well.
- Negative examples: sessions with repeated failed tools, missed skill loads, unclear subagent prompts, or premature conclusions from samples.
- Validation results: read-only `jq` reads against a live config root.

Data that must not be stored:

- Secrets (`~/.claude/.credentials.json`, tokens) or private transcript content not needed for the skill contract.
- Full session transcripts as examples unless explicitly requested and redacted.

## Reference Architecture

- `SKILL.md` contains activation language, the read-only and always-jq/outline-first rules, the storage map, and the locate/identify/summarize quick-query path.
- `SESSIONS.md` holds the disclosed prior-session-analysis branch: transcript drill-down recipes, the three-way `is_error` classification (user rejection / permission denial / runtime error), two-level subagent tracing (parent input/output vs. nested transcript), the analysis workflow, and the reporting pattern.
- Add further disclosed reference files only if a branch's runtime guidance grows too large for `SKILL.md`.

## Validation

- Lightweight validation: structural skill validation plus manual checks that examples are read-only `jq` (never Read, never a mutating shell command).
- Deeper validation: run locate, identify, tool-summary, failure, and subagent-trace reads against a live config root.
- Acceptance gates: encoded project names are confirmed against `cwd`, not reconstructed; outline-first reading is explicit; full-read escalation is allowed when justified.

## Known Limitations

- The on-disk layout shifts between Claude Code versions; confirm files and fields live before relying on them.
- The project-dir encoding is lossy (`/`, `.`, `_` all collapse to `-`), so the encoded name is not invertible — always glob and confirm against `cwd`.
- Subagent depth is the caller's call: input/output sit cheaply in the parent transcript, while the full nested trace (`agent-*.jsonl`) is large and read only when the question is about _how_ the subagent worked.

## Maintenance Notes

- Update `SKILL.md`/`SESSIONS.md` when the on-disk layout, record types, or analysis recipes change.
- Update this spec when intent, scope, safety rules, or validation expectations change.
- Keep provenance and large raw examples out of runtime guidance.
