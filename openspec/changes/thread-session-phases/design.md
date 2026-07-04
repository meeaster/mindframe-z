# Design — thread-session-phases

## Context

The thread ingest pipeline dispatches a gather → synthesize pair per session (`src/thread/ingest.ts`), guided by personas (`src/thread/personas.ts`) and the artifact contract (`skills/thread-contract/SKILL.md`). An audit of real thread history found: sessions are multi-phase (design → implementation → side quests), most topic pivots happen *without* a compaction, a self-refresh loop re-synthesized one session 7× on machinery noise, and a fabricated "session not found" refusal was once committed and watermarked as valid — permanently frozen under watermark gating. The `update_strategy: delta` path (gather past the cursor, revise the prior file) already exists; `full` remains the default.

## Goals / Non-Goals

**Goals:**

- Give session files a readable map of the session's phases, marked on/off-charter.
- Stop paying synthesize + commit churn for charter-irrelevant delta growth; kill the self-refresh loop.
- Close the refusal-guard gap for present OpenCode sessions.

**Non-Goals:**

- No chunk/segment ledger in the manifest — phases are descriptive prose, not addressable units (research showed compaction boundaries are a weak pivot proxy; model-judged segments have no stable identity).
- No change to the `update_strategy` default.
- No CLI surface or manifest schema changes.

## Decisions

1. **Phases are a framing section, produced by gather.** Gather is the only role that sees the transcript (synthesize is contract-bound to the dossier), and it already reads every message — segmenting by the user's prose prompts costs ~nothing. `## Phases` sits with `## Thread Relevance` / `## Gaps` in the session file: it frames the extraction, carries no per-bullet citations, and never reaches `log.md` or the digest. Alternative rejected: phases in the manifest/schema — descriptive prose has no stable identity to key on, and nothing consumes it programmatically yet.

2. **Phase line shape.** `- [<start> → <end>] <Label> — <one-line description>. (turns N–M)` with ` (off-charter)` appended to the label when the phase does not serve the charter. Timestamps and turn/part ranges are copied verbatim from the transcript per the existing gather discipline (never invented).

3. **Delta refreshes extend or append, never rewrite.** A delta gather sees only messages past the cursor, so it reports phases *of the delta*; the synthesize contract folds them in: if the first delta phase continues the file's last phase, extend that phase's end; otherwise append. Prior phases are immutable — same append-only spirit as the log.

4. **Irrelevant-delta sentinel: exact-match single token.** In delta mode, when nothing past the cursor is charter-relevant, gather outputs exactly `NO_CHARTER_RELEVANT_ACTIVITY` and nothing else. Ingest recognizes it by `dossier.trim() === "NO_CHARTER_RELEVANT_ACTIVITY"` — checked before the empty-dossier abort guard, and only when a cursor was in play (delta engaged). Exact whole-output match keeps a dossier that merely *mentions* the token from short-circuiting, and keeps the sentinel distinguishable from a gather failure (empty output still aborts). Alternative rejected: a host-side relevance classifier — that's a second dispatch to answer a question the gather dispatch already answered.

5. **Short-circuit semantics.** On sentinel: skip synthesize, leave the session file untouched, advance the ledger watermark to the store's current tail (so the same noise never re-triggers), keep the existing `title`/`extracted_by`. The gather dispatch is still recorded in `runs[]` and its dossier in the run's observability dossiers — the spend was real and the trace explains the skip.

6. **Digest runs only when a session file was written.** If every session in the work set short-circuited, the run degenerates to "nothing actually drifted" — regenerating the digest from unchanged session files would be pure spend. Named ingests and any non-sentinel session still trigger the digest exactly once, as today.

7. **Refusal guard keys on host-confirmed presence.** Replace the `transcriptPath !== undefined` gate on `dossierReportsMissing` with: the host confirmed the session exists — either a transcript path was resolved (claude-code / hydrated cache) or `readWatermark` returns a value (covers present OpenCode sessions via the sqlite route, and any manifest session just classified). One extra cheap host-side read for new OpenCode ingests; no behavior change for genuinely absent sessions.

## Risks / Trade-offs

- **Gather wrongly rules a relevant delta irrelevant** → the watermark advances and that growth is never synthesized. Mitigation: the sentinel is restricted to delta mode (one delta at stake, not the session), the persona demands the sentinel only when *nothing* past the cursor serves the charter, and `refresh --all` rebuilds from scratch.
- **Off-charter growth leaves no phase trace** (file untouched on short-circuit) → accepted; the run dossier records what was skipped and why.
- **Sentinel compliance drift** (model wraps the token in prose) → exact-match recognition fails closed: the output is treated as a normal dossier and synthesized, costing what today already costs — never a wrong skip.
- **Phase wording churn across full refreshes** → phases are framing prose with no downstream consumers; churn is cosmetic by design.

## Migration Plan

Prompt/contract/guard changes only — no data migration. Existing session files without `## Phases` gain one on their next synthesis. Rollback is reverting the commit.

## Open Questions

None.
