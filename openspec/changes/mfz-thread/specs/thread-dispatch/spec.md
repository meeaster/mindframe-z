## ADDED Requirements

### Requirement: Containerized dispatch behind a runner port

mindframe-z SHALL dispatch every judgment step (gather, synthesize, digest, discover) by
running an agent headless inside a container via a runner port. The runner SHALL be a
lightweight `docker run` executor against a single tools image containing the `claude`
and `opencode` CLIs, distinct from the developer `mfz sandbox`. The port SHALL allow an
alternative runner implementation to be substituted without changing the pipeline.

#### Scenario: A dispatch runs in a container

- **WHEN** the pipeline dispatches a gather, synthesize, digest, or discover step
- **THEN** mindframe-z runs the agent headless inside a container and collects its result

#### Scenario: Dispatch is independent of the developer sandbox

- **WHEN** a thread dispatch runs
- **THEN** it does not depend on `mfz sandbox` initialization or its credential broker

### Requirement: Both Claude Code and OpenCode harnesses

The runner SHALL support both Claude Code (`claude -p`) and OpenCode (`opencode run`)
as dispatch harnesses, selecting per thread from the resolved synthesis config. Each
adapter SHALL pass the prompt on stdin and request structured output
(`--output-format stream-json` / `--format json`) so cost and usage are captured.

#### Scenario: Claude Code dispatch captures cost

- **WHEN** a dispatch uses the Claude Code harness
- **THEN** the runner invokes `claude -p` with JSON output and records cost, tokens, and
  duration from the result

#### Scenario: OpenCode dispatch captures cost

- **WHEN** a dispatch uses the OpenCode harness
- **THEN** the runner invokes `opencode run` with JSON output and records cost, tokens,
  and duration from the result

### Requirement: Read-only, text-returning agents

Dispatched agents SHALL run with file write/edit tools denied and SHALL return their
result as text; TypeScript SHALL perform all disk writes from that returned text.
Credentials SHALL be mounted read-only from the host using subscription auth, and the
runner SHALL refuse to inject `ANTHROPIC_API_KEY`.

#### Scenario: Agent cannot write to disk

- **WHEN** any dispatch runs
- **THEN** the agent's write and edit tools are denied and it returns its output as text

#### Scenario: Credentials are mounted read-only

- **WHEN** the runner launches a container
- **THEN** host credential files are mounted read-only and no API key is injected

### Requirement: Persona, skill, and prompt layering

Each dispatch SHALL be assembled from a thin per-role persona, zero or more loaded
skills, and a per-run prompt. The persona SHALL be injected as Claude Code's
`--system-prompt`; for OpenCode a fixed read-only `thread-readonly` agent SHALL be
selected with `--agent` and the persona text SHALL be delivered as the prompt, since
OpenCode does not accept an arbitrary system prompt. The explore and gather roles SHALL
load only the existing session reader skills; the synthesize and digest roles SHALL load
the `thread-contract` skill. Variable per-run data (session locator, dossier, charter)
SHALL travel on stdin, not in the persona or skill.

#### Scenario: Gather loads only a reader skill

- **WHEN** a gather dispatch is assembled
- **THEN** it loads the relevant session reader skill and no thread synthesis skill

#### Scenario: Synthesize loads the contract skill

- **WHEN** a synthesize or digest dispatch is assembled
- **THEN** it loads the `thread-contract` skill and receives the charter in the prompt

### Requirement: Model and effort resolution

The model, harness, and effort for each dispatch SHALL be resolved from a unified
`harness:model@effort` string parsed by `parseModelId()`. Resolution precedence is:
per-run flag over manifest synthesis override over profile `thread.defaults`. Gather
SHALL default to a cheap model and synthesize/digest to a capable model. Discovery is a
judgment step and SHALL use the capable (discover) model. The resolved defaults are
computed by `resolveSynthesisDefaults(profileDefaults, manifest, flags)` which returns
parsed `{ harness, model, effort }` objects for each role.

#### Scenario: Run flag overrides manifest and profile

- **WHEN** `mfz thread ingest … --synthesize-model opencode:opus@high` runs against a
  thread whose manifest and profile specify different models
- **THEN** the synthesize dispatch uses harness `opencode`, model `opus`, effort `high`

#### Scenario: Manifest override overrides profile default

- **WHEN** a thread's manifest has `synthesis.synthesize: claude-code:opus@high` and the
  profile default is `claude-code:sonnet@high`
- **THEN** the synthesize dispatch uses harness `claude-code`, model `opus`, effort `high`

#### Scenario: Profile default is used when neither flag nor manifest override is present

- **WHEN** a thread has no synthesis overrides in its manifest and no per-run flags
- **THEN** the dispatch uses the profile `thread.defaults` for each role
