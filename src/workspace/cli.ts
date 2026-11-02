import path from "node:path";
import { createRuntimePaths, type PathOptions } from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import {
  commandIsInteractive,
  createOperationReporter,
  printInventory
} from "../cli/operation-report.js";
import {
  discoverRepositories,
  repositoryStatus,
  statusExclusions,
  syncWorkspace,
  workspaceRoot,
  type RepositoryStatus
} from "./repositories.js";

interface WorkspaceOptions extends PathOptions {
  profile?: string | undefined;
}

function pendingSummary(status: RepositoryStatus): string {
  const tree = status.changes.length === 0 ? "clean" : `${status.changes.length} change(s)`;

  const remote = status.upstream
    ? `${status.ahead} ahead, ${status.behind} behind ${status.upstream}`
    : "no upstream";

  return `${status.branch} · ${tree} · ${remote}`;
}

// Read-only: compares against configured upstream refs without fetching, and lists only
// checkouts with local changes or unpushed commits.
export async function runWorkspaceStatus(options: WorkspaceOptions): Promise<void> {
  const paths = createRuntimePaths(options);
  const profile = await resolveProfile(paths, options.profile);
  const root = workspaceRoot(profile, paths.home);
  const pending: RepositoryStatus[] = [];

  for (const repository of await discoverRepositories(root, statusExclusions(root))) {
    const status = await repositoryStatus(repository);

    if (status.changes.length > 0 || status.ahead > 0) pending.push(status);
  }

  printInventory(
    "mfz workspace status",
    root,
    pending.map(
      (status) =>
        `${path.relative(root, status.path) || "."}\t${status.branch}\t${status.changes.length}\t${status.ahead}\t${status.behind}`
    ),
    pending.map((status) => ({
      label: path.relative(root, status.path) || ".",
      detail: [pendingSummary(status), ...status.changes.map((change) => `  ${change}`)].join("\n")
    })),
    undefined,
    "repository with pending work"
  );
}

export async function runWorkspaceSync(
  options: WorkspaceOptions & { verbose?: boolean | undefined }
): Promise<boolean> {
  const paths = createRuntimePaths(options);
  const profile = await resolveProfile(paths, options.profile);

  const reporter = createOperationReporter({
    command: "mfz workspace sync",
    scope: workspaceRoot(profile, paths.home),
    verbose: options.verbose ?? false,
    interactive: commandIsInteractive()
  });

  try {
    await syncWorkspace(profile, paths.home, reporter.complete.bind(reporter));

    return reporter.finish();
  } catch (error) {
    reporter.fail(error instanceof Error ? error : new Error(String(error)));

    return false;
  }
}
