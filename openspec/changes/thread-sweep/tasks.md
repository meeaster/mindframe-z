## 1. Ledger substrate

- [x] 1.1 Add `threadSweepRoot` (`~/.mindframe-z/thread-sweep/`) to `src/core/paths.ts` alongside `threadRunsRoot`
- [x] 1.2 Define verdict-ledger and sweep-state schemas (verdict grade, reason, judged_at, watermark pin, charter hash; baseline_at / last_sweep_at / last_review_at) in a new `src/thread/verdicts.ts` with zod validation and read-modify-write persistence, plus unit tests for voiding rules (agent/pass void on watermark or charter-hash move; reject sticky)
- [x] 1.3 Add charter hashing (sha256 of the manifest charter string, computed on demand) with tests

## 2. Detection

- [x] 2.1 Add sweep enumeration reusing `listClaudeItems`/`listOpencodeItems`: map to source-qualified ids + sourceMs, exclude Claude `/subagents/` paths and OpenCode `parent_id IS NOT NULL` children (extend `opencode-source.ts` or query directly); unit tests with fixture stores
- [x] 2.2 Implement candidate derivation in `src/thread/sweep.ts`: post-baseline ∧ (no pin ∨ stale charter hash ∨ signal newer than judged_at − freshness margin), member drift via `readWatermark`/`classifyWatermark` for flagged sessions only; tests covering the unchanged-costs-nothing, charter-edit, and new-thread scenarios
- [x] 2.3 Implement baseline staking on first sweep (write baseline_at before detection, report it) and the quiescence gate (profile `thread.defaults` window in minutes, default 30, `0` disables, `--include-hot` bypass, deferred sessions collected for the report); tests for first-run-proposes-nothing and deferral-does-not-lose-the-session

## 3. Triage dispatch

- [x] 3.1 Add `triage` persona to `src/thread/personas.ts` (read-only judge, one verdict line per charter, output discipline) and a `triage` role default (cheap tier) in `resolveSynthesisDefaults` (`src/thread/storage.ts`)
- [x] 3.2 Implement the triage dispatch in `sweep.ts`: one dispatch per candidate session with all applicable charters, parse verdict lines into per-(session, thread) rows, tolerate and report malformed lines; run-folder status/trace via existing observability helpers; tests with mocked dispatch

## 4. Sweep command

- [x] 4.1 Wire `mfz thread sweep` (`--include-hot`, `--triage-model`, `--json`) into `src/cli/mfz.ts` + `runThreadSweep` in `src/thread/cli.ts` under `withThreadLog`
- [x] 4.2 Implement the report: proposals → `pending`, drifted members per thread → `refresh --thread <slug>`, deferred hot sessions, malformed triage lines, counts since last_sweep_at; stamp last_sweep_at; assert no thread-repo writes in tests

## 5. Review commands

- [x] 5.1 Implement `mfz thread pending` (derived view: fits ∧ not member ∧ no human verdict; staleness flag from current pins; `--json`; zero dispatches) with tests for repeatability and stale-flagged proposals
- [x] 5.2 Implement `mfz thread reject <id> --thread <slug>` (overwrite pair row with sticky reject) with never-re-proposed test
- [x] 5.3 Implement `mfz thread conclude` (open proposals → pass pinned at current watermark + charter hash; stamp last_review_at) with growth-reopens test
- [x] 5.4 Verify ingest retires proposals and overrides reject with no ingest-code change (integration test over the derived pending view)

## 6. Skill and docs

- [x] 6.1 Add the review workflow to `skills/threads/SKILL.md` (sweep → pending → ingest/reject → conclude; refresh on drift reports) and fix its stale flag names while there
- [x] 6.2 Flag stale docs: mfz-thread design.md run-state path (`threads/runs/` → `thread-runs/runs/`) noted where encountered; confirm CONTEXT.md glossary matches shipped semantics
