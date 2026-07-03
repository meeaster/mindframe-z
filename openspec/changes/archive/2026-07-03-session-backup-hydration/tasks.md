## 1. Archives config + dependency

- [x] 1.1 Add `@aws-sdk/client-s3` to dependencies (exact version, >7 days old); run `pnpm schemas` after schema edits
- [x] 1.2 Formalize `archiveSchema` and `machine.archives` in `src/core/manifests.ts` (`{ name, bucket, region, prefix?, profile?, default? }`), sibling to thread `destinations` — lift from the prototype branch (commit `76f5f41`)
- [x] 1.3 Add archive resolution: `defaultArchive` (last `default`, else first) and read-only source resolution; error clearly when no archive is configured
- [x] 1.4 Reject a resolved archive that sets `profile` with a clear "not supported" error (no silent default-cred fallback)

## 2. Base backup command (`mfz sessions backup`)

- [x] 2.1 Land `src/sessions/backup.ts`: enumerate local Claude transcripts (sessions + `<id>/subagents/agent-*.jsonl` under the session prefix); lift from prototype
- [x] 2.2 Add the bucket-hardening preflight: `GetPublicAccessBlock` on the default archive's bucket must report all four flags true; abort with an actionable error (upload nothing) when the check fails or the config is unreadable. Note: `GetPublicAccessBlock` returns `NoSuchPublicAccessBlockConfiguration` when Block Public Access is set only at the account level — the error message SHALL direct the operator to set **bucket-level** Block Public Access so an account-hardened bucket is not mistaken for an open one
- [x] 2.3 Implement the freshness guard: one paginated `ListObjectsV2` → `key → LastModified`; upload when the source signal is newer than `LastModified` minus a fixed safety margin (mid-sweep writes must not be frozen out — see spec); set `ServerSideEncryption: AES256` on every `PutObject`
- [x] 2.4 Implement skip-and-continue with an `N uploaded / M skipped / K failed` run summary
- [x] 2.5 Add OpenCode extraction: enumerate sessions from `opencode.db` (`SELECT id FROM session` — current OpenCode has no `storage/session/info/` files), derive each session's freshness signal as the greater of the session row's `time_updated` and its latest message `time_created` (message growth may not bump `time_updated`), extract via `opencode export <id>` (full-fidelity `{ info, messages }` on stdout — never pass `--sanitize`), upload the JSON to `<prefix>/opencode/<id>.json`, under the same freshness guard
- [x] 2.6 Wire `mfz sessions backup` into `src/cli/mfz.ts` (new `sessions` command group)
- [x] 2.7 Tests for `defaultArchive`, `objectKey`, subagent-prefix keying, the freshness decision (`upload-new` / `upload-changed` / `skip`, plus the mid-sweep-write margin case), the OpenCode db-derived signal, and the preflight abort using temp dirs and a mocked/faked S3 seam

## 3. Membership-hydration consumer

- [x] 3.1 Add hydrate-by-prefix: `ListObjectsV2` on `<harness>/<id>` across readable archives, `GetObject` each, write into `~/.mindframe-z/archive-cache/<harness>/<id>...` preserving the subtree; write-once — skip the archive entirely when a cached copy already exists
- [x] 3.2 Add `~/.mindframe-z/archive-cache/` to gitignore and mount it read-only into the tools container
- [x] 3.3 Wire the `vanished` branch in the thread refresh/ingest path (`src/thread/ingest.ts`) to attempt hydration before treating a session as unrecoverable; consult the archive only for vanished sessions; degrade to no-op when no archive is readable. Note: today's `classifyWatermark` (`src/thread/watermark.ts`) collapses *absent-from-store* and *shrank-below-count* into one `vanished` status, but the archive must be consulted only for the absent case (see the `thread-session-watermarks` shrank-but-present scenario) — split the status (e.g. `vanished` vs `shrank`) or re-check store presence before hydrating, so a shrank-but-present session triggers no archive read
- [x] 3.4 Add `readWatermark` archive-cache fallback in `src/thread/watermark.ts` (local store else cached copy)
- [x] 3.5 Add `tailSignatureFromExport` (mirror of `tailSignatureFromJsonl`) for archived OpenCode export JSON
- [x] 3.6 Generalize the explicit-path gather seam to OpenCode for cached artifacts only — present OpenCode sessions keep today's discovery path — so gather reads the cached artifact for both harnesses
- [x] 3.7 Update the `opencode-sessions` skill with an "archived export JSON" section so the gather agent reads `{ info, messages }` directly
- [x] 3.8 Accept the `stale-recover` edge: archived tail older than the ledger cursor stays `vanished`/untouched, with an optional one-line warning
- [x] 3.9 Tests: prefix-pull hydration, write-once cache (no archive read on a cache hit), cache-not-live-store, watermark cache fallback for both harnesses, shrank-but-present performs no archive read, and the three lifecycle cases (recoverable / stale-recover / unrecoverable)

## 4. Docs + cleanup

- [x] 4.1 Document `mfz sessions backup` and the `archives` machine-config concept (README/AGENTS command list); clarify archive (raw sessions) vs destination (synthesized store)
- [x] 4.2 Remove the throwaway `src/sessions/prototype/` and tear down the scratch bucket (`mfz-sessions-proto-*`) per `NOTES.md`
- [x] 4.3 Verification: `pnpm test:thread`, `pnpm build`, `pnpm check`; a real end-to-end run of `mfz sessions backup` against the configured archive

## 5. Adversarial-review hardening

- [x] 5.1 Fix OpenCode data-home resolution boundary: centralize `XDG_DATA_HOME`-aware db/data-dir resolution (`opencodeDataHome`/`opencodeDbPath` in `src/core/paths.ts`), used by both session enumeration/export (`opencode-source.ts`) and watermark reads (`watermark.ts`), so a `--home`/`MFZ_HOME` override can't desync the two
- [x] 5.2 Rewrite `hydrateSession` for atomic multi-object commit: stage all downloads under a per-attempt staging dir, commit via `rename` only once every key succeeds, always clean up staging in a `finally`
- [x] 5.3 Add negative caching (`<id>.absent` marker) for sessions confirmed absent from every reachable, non-pinned archive; never written on error/unreachable/all-pinned
- [x] 5.4 Skip profile-pinned archives during hydration reads (mirrors the write-side hard rejection) instead of falling back to ambient default credentials
- [x] 5.5 Parallelize independent backup sweeps (`Promise.all` for Claude/OpenCode enumeration and upload) in `runSessionsBackup`
- [x] 5.6 Delete `readableArchives` thin pass-through wrapper; extract a shared `listObjects` pagination generator reused by backup and hydrate
- [x] 5.7 Extract `classifySession` helper out of `resolveRefreshSet`'s inline map callback
- [x] 5.8 Add a watermark parity test pinning `tailSignatureFromExport` against the db-backed reader for equivalent data
- [x] 5.9 Verification: `pnpm check`, `pnpm test:thread`, `pnpm test:all` green; live end-to-end tests against the real archive bucket (idempotent repeat backup, byte-identical hydration round-trip, negative-cache round-trip)
