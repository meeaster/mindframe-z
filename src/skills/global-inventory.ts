import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, readDirEntries } from "../core/fs-util.js";
import { jsonObjectSchema, jsonString } from "../core/json.js";
import type { RuntimePaths } from "../core/paths.js";
import { isManagedTarget, linkStatus } from "./link-state.js";

export type GlobalSkillTarget = "agents" | "claude-code" | "opencode";

export interface OtherGlobalSkill {
  name: string;
  targets: GlobalSkillTarget[];
  description?: string;
}

interface GlobalSkillStore {
  target: GlobalSkillTarget;
  directory: string;
}

function globalSkillStores(paths: RuntimePaths): readonly GlobalSkillStore[] {
  return [
    { target: "agents", directory: path.join(paths.home, ".agents", "skills") },
    { target: "claude-code", directory: path.join(paths.claudeDir, "skills") },
    { target: "opencode", directory: path.join(paths.opencodeConfigDir, "skills") }
  ];
}

function errorCode(error: Error): string | undefined {
  // SAFETY: Node filesystem failures expose their stable errno code on Error objects.
  return (error as NodeJS.ErrnoException).code;
}

async function readGlobalSkillDescription(skillPath: string): Promise<string | undefined> {
  let content: string;

  try {
    content = await readFile(path.join(skillPath, "SKILL.md"), "utf8");
  } catch (error) {
    if (error instanceof Error && ["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) {
      return undefined;
    }

    throw error;
  }

  try {
    const metadata = jsonObjectSchema.safeParse(parseFrontmatter(content));
    const description = jsonString(metadata.success ? metadata.data.description : undefined);

    return description?.trim() ? description : undefined;
  } catch {
    return undefined;
  }
}

export async function readOtherGlobalSkills(
  paths: RuntimePaths,
  options: { verbose?: boolean } = {}
): Promise<OtherGlobalSkill[]> {
  const skills = new Map<string, OtherGlobalSkill>();

  for (const store of globalSkillStores(paths)) {
    for (const entry of await readDirEntries(store.directory)) {
      if (entry.name.startsWith(".")) continue;

      const entryPath = path.join(store.directory, entry.name);
      const status = await linkStatus(entryPath);

      if (status.state === "missing" || status.state === "file") continue;

      if (status.state === "symlink" && isManagedTarget(paths.configsDir, status.resolved)) {
        continue;
      }

      const skill = skills.get(entry.name) ?? { name: entry.name, targets: [] };

      if (!skill.targets.includes(store.target)) skill.targets.push(store.target);

      if (options.verbose && skill.description === undefined) {
        const description = await readGlobalSkillDescription(entryPath);

        if (description !== undefined) skill.description = description;
      }

      skills.set(entry.name, skill);
    }
  }

  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
