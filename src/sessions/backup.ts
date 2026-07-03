import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Archive } from "../core/manifests.js";
import { createRuntimePaths, type RuntimePaths } from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import { harnessPrefix, listObjects, objectKey, resolveDefaultArchive } from "./archive.js";
import type { BackupItem } from "./backup-item.js";
import { listClaudeItems } from "./claude-source.js";
import { listOpencodeItems } from "./opencode-source.js";
import { assertBucketHardened } from "./preflight.js";

// `LastModified` is upload time, which always postdates the write that triggered
// the upload. A write landing during or shortly after a sweep would otherwise
// compare older-than-stored and be skipped on every future run, so the guard
// subtracts this margin from the stored time before comparing. A margin-triggered
// re-upload resets `LastModified` well past the frozen source signal, so the margin
// costs at most one redundant upload per session — chosen generously above any
// realistic single-session upload latency.
const FRESHNESS_MARGIN_MS = 5 * 60_000;

// Whether a session's current source signal is fresh enough to (re-)upload: true
// when there's no stored copy yet, or the source signal is newer than the stored
// LastModified minus the safety margin.
export function needsUpload(sourceMs: number, storedMs: number | undefined): boolean {
  return storedMs === undefined || sourceMs > storedMs - FRESHNESS_MARGIN_MS;
}

// One paginated ListObjectsV2 sweep of the archive's <harness> prefix maps key to
// stored LastModified in ms. This is the whole freshness guard's input; there is no
// separate local index — the bucket is the catalog.
async function listArchivedTimes(
  client: S3Client,
  archive: Archive,
  harness: string
): Promise<Map<string, number>> {
  const prefix = harnessPrefix(archive, harness);
  const times = new Map<string, number>();
  for await (const object of listObjects(client, archive.bucket, prefix)) {
    if (object.Key && object.LastModified) times.set(object.Key, object.LastModified.getTime());
  }
  return times;
}

interface RunSummary {
  uploaded: number;
  skipped: number;
  failed: number;
}

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
      await client.send(
        new PutObjectCommand({
          Bucket: archive.bucket,
          Key: key,
          Body: body,
          ContentType: item.contentType,
          ServerSideEncryption: "AES256"
        })
      );
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

export async function runSessionsBackup(options: {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
}): Promise<void> {
  const paths: RuntimePaths = createRuntimePaths({ root: options.root, home: options.home });
  const profile = await resolveProfile(paths, options.profile);
  const archive = resolveDefaultArchive(profile.manifests.machine.archives);

  const client = new S3Client({ region: archive.region });
  await assertBucketHardened(client, archive);

  const [claudeItems, opencodeItems] = await Promise.all([
    listClaudeItems(paths),
    listOpencodeItems(paths)
  ]);
  const subagents = claudeItems.filter((item) => item.relPath.includes("/subagents/")).length;
  console.log(
    `found ${claudeItems.length - subagents} claude sessions + ${subagents} subagent transcripts, ` +
      `${opencodeItems.length} opencode sessions`
  );

  const [claude, opencode] = await Promise.all([
    backupHarness(client, archive, "claude-code", claudeItems),
    backupHarness(client, archive, "opencode", opencodeItems)
  ]);

  const uploaded = claude.uploaded + opencode.uploaded;
  const skipped = claude.skipped + opencode.skipped;
  const failed = claude.failed + opencode.failed;
  const dest = `s3://${archive.bucket}${archive.prefix ? "/" + archive.prefix : ""}`;
  console.log(`\n${uploaded} uploaded / ${skipped} skipped / ${failed} failed  → ${dest}`);
}
