## 1. Schema changes

- [x] 1.1 Add optional `message_count`, `last_message_id`, `last_activity_at` to the session entry in `src/thread/schema.ts` (`threadSessionSchema`), keeping all three optional so older manifests parse.
- [x] 1.2 Mirror the three optional watermark fields into `schemas/thread-manifest.schema.json` session items.
- [x] 1.3 Add `update_strategy: z.enum(["full","delta"]).optional()` to `profileThreadSchema` in `src/core/manifests.ts` as a sibling of `defaults` (not inside `threadDefaultsSchema`); keep it optional with no parse-time default so a child profile inherits the parent's value, and thread it through `ResolvedProfile`.

## 2. Host-side watermark reader

- [x] 2.1 Create `src/thread/watermark.ts` exporting a function that, given `{ source, id }`, returns the current tail signature `{ message_count, last_message_id, last_activity_at }` or `undefined` when the session is absent from the store.
- [x] 2.2 Implement the claude-code reader: glob `~/.claude/projects/*/<id>.jsonl`, take the last line's message id and timestamp, and line count for `message_count`.
- [x] 2.3 Implement the opencode reader: query `~/.local/share/opencode/opencode.db` for `count(*)`, last `message.id`, and `max(time_created)` for the session id, using read-only access.
- [x] 2.4 Add a `changed(stored, current)` helper returning changed / unchanged / vanished-or-shrank per the spec rule (differs on count or last id = changed; missing cursor or lower count = vanished/shrank).
- [x] 2.5 Unit tests for the reader and `changed` helper against fixture transcripts/db rows, including the absent-session and shrank cases.

## 3. Watermark capture

- [x] 3.1 After a session's synthesize succeeds in `src/thread/ingest.ts`, compute its current watermark via the reader and include it in the ledger entry passed to `recordSessions`.
- [x] 3.2 Extend `SessionLedgerEntry` / `recordSessions` in `src/thread/storage.ts` to persist the watermark fields in the read-modify-write upsert.
- [x] 3.3 Tests asserting the watermark is written for ingested sessions and that an entry without a watermark still round-trips.

## 4. Ingest-time staleness detection and auto-refresh

- [x] 4.1 In `ingestThread`, before the per-session fan-out, recompute current watermarks for all existing manifest sessions (no dispatch) and partition into changed / unchanged / vanished-or-shrank.
- [x] 4.2 Run detection before any refresh dispatch (so unchanged sessions are never charged), and report the changed and vanished/shrank sets in the command output.
- [x] 4.3 Merge changed-session ids with the explicitly-named ids, de-duplicated, as the refresh work set; leave unchanged and vanished/shrank sessions untouched.
- [x] 4.4 Keep a single digest pass at the end over all current session files.
- [x] 4.5 Tests with a fake `AgentRunner` (mirroring `runner.test.ts`/`ingest` test style) covering: unchanged session skipped, grown session refreshed alongside a named id, no-named-id-but-changed case, and vanished/shrank left untouched — single digest dispatch in each.

## 5. Update strategy

- [x] 5.1 Resolve `update_strategy` from config at the point of refresh (optional field → `full` when unset), alongside the existing synthesis-default resolution.
- [x] 5.2 `full` path: refresh a changed session via the existing whole-session gather → synthesize → overwrite file.
- [x] 5.3 `delta` path: pass the stored `last_message_id` so gather reads only messages after it, and give synthesize the prior session file so it revises rather than regenerates (resolve the delta-prompt open question from design.md first).
- [x] 5.4 Tests: default resolves to `full`; `delta` config drives the delta gather/synthesize prompts.

## 6. Refresh command and ingest split

- [x] 6.1 Make `mfz thread ingest` require `<ids...>`; a no-id invocation errors and dispatches nothing.
- [x] 6.2 Add `mfz thread refresh --thread <slug>` sharing the `ingestThread` core with an empty id set: refresh only drifted sessions, digest once, and treat "nothing drifted" as a successful no-op instead of an error.
- [x] 6.3 Add `--all` to `refresh` forcing a full re-gather + re-synthesis of every present session (skipping vanished), always full even under `update_strategy: delta`; record the run mode (`ingest` / `refresh` / `refresh --all`) on the run status and commit message.
- [x] 6.4 Tests: `refresh` no-op success when nothing drifted, no-id `ingest` errors, and `--all` forces full re-synthesis of every present session while skipping vanished ones.

## 7. Docs and validation

- [x] 7.1 Update the `threads` skill (`skills/threads/SKILL.md`) to document the ids-required `ingest`, the `refresh` command with `--all`, and that `update_strategy` config selects full vs delta.
- [x] 7.2 Run the project test suite and typecheck; ensure existing thread tests still pass.
- [x] 7.3 Run `openspec validate add-thread-session-watermarks` and resolve any issues.
