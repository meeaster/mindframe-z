import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { LoadedManifests, SkillEntry } from "../core/manifests.js";
import type { AgentName } from "../core/paths.js";

const skillLockEntrySchema = z.object({
  sourceType: z.string(),
  sourceUrl: z.string().optional()
});

const skillLockSchema = z.object({
  skills: z.record(z.string(), skillLockEntrySchema).default({})
});

export interface UnknownSkill {
  name: string;
  entry: SkillEntry;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function descriptionFromSkillMd(raw: string): string {
  if (!raw.startsWith("---\n")) return "";
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return "";
  const frontmatter = YAML.parse(raw.slice(4, end));
  if (frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)) {
    const description = (frontmatter as Record<string, unknown>).description;
    return typeof description === "string" ? description : "";
  }
  return "";
}

async function readSkillDescription(home: string, name: string): Promise<string> {
  try {
    const raw = await readFile(path.join(home, ".agents", "skills", name, "SKILL.md"), "utf8");
    return descriptionFromSkillMd(raw);
  } catch {
    return "";
  }
}

export async function syncSkills(
  home: string,
  manifests: LoadedManifests,
  agents: AgentName[]
): Promise<UnknownSkill[]> {
  if (!agents.includes("opencode")) return [];

  let lock: z.infer<typeof skillLockSchema>;
  try {
    lock = skillLockSchema.parse(
      JSON.parse(await readFile(path.join(home, ".agents", ".skill-lock.json"), "utf8"))
    );
  } catch {
    return [];
  }

  const catalogNames = new Set(manifests.skills.map((skill) => skill.name));
  const unknown: UnknownSkill[] = [];

  for (const [name, skill] of Object.entries(lock.skills)) {
    if (skill.sourceType !== "github" || !skill.sourceUrl || catalogNames.has(name)) continue;
    unknown.push({
      name,
      entry: {
        name,
        source: "git",
        repo: stripGitSuffix(skill.sourceUrl),
        skill: name,
        description: await readSkillDescription(home, name),
        installer: "npx-skills"
      }
    });
  }

  return unknown;
}
