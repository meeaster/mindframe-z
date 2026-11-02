import path from "node:path";
import type { ExtraFolder, MachineManifest, RepoEntry } from "./manifests.js";
import { expandHome } from "./path-util.js";

export interface ResolvedRepo {
  name: string;
  /** Absolute checkout path inside the workspace. */
  path: string;
  /** Clone URL in the machine's protocol for GitHub repositories, otherwise the catalog URL. */
  cloneUrl: string;
  entry: RepoEntry;
}

export function workspaceRootPath(machine: MachineManifest, home: string): string {
  return path.resolve(expandHome(machine.workspace_root, home));
}

export function resolveRepo(
  entry: RepoEntry,
  machine: MachineManifest,
  home: string
): ResolvedRepo {
  const cloneUrl =
    entry.github === undefined
      ? // SAFETY: the catalog schema requires exactly one of github and url.
        entry.url!
      : (machine.git.protocol ?? "https") === "ssh"
        ? `git@github.com:${entry.github}.git`
        : `https://github.com/${entry.github}.git`;

  return {
    name: entry.name,
    path: path.join(workspaceRootPath(machine, home), entry.path ?? path.join("repos", entry.name)),
    cloneUrl,
    entry
  };
}

// Selecting a repository grants agents its checkout, described like any other extra folder.
export function repoExtraFolder(repo: ResolvedRepo): ExtraFolder {
  const folder: ExtraFolder = {
    path: repo.path,
    description: repo.entry.description,
    url: repo.entry.github ? `https://github.com/${repo.entry.github}` : repo.cloneUrl,
    read: "allow",
    edit: "allow"
  };

  if (repo.entry.group !== undefined) folder.group = repo.entry.group;

  if (repo.entry.summary !== undefined) folder.summary = repo.entry.summary;

  if (repo.entry.signals !== undefined) folder.signals = repo.entry.signals;

  return folder;
}
