# thread-session-phases Delta Spec

## ADDED Requirements

### Requirement: Phases section in session files

Thread session files SHALL carry a `## Phases` framing section — same tier as `## Thread Relevance` and `## Gaps`, placed after them and before the event buckets. Each phase SHALL be one line of the form `- [<start> → <end>] <Label> — <one-line description>. (turns N–M)` (part ids for OpenCode), with ` (off-charter)` appended to the label when the phase does not serve the thread's charter. Phase timestamps and turn/part ranges SHALL be copied from the transcript records, never invented. As a framing section, Phases SHALL NOT appear in `log.md` or the digest.

#### Scenario: Session file includes phases

- **WHEN** a session is gathered and synthesized in full
- **THEN** its session file contains a `## Phases` section listing each phase with start→end timestamps, a label, a one-line description, and a turn or part range

#### Scenario: Off-charter phase is marked

- **WHEN** a session contains a stretch of work that does not serve the thread's charter
- **THEN** the corresponding phase line carries the `(off-charter)` marker

#### Scenario: Phases stay out of the log and digest

- **WHEN** `log.md` and `digest.md` are regenerated for a thread whose session files contain `## Phases` sections
- **THEN** neither output contains phase lines

### Requirement: Phase derivation by gather

The gather role SHALL segment the session into phases keyed off the user's prose prompts — shifts in topic or mode of work (e.g. design, implementation, review, side quest) — and report them in the dossier with their boundary timestamps and turn/part ids. Segmentation SHALL be dynamic per session: a single-focus session yields one phase; structural markers such as compaction SHALL NOT by themselves create a phase boundary.

#### Scenario: Single-focus session yields one phase

- **WHEN** a session pursues one task throughout
- **THEN** the dossier reports exactly one phase spanning the whole session

#### Scenario: Mid-session pivot yields a boundary without compaction

- **WHEN** the user's prompts pivot to a clearly different task mid-session with no compaction event
- **THEN** the dossier reports a phase boundary at the pivot

### Requirement: Delta refreshes extend or append phases

Under `update_strategy: delta`, the synthesize role SHALL fold the delta's phases into the existing `## Phases` section: when the delta's first phase continues the file's last phase, that phase's end SHALL be extended; otherwise new phase lines SHALL be appended. Phases already in the file SHALL never be rewritten or removed by a delta refresh. Delta SHALL engage only when the prior file already carries a `## Phases` section; a pre-Phases prior file SHALL fall back to a full re-synthesis for that refresh.

#### Scenario: Continuing activity extends the last phase

- **WHEN** a delta refresh gathers activity that continues the same work as the file's last phase
- **THEN** the last phase's end timestamp and range are extended and no new phase line is added

#### Scenario: New activity appends a phase

- **WHEN** a delta refresh gathers activity that is a different task from the file's last phase
- **THEN** a new phase line is appended and all prior phase lines are unchanged

#### Scenario: Prior file without Phases triggers full re-synthesis

- **WHEN** a delta refresh targets a drifted session whose existing file has no `## Phases` section
- **THEN** the session is re-gathered and re-synthesized in full — a delta revision could only supply post-cursor phases, leaving the section silently partial — and the rewritten file gains a complete `## Phases` section
