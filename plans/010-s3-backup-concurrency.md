# Plan 010: Upload S3 session backups with bounded concurrency

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/sessions/backup.ts src/sessions/backup.test.ts`
> Compare the `backupHarness` excerpt below against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

`mfz sessions backup` uploads changed sessions one at a time per harness — each `PutObject` is a full serialized network round-trip. On a first backup or after a large batch of new sessions, wall-clock time scales linearly with (changed sessions × per-PUT latency); a small worker pool cuts that several-fold with no semantic change. The two harnesses already run in parallel; only the per-harness loop is serial.

## Current state

- `src/sessions/backup.ts:49-84` — the serial loop:

  ```ts
  export async function backupHarness(
    client: S3Client,
    archive: Archive,
    harness: string,
    items: BackupItem[]
  ): Promise<RunSummary> {
    const stored = await listArchivedTimes(client, archive, harness);
    const summary: RunSummary = { uploaded: 0, skipped: 0, failed: 0 };
    for (const item of items) {
      const key = objectKey(archive, harness, item.relPath);
      if (!needsUpload(item.sourceMs, stored.get(key))) {
        summary.skipped += 1;
        continue;
      }
      try {
        const body = await item.load();
        await client.send(new PutObjectCommand({ Bucket: archive.bucket, Key: key, Body: body, ContentType: item.contentType, ServerSideEncryption: "AES256" }));
        summary.uploaded += 1;
        console.log(`uploaded\t${key}`);
      } catch (error) {
        // Skip-and-continue: one unreadable session or transient error never aborts
        // the sweep. The run summary reports the count.
        summary.failed += 1;
        console.error(`failed\t${key}\t${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return summary;
  }
  ```

- Semantics that must be preserved exactly: the `needsUpload` freshness check per item, `ServerSideEncryption: "AES256"`, skip-and-continue on per-item errors, the `uploaded/skipped/failed` counts, and the tab-separated log lines. `item.load()` buffers the full file body — that is why concurrency must be bounded (memory), alongside S3 politeness.
- No pool/limit dependency exists in the repo, and adding one is unnecessary — an inline shared-queue worker loop is a few lines (repo convention: YAGNI, prefer stdlib).
- Tests: `src/sessions/backup.test.ts` exists (run via `pnpm test:sessions`) — read its mocking approach for `S3Client`/items before editing.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Session tests | `pnpm test:sessions` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/sessions/backup.ts` (`backupHarness` only)
- `src/sessions/backup.test.ts`

**Out of scope** (do NOT touch):
- `listArchivedTimes`, `needsUpload`, `FRESHNESS_MARGIN_MS` — the freshness model is settled (see the comment block at `backup.ts:11-18`).
- `src/sessions/hydrate.ts`, sources, preflight — untouched.
- Adding a concurrency CLI flag or config option — fixed constant only (YAGNI).

## Git workflow

- Branch: `advisor/010-s3-backup-concurrency`
- Commit: `perf(sessions): upload backups with a bounded worker pool`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the serial loop with a bounded worker pool

Keep the per-item body identical (freshness check, try/catch, counters, logs). Wrap it in workers draining a shared index:

```ts
const UPLOAD_CONCURRENCY = 8;

// ... inside backupHarness, replacing `for (const item of items) { ... }`:
let next = 0;
const worker = async (): Promise<void> => {
  while (true) {
    const index = next++;
    if (index >= items.length) return;
    const item = items[index]!;
    // (existing per-item body, unchanged)
  }
};
await Promise.all(
  Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, () => worker())
);
```

Notes for the executor: `next++` is safe — Node is single-threaded and there is no `await` between the read and increment. `items[index]!` needs the non-null assertion under `noUncheckedIndexedAccess` and is provably in-bounds from the guard above; alternatively restructure to avoid the `!` if oxlint objects. Summary mutations from multiple workers are safe for the same single-threaded reason. Add a one-line comment stating the bound exists for S3 politeness and because `item.load()` buffers whole files.

**Verify**: `pnpm build` → exit 0.

### Step 2: Tests

In `src/sessions/backup.test.ts`, following its existing mock style:

1. Existing tests still pass unchanged (counts and per-item semantics preserved). If any existing test asserts strict upload *ordering* of log lines, relax it to order-insensitive and note that in the commit message — ordering is no longer guaranteed by design.
2. New: with >8 items eligible for upload and a mocked `client.send` that resolves after a tick, assert all items upload and counts are exact.
3. New: concurrency bound — mock `client.send` to track in-flight calls (increment on entry, decrement on resolve; record the max) and assert max in-flight ≤ 8.
4. New: one item's `load()` rejects → `failed` increments by 1, all other items still upload.

**Verify**: `pnpm test:sessions` → all pass, including the new tests.

## Test plan

- The three new cases above plus any ordering-assertion relaxation, in `src/sessions/backup.test.ts`, matching its current mocking pattern.
- Verification: `pnpm test:sessions`; then `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "UPLOAD_CONCURRENCY" src/sessions/backup.ts` → constant defined and used
- [ ] `pnpm test:sessions` exits 0, including a max-in-flight ≤ 8 assertion
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `backupHarness` no longer matches the excerpt (drift).
- The existing test file's mocking approach can't observe concurrent `send` calls without restructuring production code.
- You discover an ordering dependency between uploads (e.g. a marker object that must land last) — serial order would then be load-bearing; report it.

## Maintenance notes

- If S3 throttling (`SlowDown`) ever appears in failed counts, lower `UPLOAD_CONCURRENCY` before adding retry logic.
- The summary's `failed` count is the only error surface — a reviewer should confirm log lines remain greppable (`uploaded\t`, `failed\t`) since ordering is now nondeterministic.
