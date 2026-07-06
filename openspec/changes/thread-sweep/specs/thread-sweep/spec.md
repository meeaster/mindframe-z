## ADDED Requirements

### Requirement: Sweep detects sessions from cheap source signals
`mfz thread sweep` SHALL enumerate sessions across both harnesses using host-side
source signals only — file modification time for Claude transcripts and
`max(session.time_updated, latest message time_created)` for OpenCode — without
reading any transcript body during enumeration. Enumeration SHALL exclude subagent
sessions: Claude transcripts under a `subagents/` subpath and OpenCode sessions
whose `parent_id` is set.

#### Scenario: Enumeration reads no transcript bodies
- **WHEN** a sweep enumerates a store containing sessions that are unchanged since
  their last pin
- **THEN** those sessions' transcripts are not opened; only their source signals
  are read

#### Scenario: Subagent sessions are invisible to the sweep
- **WHEN** a Claude session has sibling `subagents/agent-*.jsonl` transcripts and an
  OpenCode session row has a non-null `parent_id`
- **THEN** neither the subagent transcripts nor the child session appear as sweep
  candidates

### Requirement: First sweep stakes an immutable baseline
When no baseline exists on the machine, the sweep SHALL record `baseline_at` as the
sweep's start time before detection and proceed normally. The baseline SHALL never
advance and SHALL gate triage candidacy only: sessions whose source signal predates
`baseline_at` are never triage candidates, while member drift detection is
unaffected by the baseline.

#### Scenario: First run proposes nothing from history
- **WHEN** the first sweep runs on a machine with years of pre-existing sessions
- **THEN** `baseline_at` is written, zero triage dispatches occur, and the report
  states the baseline was staked

#### Scenario: Member refresh detection is ungated on first run
- **WHEN** the first sweep runs and an existing thread member has drifted past its
  manifest watermark
- **THEN** the member is reported as drifted even though its activity predates the
  baseline

### Requirement: Candidates are derived from pins, not a sweep-owned record
The sweep SHALL NOT persist its own per-session watermark record. A session SHALL be
a triage candidate for a thread exactly when it is post-baseline, not a member of
that thread, and one of: no verdict exists for the (session, thread) pair; the
verdict's charter hash differs from the current charter's hash; or the session's
source signal is newer than the verdict's `judged_at` minus the freshness margin. A
member session SHALL be reported as drifted when its recomputed watermark classifies
as `changed`. Exact watermarks SHALL be read only for candidate and member-drift
evaluation, never for the full store.

#### Scenario: An unchanged judged session costs nothing
- **WHEN** a session has a `no_fit` verdict for every thread and its source signal
  has not moved since `judged_at`
- **THEN** the sweep neither reads its watermark nor dispatches triage for it

#### Scenario: Charter edit re-opens judgment for that thread only
- **WHEN** a thread's charter is edited after sessions were judged against it
- **THEN** those sessions become candidates for that thread again, while their
  verdicts against unedited threads stay standing

#### Scenario: A new thread triages recent history automatically
- **WHEN** a thread is created and the next sweep runs
- **THEN** every post-baseline, quiet, non-member session lacking a verdict against
  the new charter is triaged against it with no special flag

### Requirement: Quiescence gate defers hot sessions visibly
The sweep SHALL only triage sessions, and only report member staleness for sessions,
whose last activity is older than the configured quiescence window. The window SHALL
default to 30 minutes, be configurable via profile `thread.defaults` (with `0`
disabling the gate), and be lifted for a single run by `--include-hot`. Deferred
sessions SHALL be named in the report as deferred, never silently omitted.

#### Scenario: Active session is deferred and reported
- **WHEN** a sweep runs while a non-member session had activity 10 minutes ago
- **THEN** no triage is dispatched for it and the report lists it as deferred due to
  recent activity

#### Scenario: Deferral does not lose the session
- **WHEN** a session deferred by one sweep goes quiet and a later sweep runs
- **THEN** the later sweep triages it (no verdict was written, so it is still a
  candidate)

#### Scenario: Gate bypass on demand
- **WHEN** `mfz thread sweep --include-hot` runs with sessions active within the
  window
- **THEN** those sessions are triaged in that run

### Requirement: Triage is one cheap dispatch per candidate session across all charters
For each candidate session the sweep SHALL run exactly one containerized, read-only
dispatch that reads the session once and judges it against every thread charter it
is a candidate for, returning a fit/no-fit verdict with a one-line reason per
charter. The triage model SHALL resolve profile `thread.defaults.triage` → per-run
flag, defaulting to the cheap tier. TypeScript SHALL fan the output into
per-(session, thread) verdict rows. Triage SHALL produce no artifact other than
verdicts. Unparseable verdict lines SHALL result in no verdict row and be named in
the report.

#### Scenario: Cost scales with sessions, not threads
- **WHEN** 3 new sessions are candidates against 10 thread charters
- **THEN** exactly 3 triage dispatches run, each producing up to 10 verdicts

#### Scenario: Malformed triage output is contained
- **WHEN** a triage dispatch returns a line that cannot be parsed into a verdict
- **THEN** no verdict row is written for that line, the remaining well-formed
  verdicts are recorded, and the report names the failure

### Requirement: Verdict ledger is machine-local and pinned
Verdicts SHALL be stored on the machine under a dedicated root
(`~/.mindframe-z/thread-sweep/`), keyed by (source-qualified session id, thread
slug), and never committed to a thread repository. Each row SHALL record the verdict
grade (`fits`, `no_fit`, `pass`, or `reject`), the reason, `judged_at`, the session
watermark at judgment, and the sha256 hash of the charter judged against. Agent
verdicts and `pass` SHALL be void when the session's watermark or the charter hash
moves; `reject` SHALL survive both. Re-triage SHALL overwrite the pair's row in
place.

#### Scenario: Voided verdict is re-bought once
- **WHEN** a `no_fit` session gains new messages, goes quiet, and two sweeps run
- **THEN** the first sweep re-triages it and overwrites the row pinned to the new
  watermark, and the second sweep dispatches nothing for it

#### Scenario: Reject survives growth and charter edits
- **WHEN** a session with a `reject` verdict for a thread grows and that thread's
  charter is later edited
- **THEN** the session is not re-triaged against that thread and is never proposed
  for it

#### Scenario: Ledger stays out of thread repos
- **WHEN** any sweep or review command runs to completion
- **THEN** no file under any thread destination repository or thread store working
  copy is created or modified by it

### Requirement: Sweep reports and never writes to threads
The sweep SHALL write only machine-local state (verdict rows, `baseline_at`,
`last_sweep_at`) and SHALL make no thread-repo writes, no gather/synthesize/digest
dispatches, and no git operations. Its report SHALL default to condensed
agent-optimized text with `--json` for structured output, and SHALL name: new
proposals (pointing at `pending`), drifted members per thread (pointing at
`refresh --thread <slug>`), deferred hot sessions, unparseable triage output, and
counts since `last_sweep_at`. `last_sweep_at` SHALL be used for reporting only,
never candidacy.

#### Scenario: Drift is reported, not acted on
- **WHEN** a sweep finds two drifted members of thread `x` and one new fitting
  session
- **THEN** the report says `x: 2 members drifted — refresh --thread x` and
  `1 proposal pending`, and no refresh or ingest occurs
