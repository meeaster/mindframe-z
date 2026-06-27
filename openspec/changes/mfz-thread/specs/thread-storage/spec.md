## ADDED Requirements

### Requirement: Destinations composed from profile and machine config

mindframe-z SHALL resolve thread backup destinations by reading `thread.destinations`
from both the resolved profile (public defaults) and the machine config
(private/machine-specific) and unioning them at command time. It SHALL NOT require a
rendered destinations file or an `mfz apply` before thread commands work.

#### Scenario: Profile and machine destinations are unioned

- **WHEN** a personal destination is declared in the `base` profile and a work
  destination is declared in the machine config
- **THEN** `mfz thread destinations` lists both

#### Scenario: Machine destination overrides a same-named profile destination

- **WHEN** the profile and the machine config both declare a destination named `work`
- **THEN** `mfz thread destinations` lists a single `work` entry using the machine
  config's repo, and the machine config's `default` flag wins over the profile's

#### Scenario: Destinations resolve without apply

- **WHEN** `mfz thread` runs before any `mfz apply`
- **THEN** destinations still resolve from the in-memory composition of profile and
  machine config

### Requirement: Per-destination git repositories

Each destination SHALL be a git repository cloned or initialized under
`~/.mindframe-z/thread-destinations/<name>/`. Each thread SHALL be routed to exactly one
destination chosen at create time and recorded in its manifest. The local thread store
SHALL live at `~/.mindframe-z/threads/<slug>/` and the destination's per-thread copy at
`<destination>/<slug>/`.

#### Scenario: A thread lives in its destination's repo

- **WHEN** a thread is created with `--dest work`
- **THEN** its local files are placed under `~/.mindframe-z/threads/<slug>/`, its
  destination copy under `~/.mindframe-z/thread-destinations/work/<slug>/`, and its
  manifest records `destination: work`

### Requirement: Commit and push on ingest

`mfz thread ingest` SHALL commit the updated thread files and push them to the thread's
destination repository as the backup step. It SHALL accept `--no-push` to commit locally
without pushing.

#### Scenario: Ingest backs up by pushing

- **WHEN** an ingest run completes successfully
- **THEN** mindframe-z commits the changed thread files and pushes them to the thread's
  destination

#### Scenario: Push can be suppressed

- **WHEN** the operator runs `mfz thread ingest … --no-push`
- **THEN** mindframe-z commits locally and does not push

### Requirement: deleteThreadFromDestination

mindframe-z SHALL provide a `deleteThreadFromDestination` function that removes the
thread's subdirectory from its destination repository, stages the deletion, and commits
it with a `chore(thread): delete <slug>` message. When the thread subdirectory does not
exist in the destination, the function SHALL return silently. The push step SHALL reuse
the shared `pushIfRemote` helper.

#### Scenario: Delete removes the thread from the destination repo

- **WHEN** a thread that was previously committed to its destination is deleted
- **THEN** the thread's subdirectory is removed from the destination, the deletion is
  committed, and the commit is pushed (unless suppressed)

#### Scenario: Delete skips destination when the thread was never committed

- **WHEN** a thread was created but never ingested, so it has no copy in the destination
- **THEN** `deleteThreadFromDestination` returns without touching the destination repo

### Requirement: syncThreadDestination

mindframe-z SHALL provide a `syncThreadDestination` function that fetches from a
destination's remote, pulls via `git pull --rebase --autostash`, and copies committed
thread directories back to the local store. It SHALL check `git branch -r` before
pulling and return early when the remote has no branches yet (empty repo). It SHALL only
copy subdirectories that contain a `manifest.json`, guarding against non-thread
directories polluting the store.

#### Scenario: Sync pulls remote changes into the local store

- **WHEN** a thread was updated on another machine and pushed to the destination's remote
- **THEN** `syncThreadDestination` fetches and rebases, then copies the changed thread
  directories into the local thread store

#### Scenario: Empty remote is skipped cleanly

- **WHEN** a destination's remote exists but has no branches yet
- **THEN** `syncThreadDestination` returns an empty array without error

#### Scenario: Non-thread directories are not copied

- **WHEN** a destination's root contains subdirectories without `manifest.json`
- **THEN** `syncThreadDestination` skips them and only copies verified thread directories

### Requirement: Shared pushIfRemote helper

mindframe-z SHALL provide a private `pushIfRemote` helper that checks for a configured
git remote and pushes, warning when none is found. Both `commitThreadChanges` and
`deleteThreadFromDestination` SHALL delegate their push step to this helper rather than
duplicating the remote check and push logic.

#### Scenario: Push is gated by a single helper

- **WHEN** `commitThreadChanges` or `deleteThreadFromDestination` needs to push
- **THEN** it calls `pushIfRemote(destination)` instead of duplicating the
  remote-exists-then-push block

### Requirement: Manifest and runs file split

A thread's `manifest.json` SHALL hold its slow-changing identity (charter, membership
ledger, per-session watermarks, synthesis config), and a separate `runs.json` SHALL hold
the append-only run and cost ledger. Both files SHALL be pushed with the thread.

#### Scenario: Run records do not live in the manifest

- **WHEN** an ingest run records its telemetry
- **THEN** the record is appended to `runs.json`, not to `manifest.json`

### Requirement: TS-owned membership ledger

Each session's manifest ledger entry SHALL carry its id, source, title, the synthesizer
that produced its file, and its `high_water`, and TypeScript SHALL own every field:
source is derived from the session id prefix (`source:` qualified prefix first, then
`ses_` heuristic fallback for bare ids), title is lifted from the session file's
`# Session <id> — <title>` H1, and the synthesizer is recorded as
`harness:model@effort` from the run's resolved dispatch settings. The dispatched agent
SHALL NOT write provenance into the session file or the manifest.

#### Scenario: Provenance is lifted by TS, not the agent

- **WHEN** a session is ingested
- **THEN** its manifest entry's source, title, and synthesizer are populated by TypeScript
  and its session file contains no provenance fields

### Requirement: Qualified session-id parsing

mindframe-z SHALL parse session ids in the qualified `source:id` format (e.g.
`claude-code:bb55cee5-…` from discover), with a heuristic fallback for bare ids
(`ses_` prefix → opencode, otherwise → claude-code). `parseSessionId(id)` SHALL return
`{ source, bare }`. Session files SHALL be named `${source}-${bareId}.md` to avoid
filesystem issues with `:`. The manifest ledger SHALL store the `bare` id and `source`
separately.

#### Scenario: Qualified id is parsed into source and bare

- **WHEN** a qualified id like `opencode:ses_abc123` is parsed
- **THEN** `parseSessionId` returns `{ source: "opencode", bare: "ses_abc123" }`

#### Scenario: Bare id is disambiguated by the `ses_` heuristic

- **WHEN** a bare id like `ses_xyz789` is parsed
- **THEN** `parseSessionId` returns `{ source: "opencode", bare: "ses_xyz789" }`

#### Scenario: Session filename uses dash-separated source-bareId

- **WHEN** a claude-code session with bare id `bb55cee5-…` is written
- **THEN** the file is named `claude-code-bb55cee5-….md`

### Requirement: Session sources profile default

The profile `thread.defaults` SHALL carry a `session_sources` field defaulting to
`["claude-code", "opencode"]` that controls which session stores the discover agent
searches. `mfz thread discover` SHALL accept a `--sources` flag that overrides the
profile default. The `resolveSessionSources` helper SHALL return the flag-provided
sources when present, otherwise the profile default.
