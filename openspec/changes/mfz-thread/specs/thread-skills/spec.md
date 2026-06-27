## ADDED Requirements

### Requirement: threads operator skill

mindframe-z SHALL ship a new model-invoked `threads` skill that teaches an interactive
agent how to operate threads via the `mfz thread` CLI. The skill SHALL be named for the
concept, not the mechanism, and SHALL lead with the **load a thread's digest into context**
branch (the cheap, read-only default) ahead of the **build or refresh** branch (discover,
create, ingest, inspect runs). The skill SHALL be slim — a process for using the CLI —
because the orchestration logic lives in the CLI, not the skill.

#### Scenario: Agent loads a thread into context

- **WHEN** the user references an existing thread or asks to resume or catch up on prior
  multi-session work
- **THEN** the agent can load the `threads` skill and follow its read branch to run
  `mfz thread show` and stop, without entering the paid ingest path

#### Scenario: Agent builds or updates a thread

- **WHEN** the user asks an interactive agent to create or update a thread
- **THEN** the agent can load the `threads` skill and follow its build branch to run the
  appropriate `mfz thread` commands

### Requirement: thread-contract synthesizer skill

mindframe-z SHALL ship a new `thread-contract` skill that encodes the output contract for
synthesis — the event buckets and their definitions, the digest sections, the citation
format, the session-file layout, and the append-on-update and supersede rules. The
synthesize and digest dispatches SHALL load this skill.

#### Scenario: Synthesizer follows the contract skill

- **WHEN** a synthesize dispatch runs
- **THEN** it loads the `thread-contract` skill and produces a session file conforming to
  that contract

### Requirement: Reuse of existing reader skills

The explore and gather roles SHALL reuse the existing `claude-code-sessions` and
`opencode-sessions` reader skills for reading sessions; this change SHALL NOT author a
new session-reading skill.

#### Scenario: Gather uses an existing reader skill

- **WHEN** a gather dispatch reads a session
- **THEN** it loads the existing `claude-code-sessions` or `opencode-sessions` skill

### Requirement: Legacy thread-log skill demoted to user-invoked

The existing `skills/thread-log/` skill SHALL remain the working hand-orchestrated path —
reachable by explicit `/thread-log` invocation, including its headless worker launch — but
SHALL be demoted to user-invoked (`disable-model-invocation: true`), so it no longer
competes with the `threads` skill for autonomous invocation or pays context load. Its
description SHALL be a human-facing one-liner with trigger phrasing stripped.

#### Scenario: thread-log no longer fires autonomously

- **WHEN** this change is applied
- **THEN** `skills/thread-log/SKILL.md` carries `disable-model-invocation: true` and the
  skill is reachable only by explicit invocation, not model-invocation
