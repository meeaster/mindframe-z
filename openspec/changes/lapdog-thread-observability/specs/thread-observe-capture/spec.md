## ADDED Requirements

### Requirement: Dispatches opportunistically probe and instrument at the single chokepoint
The system SHALL, at the single dispatch chokepoint (`DockerAgentRunner.run`), probe lapdog for reachability before each dispatch. When lapdog is reachable, the dispatch SHALL be instrumented by joining the `mfz-net` network and injecting `LAPDOG_URL=http://lapdog:8126` into the container environment. When lapdog is unreachable, the dispatch SHALL run uninstrumented. In both cases the dispatch SHALL proceed and complete identically. This probe-and-instrument logic SHALL exist in exactly one place, not per command.

#### Scenario: Instrument when lapdog is reachable
- **WHEN** a dispatch is about to run and the lapdog reachability probe succeeds
- **THEN** the container is started on `mfz-net` with `LAPDOG_URL=http://lapdog:8126` injected, and event hooks route to lapdog

#### Scenario: Run clean when lapdog is unreachable
- **WHEN** a dispatch is about to run and the lapdog reachability probe fails
- **THEN** the container runs without the network or `LAPDOG_URL`, and the dispatch produces the same result it would with the feature absent

#### Scenario: Fail-open never blocks a dispatch
- **WHEN** lapdog is slow, errors, or refuses connections at any point during a dispatch
- **THEN** the dispatch is neither delayed beyond a short probe timeout nor failed, and ingest output is unchanged

### Requirement: Claude events are captured via baked hooks targeting LAPDOG_URL
The system SHALL bake lapdog's `hooks.json` into the tools image offline (without installing a plugin at dispatch time), with the hook curl target templated to `${LAPDOG_URL}/claude/hooks` so it resolves to the per-dispatch injected URL. The baked hooks SHALL preserve the bounded-timeout, ignore-failure form (`--max-time 2 ... || true`) so a missing or failing lapdog cannot affect the run. Hooks SHALL be registered for the tool, lifecycle, prompt, permission, compaction, and subagent events lapdog accepts.

#### Scenario: Claude tool and lifecycle events reach lapdog
- **WHEN** an instrumented Claude dispatch executes tools and lifecycle transitions
- **THEN** each registered hook POSTs its flat-field body to `${LAPDOG_URL}/claude/hooks` and the events appear in the dashboard

#### Scenario: Hook failure is swallowed
- **WHEN** the lapdog endpoint is unreachable during an instrumented Claude dispatch
- **THEN** each hook curl times out within its bound and returns success via `|| true`, leaving the dispatch unaffected

### Requirement: OpenCode events are translated into the Claude-hooks schema
The system SHALL bundle an OpenCode plugin into the tools image that reads `LAPDOG_URL` from the environment and POSTs translated events to `${LAPDOG_URL}/claude/hooks` using lapdog's flat `/claude/hooks` schema. The plugin SHALL map `tool.execute.before`/`after` to PreToolUse/PostToolUse/PostToolUseFailure, `chat.message` user parts to UserPromptSubmit, the `event` bus to assistant text and SessionStart/Stop/SessionEnd lifecycle, and `permission.ask` to PermissionRequest, renaming `sessionID` to `session_id`. Translation failures SHALL NOT affect the dispatch.

#### Scenario: OpenCode tool calls appear as Claude-hook events
- **WHEN** an instrumented OpenCode dispatch runs tools
- **THEN** the plugin POSTs PreToolUse/PostToolUse bodies derived from `tool.execute.before`/`after` to `${LAPDOG_URL}/claude/hooks`

#### Scenario: OpenCode lifecycle and prompts are captured from the correct channels
- **WHEN** an instrumented OpenCode dispatch starts, submits a user prompt, emits assistant text, and ends
- **THEN** UserPromptSubmit derives from `chat.message` user parts, while assistant text and SessionStart/Stop/SessionEnd derive from the `event` bus, each posted as a `/claude/hooks` event

### Requirement: Cost and token metrics are emitted as a verbatim msgpack span
The system SHALL emit cost and token usage to lapdog as a separate `POST /v0.4/traces` request encoded with msgpack, carrying an `_llmobs` envelope inside `meta_struct` as msgpack bytes. The emit SHALL be performed by the host `mfz` process against the published `http://localhost:8126`, reusing the usage already parsed for `runs.json`. The builder SHALL read the raw result usage so token splits are reported separately as `non_cached_input_tokens`, `cache_read_input_tokens`, and `cache_write_input_tokens`, and SHALL supply cost as integer nanodollars (`estimated_total_cost`, `estimated_input_cost`, `estimated_output_cost`). The emit SHALL be additive and fail-open, never altering `runs.json` or blocking ingest.

#### Scenario: Cost renders in the dashboard after a dispatch
- **WHEN** an instrumented dispatch completes and its usage is parsed
- **THEN** a msgpack `_llmobs` span is POSTed to `http://localhost:8126/v0.4/traces` and the dashboard shows its token counts, cache breakdown, and cost

#### Scenario: Token splits are preserved, not collapsed
- **WHEN** the cost-span payload is built from a dispatch whose usage includes cache reads and writes
- **THEN** `non_cached_input_tokens`, `cache_read_input_tokens`, and `cache_write_input_tokens` are reported as distinct metrics rather than a single summed input-token count

#### Scenario: Cost-span failure leaves the ledger intact
- **WHEN** the `/v0.4/traces` POST fails or lapdog is unreachable
- **THEN** `runs.json` is written exactly as it would be without the feature, and ingest completes normally
