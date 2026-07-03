import path from "node:path";
import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import type { Archive } from "../core/manifests.js";
import { archiveCacheRoot, type RuntimePaths } from "../core/paths.js";

// The writable archive: the last one flagged default (later entries — i.e. machine
// config — override earlier ones), else the first configured. Mirrors
// defaultThreadDestination in src/thread/storage.ts.
export function defaultArchive(archives: readonly Archive[]): Archive | undefined {
  return archives.findLast((a) => a.default) ?? archives[0];
}

// Resolve the writable default archive, or throw a clear, actionable error. Also
// rejects a profile-pinned archive: @aws-sdk/credential-provider-ini isn't wired in
// this slice, and silently falling back to default creds would risk writing under
// the wrong AWS identity.
export function resolveDefaultArchive(archives: readonly Archive[]): Archive {
  const archive = defaultArchive(archives);
  if (!archive) {
    throw new Error(
      "No archives configured. Add an `archives` entry to ~/.mindframe-z/config.yml."
    );
  }
  if (archive.profile) {
    throw new Error(
      `Archive '${archive.name}' pins AWS profile '${archive.profile}', which is not supported yet ` +
        "(credentials resolve only through the AWS SDK default provider chain). Remove `profile` " +
        `from archive '${archive.name}' or use an archive without one.`
    );
  }
  return archive;
}

// One paginated ListObjectsV2 sweep, yielded page by page — the token-plumbing both
// backup's freshness sweep and hydration's prefix-pull need, so neither reimplements it.
export async function* listObjects(client: S3Client, bucket: string, prefix: string) {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
    );
    for (const object of page.Contents ?? []) yield object;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

// Flat key: <prefix>/<harness>/<relPath>. The bucket is the catalog — no local
// index. Empty prefix segments drop out so a prefix-less archive keys at the root.
export function objectKey(archive: Archive, harness: string, relPath: string): string {
  return [archive.prefix, harness, relPath].filter((seg) => seg !== "").join("/");
}

export function harnessPrefix(archive: Archive, harness: string): string {
  return [archive.prefix, harness].filter((seg) => seg !== "").join("/") + "/";
}

// The relative filename of a session's primary artifact within its harness — mirrors
// the relPath convention listClaudeItems/listOpencodeItems upload under. Claude
// transcripts are copied verbatim (.jsonl); OpenCode sessions are exported (.json).
export function primaryRelPath(harness: string, id: string): string {
  return harness === "opencode" ? `${id}.json` : `${id}.jsonl`;
}

// Where a hydrated session's primary artifact lands in the local archive-cache —
// the one path both the watermark cache-fallback and the gather explicit-path seam
// check for "is this session hydrated".
export function cachedSessionPath(paths: RuntimePaths, harness: string, id: string): string {
  return path.join(archiveCacheRoot(paths), harness, primaryRelPath(harness, id));
}

// Marks a session confirmed absent from every reachable, non-profile-pinned archive,
// so a repeated refresh doesn't re-run a full ListObjectsV2 sweep for a session that
// will never come back (the common case: anything older than backup being enabled).
// Named distinctly from primaryRelPath's `<id>.jsonl`/`<id>.json` so the two can never
// collide on disk.
export function absentMarkerPath(paths: RuntimePaths, harness: string, id: string): string {
  return path.join(archiveCacheRoot(paths), harness, `${id}.absent`);
}
