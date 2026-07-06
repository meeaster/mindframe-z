## ADDED Requirements

### Requirement: Pending is a free, derived view of the ledger
`mfz thread pending` SHALL list open proposals derived as: `fits` verdict ∧ session
not a member of that thread ∧ no human verdict for the pair. It SHALL run no
dispatches and read no transcripts. Each entry SHALL show the session id, target
thread, triage reason, and staleness — a proposal whose verdict is already void
(session grew or charter changed since judgment) SHALL be flagged stale, not
dropped. Output SHALL default to condensed text with `--json`. Listing SHALL record
nothing.

#### Scenario: Listing is repeatable and free
- **WHEN** `pending` is run five times between two sweeps
- **THEN** no dispatch runs, no ledger row changes, and the same open proposals are
  shown each time

#### Scenario: Stale proposal is flagged, not hidden
- **WHEN** a proposed session gains messages before the human reviews it
- **THEN** `pending` still lists the proposal, marked stale at its judged watermark

#### Scenario: Half-finished review leaves the queue intact
- **WHEN** a human reviews some proposals, acts on none, and never runs `conclude`
- **THEN** every proposal is still pending on the next `pending`

### Requirement: Ingest is the only acceptance path
Accepting a proposal SHALL be the existing `mfz thread ingest <id> --thread <slug>`;
no separate accept command SHALL exist. Membership retires the proposal (the pending
derivation excludes members). Explicit ingest SHALL be permitted regardless of any
verdict for the pair — including `reject` — as the human-overrides-human escape
hatch; verdict rows for a member pair are inert.

#### Scenario: Ingest retires the proposal
- **WHEN** a pending session is ingested into its proposed thread
- **THEN** it no longer appears in `pending` and the thread pipeline runs exactly as
  for any other ingest

#### Scenario: Human overrides a prior reject
- **WHEN** a session with a `reject` verdict for thread `x` is explicitly ingested
  with `--thread x`
- **THEN** the ingest proceeds normally

### Requirement: Reject records the sticky human no
`mfz thread reject <id> --thread <slug>` SHALL write a human `reject` verdict for
the pair, replacing any existing row. Rejected pairs SHALL never be re-proposed
regardless of session growth or charter edits, until a human overrides via explicit
ingest or clears the verdict.

#### Scenario: A chatty session stops nagging
- **WHEN** a session is rejected for a thread and then grows across three
  subsequent sweeps
- **THEN** no triage is dispatched for that pair and no proposal for it appears

### Requirement: Conclude passes the remainder and stamps the review
`mfz thread conclude` SHALL convert every currently open proposal into a human
`pass` verdict pinned at the session's current watermark and the current charter
hash, and SHALL stamp `last_review_at`. A `pass` SHALL suppress re-proposal while
its pins are unchanged and SHALL void like an agent verdict when the session grows
or the charter changes, making the pair triageable again.

#### Scenario: Moving on means not-at-this-state
- **WHEN** a review ends with two proposals unactioned and `conclude` runs
- **THEN** both become `pass` verdicts and neither appears in `pending` or is
  re-triaged while unchanged

#### Scenario: Growth reopens a passed session
- **WHEN** a passed session later gains messages and goes quiet
- **THEN** the next sweep re-triages it and may propose it again
