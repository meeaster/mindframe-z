import { readFile } from "node:fs/promises";
import { extraFoldersIndexPath, referenceIndexPath, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { instructionReferencesSection } from "../core/instruction-references.js";
import { capabilityIndexContent } from "../ref-store/capabilities.js";

/**
 * Builds an AGENTS.md with the compact workspace capability index inlined.
 */
export async function renderInlinedAgents(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<string> {
  const parts: string[] = [];

  for (const file of profile.instructionFiles) parts.push(await readFile(file, "utf8"));

  if (profile.profile.capability_groups.length > 0) {
    parts.push(capabilityIndexContent(paths, profile));
  } else {
    for (const file of [
      referenceIndexPath(paths),
      ...(profile.extraFolders.length > 0 ? [extraFoldersIndexPath(paths)] : [])
    ]) {
      try {
        parts.push(await readFile(file, "utf8"));
      } catch {
        // Dry-run renders may happen before local indexes are written.
      }
    }
  }

  const referenceSection = instructionReferencesSection(paths, profile);

  if (referenceSection) parts.push(referenceSection);

  return (
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
