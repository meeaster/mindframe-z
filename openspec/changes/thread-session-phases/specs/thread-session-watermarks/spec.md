# thread-session-watermarks Delta Spec

## ADDED Requirements

### Requirement: Irrelevant-delta short-circuit

Under `update_strategy: delta`, when the gather role finds no charter-relevant activity past the stored cursor, it SHALL output exactly the sentinel `NO_CHARTER_RELEVANT_ACTIVITY` and nothing else. On receiving a dossier whose trimmed content equals the sentinel for a delta-engaged session, ingest SHALL skip the synthesize dispatch, leave the session file untouched, advance the session's ledger watermark to the store's current tail, and preserve the entry's existing `title` and `extracted_by`. The sentinel SHALL be recognized only when a delta cursor was in play; an empty dossier SHALL still abort as a gather failure. The gather dispatch SHALL still be recorded in the run ledger and its dossier in the run's observability artifacts. When every session in a run's work set short-circuits, the digest SHALL NOT be regenerated; when at least one session file is written, the digest SHALL run exactly once as today.

#### Scenario: Off-charter delta growth advances the watermark without synthesis

- **WHEN** a tracked session grew only with charter-irrelevant activity and a delta refresh gathers it
- **THEN** gather returns the sentinel, no synthesize dispatch runs, the session file is unchanged, and the stored watermark advances to the current store tail so the same growth does not re-trigger

#### Scenario: Sentinel embedded in a larger dossier does not short-circuit

- **WHEN** a delta dossier contains the sentinel token alongside other content
- **THEN** the session is synthesized normally

#### Scenario: All-sentinel run skips the digest

- **WHEN** every session in a refresh run short-circuits on the sentinel
- **THEN** no digest dispatch runs and the run completes successfully

#### Scenario: Empty delta dossier still aborts

- **WHEN** a delta gather returns an empty dossier
- **THEN** ingest aborts before synthesis as a gather failure, exactly as for a full gather

### Requirement: Refusal guard for host-confirmed-present sessions

When a gather dossier reports the session missing (matching the missing-report markers) but the host has confirmed the session exists — a transcript path was resolved, or a current watermark is readable from the host store — ingest SHALL abort before synthesis for both harnesses, so a fabricated refusal is never synthesized, written, watermarked, or pushed.

#### Scenario: Refusal for a present OpenCode session aborts

- **WHEN** gather reports an OpenCode session missing while its watermark is readable from the OpenCode database
- **THEN** ingest aborts before synthesis with an error naming the session and run

#### Scenario: Refusal for a genuinely absent session is not blocked by this guard

- **WHEN** gather reports a session missing and the host resolved no transcript path and can read no watermark for it
- **THEN** this guard does not fire
