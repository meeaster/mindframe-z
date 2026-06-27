## ADDED Requirements

### Requirement: Durable per-thread run ledger

mindframe-z SHALL append one record per ingest run to the thread's `runs.json`, and each
record SHALL include a per-dispatch breakdown (role, model, cost, tokens, duration) plus
the run total. This ledger SHALL travel with the thread to its destination repository.

#### Scenario: A run records its per-dispatch cost

- **WHEN** an ingest run with gather, synthesize, and digest dispatches completes
- **THEN** its `runs.json` record lists each dispatch's role, model, cost, tokens, and
  duration and a total cost

#### Scenario: The ledger is backed up with the thread

- **WHEN** an ingest run pushes the thread
- **THEN** the updated `runs.json` is included in the pushed files

### Requirement: Machine-local per-run operational state

For each run, mindframe-z SHALL create a machine-local folder
`~/.mindframe-z/threads/runs/<run-id>/` containing a `status.json`
(thread, mode, pid, current step, started/finished timestamps, cost), the raw JSONL
trace of each dispatch, and a `dossiers/` subfolder holding the gather dossiers produced
that run — seeded so the deferred batch-fidelity digest mode can consume them without
re-running gather. These files SHALL NOT be pushed to any destination. A `mfz thread
discover` dispatch SHALL also create a run folder with `mode: discover` and no thread.

#### Scenario: Raw traces stay local

- **WHEN** a dispatch produces a raw JSONL trace
- **THEN** the trace is written under the run folder and is never pushed to a destination

#### Scenario: Live status reflects the current step

- **WHEN** a run advances from one pipeline step to the next
- **THEN** its `status.json` `current_step` is updated so a live run is introspectable

### Requirement: Operational run view

`mfz thread runs` SHALL list active and recent runs across all runs (ingest and discover
alike) by reading the machine-local run folders, without reading thread storage. It SHALL
distinguish a running run from a crashed one using the recorded pid, and SHALL support
filtering to a single thread and showing one run's detail including its raw trace.

#### Scenario: Runs view is cross-thread without reading threads

- **WHEN** the operator runs `mfz thread runs`
- **THEN** mindframe-z lists active and recent runs by globbing the run folders, not by
  reading each thread's storage

#### Scenario: Discover runs appear in the operational view

- **WHEN** the operator runs `mfz thread runs` after a `mfz thread discover` dispatch
- **THEN** that run is listed with `mode: discover` and no thread, alongside ingest runs

#### Scenario: Crashed run is distinguishable from a live one

- **WHEN** a run folder's recorded pid is no longer alive but the run never finished
- **THEN** `mfz thread runs` reports it as crashed rather than running

#### Scenario: One thread's durable history is viewable

- **WHEN** the operator runs `mfz thread runs --thread <slug>`
- **THEN** mindframe-z shows that thread's `runs.json` ledger

### Requirement: CLI activity log

mindframe-z SHALL append a record of each `mfz thread` invocation to a machine-local
rolling `cli.log`, capturing the command and its outcome.

#### Scenario: An invocation is logged

- **WHEN** any `mfz thread` command runs
- **THEN** an entry describing the command and its outcome is appended to `cli.log`
