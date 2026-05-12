# OpenCode DB Specification

## Intent

Help agents safely inspect OpenCode's local database with `opencode db`, while keeping queries token-conscious and evidence-driven. The skill is general-purpose for database inspection, with strong support for analyzing prior sessions to improve guidance, skills, MCP usage, and subagent workflows.

## Scope

In scope:

- Locating the OpenCode database and discovering the live schema.
- Read-only SQL query patterns for sessions, messages, parts, projects, and workspaces.
- Progressive disclosure workflows for large transcripts and JSON payloads.
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
- Non-negotiable constraints: do not mutate the database; avoid broad dumps; expand deliberately when full evidence is needed.
- Expected bundled files loaded at runtime: `SKILL.md` only.

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

- `SKILL.md` contains activation language, safety rules, progressive disclosure workflow, query recipes, and reporting guidance.
- `references/` contains nothing initially; add focused references only if runtime guidance becomes too large or branch-specific.
- `scripts/` contains nothing; add scripts only if repeated parsing becomes fragile in SQL alone.
- `assets/` contains nothing.

## Validation

- Lightweight validation: structural skill validation plus manual checks that examples use read-only `opencode db` queries.
- Deeper validation: run candidate, schema, row-count, outline, and selected-row queries against a live OpenCode DB.
- Acceptance gates: non-interactive schema discovery uses SQL, not dot commands; progressive disclosure is explicit; full-read escalation is allowed when justified.

## Known Limitations

- OpenCode schema may change; live schema discovery remains mandatory.
- The database may contain both legacy `message`/`part` rows and newer `session_message` rows.
- Some analysis requires reading large JSON payloads in chunks.

## Maintenance Notes

- Update `SKILL.md` when `opencode db` flags, schema conventions, or session storage patterns change.
- Update `SPEC.md` when intent, scope, safety rules, or validation expectations change.
- Keep provenance and large raw examples out of runtime guidance.
