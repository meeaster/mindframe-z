import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ExtraFolder, ReferenceEntry } from "../core/manifests.js";
import {
  capabilitiesDir,
  capabilityGroupPath,
  capabilityIndexPath,
  expandHome,
  extraFoldersIndexPath,
  referenceIndexPath,
  type RuntimePaths
} from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { writeTextFile } from "../core/fs-util.js";
import { extraFoldersIndexContent, referenceIndexContent, referencePath } from "./references.js";

interface CapabilityMetadata {
  group: string;
  summary: string;
  signals: string[];
}

type CapabilityReference = ReferenceEntry & CapabilityMetadata;
type CapabilityFolder = ExtraFolder & CapabilityMetadata;

interface ActiveCapabilityGroup {
  name: string;
  title: string | undefined;
  summary: string;
  references: CapabilityReference[];
  folders: CapabilityFolder[];
}

function requireReferenceMetadata(entry: ReferenceEntry): CapabilityReference {
  if (!entry.group || !entry.summary || !entry.signals) {
    throw new Error(
      `Enabled reference ${entry.name} must declare group, summary, and at least one signal when capability_groups are configured`
    );
  }
  return { ...entry, group: entry.group, summary: entry.summary, signals: entry.signals };
}

function requireFolderMetadata(entry: ExtraFolder): CapabilityFolder {
  if (!entry.group || !entry.summary || !entry.signals) {
    throw new Error(
      `Extra folder ${entry.path} must declare group, summary, and at least one signal when capability_groups are configured`
    );
  }
  return { ...entry, group: entry.group, summary: entry.summary, signals: entry.signals };
}

export function activeCapabilityGroups(profile: ResolvedProfile): ActiveCapabilityGroup[] {
  if (profile.profile.capability_groups.length === 0) return [];
  const groups = new Map<string, ActiveCapabilityGroup>(
    profile.profile.capability_groups.map((group) => [
      group.name,
      {
        name: group.name,
        title: group.title,
        summary: group.summary,
        references: [],
        folders: []
      }
    ])
  );
  for (const reference of profile.enabledReferences) {
    const entry = requireReferenceMetadata(reference);
    const group = groups.get(entry.group);
    if (!group)
      throw new Error(`Enabled reference ${reference.name} uses unknown group ${entry.group}`);
    group.references.push(entry);
  }
  for (const folder of profile.extraFolders) {
    const entry = requireFolderMetadata(folder);
    const group = groups.get(entry.group);
    if (!group) throw new Error(`Extra folder ${folder.path} uses unknown group ${entry.group}`);
    group.folders.push(entry);
  }
  return [...groups.values()].filter(
    (group) => group.references.length > 0 || group.folders.length > 0
  );
}

function groupSignals(group: ActiveCapabilityGroup): string[] {
  return [...new Set([...group.references, ...group.folders].flatMap((entry) => entry.signals))];
}

function awarenessSignals(group: ActiveCapabilityGroup): string[] {
  return [...new Set([...group.references, ...group.folders].map((entry) => entry.signals[0]!))];
}

export function capabilityIndexContent(paths: RuntimePaths, profile: ResolvedProfile): string {
  if (profile.profile.capability_groups.length === 0) {
    return (
      [
        referenceIndexContent(profile).trimEnd(),
        ...(profile.extraFolders.length > 0
          ? [extraFoldersIndexContent(paths, profile).trimEnd()]
          : [])
      ].join("\n\n") + "\n"
    );
  }
  const lines = [
    "# Available Workspace Capabilities",
    "",
    `Full authoritative indexes: \`${referenceIndexPath(paths)}\` and \`${extraFoldersIndexPath(paths)}\`.`,
    ""
  ];
  for (const group of activeCapabilityGroups(profile)) {
    const entries = [...group.references, ...group.folders]
      .map((entry) => entry.summary)
      .join(", ");
    lines.push(
      `- **${group.title ?? title(group.name)}**: ${group.summary} Includes: ${entries}. Signals: ${awarenessSignals(group).join(", ")}. Details: \`${capabilityGroupPath(paths, group.name)}\`.`
    );
  }
  lines.push(
    "",
    "Read a group file when its summary or signals match the task. Consult the full indexes for cross-repository ownership, exact access grants, or entries outside the active groups.",
    ""
  );
  return lines.join("\n");
}

function groupContent(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  group: ActiveCapabilityGroup
): string {
  const lines = [
    `# ${group.title ?? title(group.name)}`,
    "",
    group.summary,
    "",
    `Signals: ${groupSignals(group).join(", ")}.`,
    ""
  ];
  if (group.references.length > 0) {
    lines.push("## References", "");
    for (const reference of group.references) {
      lines.push(
        `- \`${reference.name}\`: ${reference.summary}. Signals: ${reference.signals.join(", ")}. URL: \`${reference.url}\`. Path: \`${referencePath(profile, reference)}\`. ${reference.description}`
      );
    }
    lines.push("");
  }
  if (group.folders.length > 0) {
    lines.push("## Extra Folders", "");
    for (const folder of group.folders) {
      const url = folder.url ? ` URL: \`${folder.url}\`.` : "";
      lines.push(
        `- \`${expandHome(folder.path, paths.home)}\`: ${folder.summary}. Signals: ${folder.signals.join(", ")}. Permissions: read ${folder.read}, edit ${folder.edit}.${url} ${folder.description}`
      );
    }
    lines.push("");
  }
  lines.push(
    `Full authoritative indexes: \`${referenceIndexPath(paths)}\` and \`${extraFoldersIndexPath(paths)}\`.`,
    ""
  );
  return lines.join("\n");
}

function title(name: string): string {
  return name
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export async function writeCapabilityIndexes(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<string[]> {
  const directory = capabilitiesDir(paths);
  if (profile.profile.capability_groups.length === 0) {
    await rm(directory, { recursive: true, force: true });
    return [];
  }
  const groups = activeCapabilityGroups(profile);
  const files = [
    { path: capabilityIndexPath(paths), content: capabilityIndexContent(paths, profile) },
    ...groups.map((group) => ({
      path: capabilityGroupPath(paths, group.name),
      content: groupContent(paths, profile, group)
    }))
  ];
  await mkdir(directory, { recursive: true });
  const expected = new Set(files.map((file) => file.path));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const stalePath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md") && !expected.has(stalePath)) {
      await rm(stalePath);
    }
  }
  for (const file of files) await writeTextFile(file.path, file.content);
  return files.map((file) => file.path);
}
