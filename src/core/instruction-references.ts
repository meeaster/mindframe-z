import { readFile } from "node:fs/promises";
import path from "node:path";
import { profileConfigsDir, type RuntimePaths } from "./paths.js";
import type { ResolvedProfile } from "./profile.js";

export function instructionReferencesDir(paths: RuntimePaths, profile: ResolvedProfile): string {
  return path.join(profileConfigsDir(paths, profile.name), "instruction-references");
}

function targetPath(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  reference: ResolvedProfile["instructionReferences"][number]
): string {
  return path.join(instructionReferencesDir(paths, profile), `${reference.name}.md`);
}

export function instructionReferencesSection(
  paths: RuntimePaths,
  profile: ResolvedProfile
): string | undefined {
  if (profile.instructionReferences.length === 0) return undefined;
  return [
    "## On-Demand Instructions",
    "",
    ...profile.instructionReferences.map(
      (reference) =>
        `- ${reference.description}: read \`${targetPath(paths, profile, reference)}\`.`
    )
  ].join("\n");
}

export async function renderInstructionReferences(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<Array<{ path: string; content: string }>> {
  return Promise.all(
    profile.instructionReferences.map(async (reference) => ({
      path: targetPath(paths, profile, reference),
      content: await readFile(reference.sourcePath, "utf8")
    }))
  );
}
