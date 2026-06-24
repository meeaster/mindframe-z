# opencode-sessions Skill — Design Spec

> Design/build notes for the `skills/opencode-sessions` skill. Not bundled with the skill; not loaded at runtime.

## Intent

Help agents safely inspect OpenCode's local database with `opencode db`, while keeping queries token-conscious and evidence-driven. The skill is general-purpose for database inspection, with strong support for analyzing prior sessions to improve guidance, skills, MCP usage, and subagent workflows.

## Scope

In scope:

- Locating the OpenCode database and discovering the live schema.
- Read-only SQL query patterns for sessions, messages, parts, projects, and todos.
- Outline-first workflows for large transcripts and JSON payloads.
- Session behavior analysis for tool use, skill use, MCP/executor use, subagent delegation, blockers, and guidance improvements.

Out of scope:

- Direct database mutation or repair.
- Replacing OpenCode source code as the authority for schema and migrations.
- Persisting private session content as examples without deliberate redaction.

## Users And Trigger Context

- Primary users: AI agents assisting with OpenCode DB inspection or prior-session analysis.
- Common user requests: query OpenCode sessions, inspect another session, find tool calls, review subagent behavior, check MCP usage, look at project/session metadata, or learn from a prior session.
- Should not trigger for: unrelated SQLite questions, application database design, or general OpenCode usage that does not involve local DB inspection.

## Runtime Contract

- Required first actions: use `opencode db path` or schema discovery when needed; verify live schema before relying on columns.
- Required outputs: describe inspected scope, summarize evidence, and state sampling/full-read status when analyzing behavior.
- Non-negotiable constraints: do not mutate the database; avoid broad dumps; outline before reading full `data`, and expand deliberately when full evidence is needed.
- Files loaded at runtime: `SKILL.md` always; `SESSIONS.md` disclosed when analyzing a prior session.

## Source And Evidence Model

Authoritative sources:

- Live `opencode db --help` behavior.
- Live database schema via `sqlite_master`.
- OpenCode source files for DB path, schema definitions, migrations, and query code when deeper confirmation is needed.

Useful improvement sources:

- Positive examples: sessions where skill/MCP/subagent guidance worked well.
- Negative examples: sessions with repeated failed tools, missed skill loads, unclear subagent prompts, or premature conclusions from samples.
- Validation results: read-only query tests against a live OpenCode DB.

Data that must not be stored:

- Secrets, credentials, tokens, or private transcript content not needed for the skill contract.
- Full session transcripts as examples unless explicitly requested and redacted.

## Reference Architecture

- `SKILL.md` contains activation language, the read-only and outline-first rules, schema map, and the common quick-query path.
- `SESSIONS.md` holds the disclosed prior-session-analysis branch: transcript drill-down recipes, analysis workflow, and reporting pattern.
- Add further disclosed reference files only if a branch's runtime guidance grows too large for `SKILL.md`.

## Validation

- Lightweight validation: structural skill validation plus manual checks that examples use read-only `opencode db` queries.
- Deeper validation: run candidate, schema, row-count, outline, and selected-row queries against a live OpenCode DB.
- Acceptance gates: non-interactive schema discovery uses SQL, not dot commands; outline-first reading is explicit; full-read escalation is allowed when justified.

## Known Limitations

- OpenCode schema may change; live schema discovery remains mandatory.
- The transcript lives in V1 `message`/`part` or V2 `session_message` depending on version; V2 is mid-rollout and recent migrations reset it, so count both stores and analyze whichever holds the rows.
- Some analysis requires reading large JSON payloads in chunks.

## Maintenance Notes

- Update `SKILL.md` when `opencode db` flags, schema conventions, or session storage patterns change.
- Update this spec when intent, scope, safety rules, or validation expectations change.
- Keep provenance and large raw examples out of runtime guidance.
