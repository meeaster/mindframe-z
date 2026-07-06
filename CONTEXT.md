# mindframe-z

Personal AI-agent configuration and the thread system: long-running topics of work
distilled from agent sessions across harnesses.

## Language

### Threads

**Thread**:
A long-running topic of work, backed by a manifest, whose member sessions are
distilled into session files, a log, and a digest.

**Charter**:
The single prose statement of what a thread is about. It is both the membership
criteria (does a session belong?) and the synthesis lens (how is a session
distilled?).
_Avoid_: description, criteria, prompt (as distinct fields)

**Session**:
A single conversation in a host harness store (claude-code or opencode),
identified by a qualified `source:id`.

**Watermark**:
A tail signature (message count, last message id, last activity) of a member
session's host store as of its last synthesis; detects changed member sessions.

**Sweep**:
The proactive detector that compares the host session stores against tracked
state and finds new sessions, changed non-members, and stale members. Where the
system left off is derived from member watermarks and verdicts, not from a
separate record of what was read; only the time of the last sweep is kept, for
reporting.
_Avoid_: auto-update, rediscover (that's per-thread)

**Source signal**:
A cheap per-session freshness indicator read from the host store (file
modification time, store row times) used to pick sweep candidates without
reading transcripts.
_Avoid_: watermark (that's the exact tail signature, read only for candidates)

**Baseline**:
The fixed point in time before which sessions are never candidates for
automatic triage; set to the moment sweeping first runs on a machine. It gates
triage only — member refresh is ungated. Older history is reached deliberately
via discovery or explicit ingest; triage never looks behind the baseline.
_Avoid_: cursor (a baseline never advances)

**Quiescence gate**:
The sweep rule that only quiet sessions — no activity for a configured window —
are triaged or refreshed; hot sessions are reported and deferred to a later
sweep.
_Avoid_: hot/cold filtering, activity threshold

**Triage**:
Judging a new or changed non-member session against thread charters to decide
membership: the session is read once and judged against every applicable
charter, producing only verdicts — never dossiers or session files.
_Avoid_: discovery (that's pull-based, for new threads)

**Refresh**:
Re-ingesting a member session whose host store has new content past its
watermark. Always human-initiated: the sweep only detects and reports
staleness, it never refreshes.

**Verdict**:
The recorded outcome of judging one session against one thread, pinned to the
session's watermark and the charter hash at judgment time. Agent verdicts and
human passes are void when either pin moves; a human reject is sticky until
explicitly overridden.
_Avoid_: rejection (a verdict can be either way)

**Pending proposal**:
An agent `fits` verdict not yet acted on by a human; triage is the only
producer of proposals. It is retired by the session becoming a member (via
ingest), by an explicit reject, or by a pass when a review concludes — never
by merely being listed.

**Pass**:
The implicit human verdict written for each proposal left unactioned when a
review concludes: "not at this state." Pinned like an agent verdict, so
session growth reopens it.
_Avoid_: skip (skipping mid-review records nothing)

**Reject**:
The explicit, sticky human `no` for one session-thread pairing; survives
session growth and charter edits until a human overrides it (explicit ingest
or clearing the verdict).

**Review**:
The human-in-the-loop pass over sweep results — refreshing stale threads,
ingesting or rejecting proposals — ended by an explicit conclude that passes
whatever remains.
_Avoid_: sweep (detection is the machine's half; review is the human's)
