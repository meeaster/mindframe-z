import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  planRemovePathOutcome,
  removePathOutcome,
  writeJsonAtomicOutcome
} from "./file-operations.js";
import type { OperationCompletion, OperationOutcome } from "./operations.js";
import type { RuntimePaths, ToolTarget } from "./paths.js";
import { linkStatus } from "../skills/link-state.js";

// Every link apply installs on the host, across all profiles and harnesses. Apply removes what a
// render no longer wants from this record rather than from what the current profile happens to
// visit, so switching profiles or dropping a harness leaves nothing behind.

const toolTargetSchema = z.enum(["opencode", "claude-code", "codex", "pi", "mise", "dotfiles"]);

const installedLinkSchema = z.object({
  path: z.string(),
  /** Absolute resolved target, compared before removal so a link someone repointed is left alone. */
  target: z.string(),
  owner: toolTargetSchema
});

const installedRecordSchema = z.object({
  version: z.literal(1),
  links: z.array(installedLinkSchema)
});

export type InstalledLink = z.infer<typeof installedLinkSchema>;

export function installedRecordPath(paths: RuntimePaths): string {
  return path.join(paths.configsDir, ".installed.json");
}

export async function readInstalledLinks(paths: RuntimePaths): Promise<InstalledLink[]> {
  let text: string;

  try {
    text = await readFile(installedRecordPath(paths), "utf8");
  } catch {
    return [];
  }

  // A corrupt record cannot authorize removals; the next apply rewrites it from current state.
  const parsed = installedRecordSchema.safeParse(JSON.parse(text));

  return parsed.success ? parsed.data.links : [];
}

// Skill links live in each harness's skill directory; the directory names the owning harness.
export function skillLinkOwner(paths: RuntimePaths, linkPath: string): ToolTarget | undefined {
  const directory = path.dirname(linkPath);

  if (directory === path.join(paths.opencodeConfigDir, "skills")) return "opencode";

  if (directory === path.join(paths.claudeDir, "skills")) return "claude-code";

  if (directory === path.join(paths.home, ".agents", "skills")) return "codex";

  return undefined;
}

function systemdUnitDirectory(paths: RuntimePaths): string {
  return path.join(paths.home, ".config", "systemd", "user");
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false
  );
}

/**
 * Removes recorded links of the reconciled owners that are no longer desired, then records the
 * desired links that are in place. Owners outside `owners`, such as harnesses a partial apply did
 * not render, keep their entries untouched.
 */
export async function reconcileInstalledLinks(
  paths: RuntimePaths,
  owners: ReadonlySet<ToolTarget>,
  desired: readonly InstalledLink[],
  options: { dryRun: boolean; onComplete: OperationCompletion }
): Promise<void> {
  const previous = await readInstalledLinks(paths);
  const wanted = new Set(desired.map((link) => link.path));
  const kept: InstalledLink[] = [];
  let unitsRemoved = false;

  for (const link of previous) {
    if (!owners.has(link.owner)) {
      kept.push(link);
      continue;
    }

    if (wanted.has(link.path)) continue;

    const status = await linkStatus(link.path);

    if (status.state === "missing") continue;

    if (status.state !== "symlink" || status.resolved !== link.target) {
      options.onComplete({
        category: "link",
        action: "remove",
        status: "skipped",
        target: link.path,
        significance: "meaningful",
        detail: "changed since mfz linked it; left in place"
      });
      continue;
    }

    if (options.dryRun) {
      await planRemovePathOutcome(link.path, { category: "link", onComplete: options.onComplete });
    } else {
      await removePathOutcome(link.path, { category: "link", onComplete: options.onComplete });
    }

    if (path.dirname(link.path) === systemdUnitDirectory(paths)) unitsRemoved = true;
  }

  // mfz never drives systemctl; a removed unit stays loaded, and keeps running if it was active,
  // until the user reloads.
  if (unitsRemoved) {
    options.onComplete({
      category: "link",
      action: "remove",
      status: "skipped",
      target: systemdUnitDirectory(paths),
      significance: "meaningful",
      detail:
        "removed systemd user units; stop any that are still active, then run systemctl --user daemon-reload"
    });
  }

  if (options.dryRun) return;

  const installed: InstalledLink[] = [];

  for (const link of desired) {
    const status = await linkStatus(link.path);

    if (status.state === "symlink" && status.resolved === link.target) installed.push(link);
  }

  await writeJsonAtomicOutcome(
    installedRecordPath(paths),
    { version: 1, links: [...kept, ...installed] },
    { category: "bookkeeping", significance: "internal", onComplete: options.onComplete }
  );
}

// Apply moves aside whatever a new link replaces as <path>.mindframe-z.bak-<time>; these are the
// backups beside every recorded link.
export async function installedLinkBackups(paths: RuntimePaths): Promise<string[]> {
  const backups: string[] = [];

  for (const link of await readInstalledLinks(paths)) {
    const prefix = `${path.basename(link.path)}.mindframe-z.bak-`;
    let names: string[];

    try {
      names = await readdir(path.dirname(link.path));
    } catch {
      continue;
    }

    for (const name of names) {
      if (name.startsWith(prefix)) backups.push(path.join(path.dirname(link.path), name));
    }
  }

  return [...new Set(backups)].sort();
}

export type InstalledLinkProblem = InstalledLink & {
  problem: "missing" | "changed" | "dangling";
};

// Doctor's view: a recorded link that is gone, points elsewhere, or points at nothing.
export async function installedLinkProblems(paths: RuntimePaths): Promise<InstalledLinkProblem[]> {
  const problems: InstalledLinkProblem[] = [];

  for (const link of await readInstalledLinks(paths)) {
    const status = await linkStatus(link.path);

    if (status.state === "missing") problems.push({ ...link, problem: "missing" });
    else if (status.state !== "symlink" || status.resolved !== link.target)
      problems.push({ ...link, problem: "changed" });
    else if (!(await exists(link.target))) problems.push({ ...link, problem: "dangling" });
  }

  return problems;
}

// The skill snapshot reports every skill link it keeps, so its outcomes are the desired skill links.
export async function skillLinksFromOutcomes(
  paths: RuntimePaths,
  outcomes: readonly OperationOutcome[]
): Promise<InstalledLink[]> {
  const links: InstalledLink[] = [];

  for (const outcome of outcomes) {
    if (outcome.category !== "link" || outcome.action !== "link") continue;

    // A dry run plans links it has not made; they are still wanted, so they are never removed.
    if (!["linked", "relinked", "unchanged", "planned"].includes(outcome.status)) continue;

    const owner = skillLinkOwner(paths, outcome.target);

    if (!owner) continue;
    const status = await linkStatus(outcome.target);

    // A link that is not in place yet records nothing; reconcile only records links it can verify.
    links.push({
      path: outcome.target,
      target: status.state === "symlink" ? status.resolved : "",
      owner
    });
  }

  return links;
}
