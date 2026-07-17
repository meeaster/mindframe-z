import { readFile } from "node:fs/promises";
import { extraFoldersIndexPath, referenceIndexPath, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";

/**
 * Builds an AGENTS.md whose reference and extra-folder indexes are inlined.
 *
 * Claude and OpenCode point at the indexes with `@import` directives, so their
 * renderers only need the paths. Codex and Pi cannot follow imports, so their
 * AGENTS.md has to carry the index contents verbatim.
 */
export async function renderInlinedAgents(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<string> {
  const parts: string[] = [];
  for (const file of profile.instructionFiles) parts.push(await readFile(file, "utf8"));
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
  return (
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
