import { rm } from "node:fs/promises";
import { createRuntimePaths } from "../core/paths.js";
import { installedLinkBackups } from "../core/installed.js";

export interface CleanOptions {
  root?: string | undefined;
  home?: string | undefined;
  backups?: boolean | undefined;
  dryRun?: boolean | undefined;
}

// Deletes the backups apply left beside the links it installed. Backups can hold a user's own
// replaced files, so this only runs on request and --dry-run lists them first.
export async function clean(options: CleanOptions): Promise<void> {
  if (!options.backups) throw new Error("Nothing to clean; pass --backups.");

  const paths = createRuntimePaths({ root: options.root, home: options.home });
  const backups = await installedLinkBackups(paths);

  for (const backup of backups) {
    if (!options.dryRun) await rm(backup, { recursive: true, force: true });
    console.log(`${options.dryRun ? "would remove" : "removed"}\tbackup\t${backup}`);
  }

  if (backups.length === 0) console.log("no backups beside installed links");
}
