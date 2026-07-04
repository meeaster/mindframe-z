# Tasks — thread-session-phases

## 1. Refusal guard fix

- [x] 1.1 In `src/thread/ingest.ts`, key the `dossierReportsMissing` guard on host-confirmed presence: fire when a transcript path was resolved OR `readWatermark` returns a value for the session (covers present OpenCode sessions via the sqlite route). Reuse the watermark already read where available rather than reading twice.
- [x] 1.2 Add tests in `src/thread/ingest.test.ts`: refusal dossier for a present OpenCode session (watermark readable, no transcript path) aborts before synthesis; refusal for a genuinely absent session (no path, no watermark) does not trip this guard.

## 2. Irrelevant-delta short-circuit

- [x] 2.1 In `src/thread/personas.ts` (gather persona) and the delta variant of `gatherPrompt` in `src/thread/ingest.ts`, instruct: when nothing past the cursor is charter-relevant, output exactly `NO_CHARTER_RELEVANT_ACTIVITY` and nothing else. Full (non-cursor) gathers never emit the sentinel.
- [x] 2.2 In `src/thread/ingest.ts`, recognize `dossier.trim() === "NO_CHARTER_RELEVANT_ACTIVITY"` only when a delta cursor was in play, before the empty-dossier guard: skip synthesize, skip `writeSessionFile`, advance the ledger watermark to the current store tail, preserve the entry's existing `title`/`extracted_by`, still record the gather dispatch in `runs[]` and its dossier in the run dossiers.
- [x] 2.3 Skip the digest dispatch when no session file was written this run; run it exactly once as today when at least one was.
- [x] 2.4 Tests: sentinel delta advances watermark without synthesize/write; sentinel embedded in a larger dossier synthesizes normally; sentinel on a full (non-delta) gather does not short-circuit; empty delta dossier still aborts; all-sentinel run skips digest and completes; mixed run (one sentinel, one real) runs digest once.

## 3. Phases

- [x] 3.1 In `src/thread/personas.ts`, extend the gather persona: segment the session into phases by the user's prose prompts (topic/mode shifts), one phase for a single-focus session, compaction alone is not a boundary; report each phase with boundary timestamps and turn/part ids copied from the records.
- [x] 3.2 In `skills/thread-contract/SKILL.md`, add the `## Phases` framing section: placement after `## Thread Relevance`/`## Gaps`, line shape `- [<start> → <end>] <Label> — <one-line description>. (turns N–M)`, `(off-charter)` marker, excluded from `log.md` and the digest like other framing sections; document the delta rule (extend the last phase when the delta continues it, else append; never rewrite prior phases).
- [x] 3.3 In `src/thread/ingest.ts` `synthesizePrompt` (delta branch), instruct the revision to fold delta phases per the extend-or-append rule.
- [x] 3.4 Check `src/thread/log.ts` / `regenerate.ts`: confirm framing sections are already excluded from `log.md` generation so `## Phases` needs no code change; add handling only if the log builder would otherwise pick it up. (Confirmed: `renderEventLog` only emits the five `EVENT_TAGS` buckets; `## Phases` is not among them, so it never reaches `log.md`. No code change.)

## 4. Verification

- [x] 4.1 Run the full test suite and lint (`pnpm test` → 272 passed; `oxlint` → exit 0; `oxfmt --check` clean; `tsc` build clean).
- [x] 4.2 Validate the change with `openspec validate thread-session-phases --type change` (current equivalent of `--change`) → valid. Scenario coverage: refusal-guard both scenarios and irrelevant-delta short-circuit scenarios (off-charter advance, embedded-token, all-sentinel digest skip, empty-delta abort, mixed-run digest-once) have tests in `ingest.test.ts`; the phase-section/derivation/extend-or-append scenarios are prompt- and contract-level (persona + SKILL.md + synthesizePrompt) exercised at model dispatch time — a live-test note, no host-deterministic assertion possible.
