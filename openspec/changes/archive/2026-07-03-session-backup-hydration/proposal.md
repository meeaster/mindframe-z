## Why

Claude Code deletes local session transcripts at `cleanupPeriodDays` (~30 days), so long-lived threads permanently lose the source material they were synthesized from — and there is no durable, out-of-git home for raw session history. Keeping full-fidelity transcripts in git is unacceptable (size + secrets), so they currently live only on the machine and vanish on the deletion clock or a lost laptop. An S3 archive is the safe backup, and threads can then re-read an aged-out session on demand instead of treating it as gone.

## What Changes

- **New `mfz sessions backup` command** that mirrors every local Claude Code and OpenCode session to an S3 archive, full-fidelity, keyed by session id — idempotent, incremental, and safe to run repeatedly.
- **New `archives` machine-config concept** (sibling to thread `destinations`, in `~/.mindframe-z/config.yml`): named S3 stores `{ name, bucket, region, prefix, profile }` with exactly one `default: true` (writable) and the rest read-only. Routing is by **origin machine** — a machine writes only to its default archive, and IAM (not code) makes cross-boundary (e.g. work→personal) leakage impossible.
- **Full-fidelity, self-describing per-session artifacts**: Claude `.jsonl` copied verbatim (including subagent transcripts, stored *under* the session's own `claude-code/<id>/` prefix); OpenCode extracted via the vendor-maintained `opencode export <id>` (`{ info, messages }` JSON). No local index — the bucket is the catalog (`ListObjectsV2`), with a margin-adjusted freshness guard (source signal vs stored `LastModified`; OpenCode's signal comes entirely from `opencode.db` — the greater of the session's `time_updated` and its latest message `time_created`) so per-run cost tracks churn and mid-sweep writes are never frozen out.
- **Membership-hydration for threads**: a thread ledger session that has `vanished` locally is pulled back from a readable archive by **prefix** (not a single key, because of subagents) into a gitignored `~/.mindframe-z/archive-cache/`, mounted read-only into the tools container. Gather and the watermark reader consume the cached artifact; the archive is consulted *only* for vanished sessions and degrades gracefully when unreachable.
- **OpenCode format bridge**: a `tailSignatureFromExport` watermark reader plus `opencode-sessions` skill guidance so the gather agent can read an archived `opencode export` JSON (its format differs from the native store).
- **Explicitly out of scope** (deferred, design-compatible): scheduling/cron, archive discovery + metadata index, work→personal promotion, cross-machine watermark pull, and profile-pinned archive credentials (`profile` set → clear "not supported" error until `@aws-sdk/credential-provider-ini` is wired).

## Capabilities

### New Capabilities
- `session-backup`: The `archives` machine-config concept, the `mfz sessions backup` command, per-session extraction (Claude verbatim + subagents; OpenCode via `opencode export`), the flat `<prefix>/<harness>/<id>` key layout, a bucket-hardening preflight (`GetPublicAccessBlock`) that refuses to upload against a bucket without full Block Public Access, the `ListObjectsV2` freshness guard, origin-machine/IAM routing, and skip-and-continue failure handling.
- `session-hydration`: Pulling a `vanished` thread session back from a readable archive by prefix into the read-only archive-cache, and having gather read the cached artifact via the explicit-path seam (generalized to OpenCode).

### Modified Capabilities
- `thread-session-watermarks`: `readWatermark` gains an archive-cache fallback when a session is absent locally (the only behavioral change hydration makes to watermarking), plus a `tailSignatureFromExport` signature for archived OpenCode export JSON. The `stale-recover` edge (hydrated archive copy older than the ledger cursor) is accepted as `vanished` with no new code beyond an optional one-line warning.

## Impact

- **New code**: `src/sessions/backup.ts` (real slice already exists on `feat/sessions-backup-prototype`, commit `76f5f41`), OpenCode extraction, hydration + archive-cache, `src/cli/mfz.ts` wiring for `mfz sessions`.
- **Modified code**: `src/core/manifests.ts` (`archiveSchema`, `machine.archives` — already present on the prototype branch), `src/thread/watermark.ts` (cache fallback + `tailSignatureFromExport`), the thread refresh/ingest path (`src/thread/ingest.ts`), and the `opencode-sessions` skill doc.
- **New dependency**: `@aws-sdk/client-s3` (exact version, >7 days old). Credentials resolve via the SDK default provider chain — mfz never stores a secret.
- **Config**: `archives` block in machine-local `~/.mindframe-z/config.yml` (never committed); `~/.mindframe-z/archive-cache/` added to gitignore and mounted read-only into the tools container.
- **Docs**: README/AGENTS command list and the thread destination/archive distinction.
- **No breaking changes**: existing thread destinations (git-remote backup of the *synthesized* store) are untouched; archives are a separate concept for *raw* sessions.
