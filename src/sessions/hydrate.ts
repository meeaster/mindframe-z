import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Archive } from "../core/manifests.js";
import { archiveCacheRoot, pathExists, type RuntimePaths } from "../core/paths.js";
import { absentMarkerPath, cachedSessionPath, harnessPrefix, listObjects } from "./archive.js";

// Write-once: an existing cached copy is used without re-consulting the archive.
// Refreshing an already-hydrated session from a newer archive copy belongs with the
// deferred cross-machine pull, not this consumer.
export async function isHydrated(
  paths: RuntimePaths,
  harness: string,
  id: string
): Promise<boolean> {
  return pathExists(cachedSessionPath(paths, harness, id));
}

// Download every key of one session into a staging directory, then commit (rename)
// into the real cache only once every object has landed. A session's primary
// transcript sorts lexicographically before its `<id>/subagents/...` keys, so a
// download that failed partway through — without this staging step — could leave a
// primary-only cache that `isHydrated` reports as complete forever. Staging lives
// under the cache root (already gitignored) and is always cleaned up.
async function downloadSessionAtomic(
  client: S3Client,
  bucket: string,
  keys: string[],
  stripPrefix: string,
  harness: string,
  cacheRoot: string
): Promise<void> {
  const staging = path.join(cacheRoot, ".staging", `${harness}-${randomUUID()}`);
  try {
    for (const key of keys) {
      const rel = key.slice(stripPrefix.length);
      const dest = path.join(staging, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (object.Body === undefined) throw new Error(`empty response body for key: ${key}`);
      const bytes = await object.Body.transformToByteArray();
      await writeFile(dest, Buffer.from(bytes));
    }
    for (const key of keys) {
      const rel = key.slice(stripPrefix.length);
      const dest = path.join(cacheRoot, harness, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(path.join(staging, rel), dest);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Pull a vanished session back from the first readable archive that holds it, by
// **prefix** — a session's subagent transcripts live under its own key prefix, so a
// single GetObject by key would miss them. Tries every configured archive in order;
// an unreachable archive, or one where the download fails partway through, falls
// through to the next rather than aborting the whole hydration attempt. Returns
// whether the session is now cached (already was, or was just hydrated) — false when
// no archive holds it, in which case the session stays vanished with no error.
//
// Once every configured, reachable, non-profile-pinned archive has been checked and
// came back empty (no errors), the outcome is cached with an `.absent` marker so a
// permanently-gone session doesn't re-run a full ListObjectsV2 sweep on every future
// refresh. A failed/unreachable archive never counts toward that confirmation — an
// outage must not get cached as "gone forever".
//
// `clientFor` is injectable so tests can exercise the prefix-pull/write-once logic
// against a fake S3 without touching a real bucket; production callers rely on the
// default, one real client per archive region.
export async function hydrateSession(
  paths: RuntimePaths,
  archives: readonly Archive[],
  harness: string,
  id: string,
  clientFor: (archive: Archive) => S3Client = (archive) => new S3Client({ region: archive.region })
): Promise<boolean> {
  if (await isHydrated(paths, harness, id)) return true;
  if (await pathExists(absentMarkerPath(paths, harness, id))) return false;

  let checkedAny = false;
  let allConfirmedAbsent = true;
  for (const archive of archives) {
    // resolveDefaultArchive rejects a profile-pinned archive outright on the write
    // path, since @aws-sdk/credential-provider-ini isn't wired; reading one here with
    // ambient default-chain creds would risk pulling under the wrong AWS identity, so
    // skip it the same way instead of silently falling back to the wrong credentials.
    if (archive.profile) continue;
    checkedAny = true;

    const prefix = harnessPrefix(archive, harness) + id;
    const client = clientFor(archive);
    try {
      const keys: string[] = [];
      for await (const object of listObjects(client, archive.bucket, prefix)) {
        if (object.Key) keys.push(object.Key);
      }
      if (keys.length === 0) continue;
      await downloadSessionAtomic(
        client,
        archive.bucket,
        keys,
        harnessPrefix(archive, harness),
        harness,
        archiveCacheRoot(paths)
      );
      return true;
    } catch {
      // This archive is unreachable (network, permissions, wrong region), or the
      // download failed partway through — try the next configured one, and don't let
      // this count as confirmation the session is absent everywhere.
      allConfirmedAbsent = false;
    }
  }

  if (checkedAny && allConfirmedAbsent) {
    const marker = absentMarkerPath(paths, harness, id);
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "", "utf8");
  }
  return false;
}
