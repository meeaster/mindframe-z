import { GetPublicAccessBlockCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Archive } from "../core/manifests.js";

// Because backups are full-fidelity and unsanitized, refuse to upload anything
// unless the bucket has all four S3 Block Public Access flags enabled. Runs once,
// before the freshness sweep.
export async function assertBucketHardened(client: S3Client, archive: Archive): Promise<void> {
  let config;
  try {
    const result = await client.send(new GetPublicAccessBlockCommand({ Bucket: archive.bucket }));
    config = result.PublicAccessBlockConfiguration;
  } catch (error) {
    // GetPublicAccessBlock throws NoSuchPublicAccessBlockConfiguration when Block
    // Public Access is set only at the account level, not the bucket level — the
    // account-level setting doesn't satisfy this bucket-scoped check, so the error
    // path is the same "not verified" abort as a missing-permission failure.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not verify Block Public Access on bucket '${archive.bucket}' (${message}). ` +
        "Set BUCKET-LEVEL Block Public Access (all four settings) on this bucket — an " +
        "account-level setting alone does not satisfy this check. Aborting; nothing uploaded."
    );
  }
  const allBlocked = Boolean(
    config?.BlockPublicAcls &&
    config?.IgnorePublicAcls &&
    config?.BlockPublicPolicy &&
    config?.RestrictPublicBuckets
  );
  if (!allBlocked) {
    throw new Error(
      `Bucket '${archive.bucket}' does not have all four Block Public Access flags enabled. ` +
        "Enable BUCKET-LEVEL Block Public Access (BlockPublicAcls, IgnorePublicAcls, " +
        "BlockPublicPolicy, RestrictPublicBuckets) before backing up full-fidelity session " +
        "data. Aborting; nothing uploaded."
    );
  }
}
