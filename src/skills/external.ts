import type { CapabilityAgentName, SkillEntry } from "../core/manifests.js";
import type { ResolvedExternalSkill, ResolvedProfile } from "../core/profile.js";
import type { GlobalSkillTarget, OtherGlobalSkill } from "./global-inventory.js";

/** The part of a resolved profile external skills depend on. */
export type ExternalSkillProfile = Pick<ResolvedProfile, "externalSkills"> & {
  manifests: { skills: readonly SkillEntry[] };
};

// The global folders in which each agent finds a skill a tool installed.
const visibleIn: Record<CapabilityAgentName, readonly GlobalSkillTarget[]> = {
  opencode: ["agents", "opencode"],
  codex: ["agents"],
  "claude-code": ["claude-code"]
};

function patternMatches(pattern: string, name: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.]/gu, "\\."))
    .join(".*");

  return new RegExp(`^${expression}$`, "u").test(name);
}

/** Whether an external entry claims a skill folder: by profile selection or catalog pattern. */
export function ownsSkill(skill: ResolvedExternalSkill, name: string): boolean {
  return (
    (skill.select?.includes(name) ?? false) ||
    (skill.owns?.some((pattern) => patternMatches(pattern, name)) ?? false)
  );
}

/** The enabled external entry that claims a skill folder, if any. */
export function externalOwner(
  profile: Pick<ResolvedProfile, "externalSkills">,
  name: string
): ResolvedExternalSkill | undefined {
  return profile.externalSkills.find((skill) => ownsSkill(skill, name));
}

export interface ExternalSkillSelection {
  skills: string[];
  agents: CapabilityAgentName[];
}

/**
 * What the profile wants a tool to install. An entry the catalog declares but the profile does
 * not enable selects nothing, so a sync task removes what it installed earlier.
 */
export function externalSkillSelection(
  profile: ExternalSkillProfile,
  name: string
): ExternalSkillSelection {
  const skill = profile.externalSkills.find((entry) => entry.name === name);

  if (skill !== undefined) return { skills: [...(skill.select ?? [])], agents: [...skill.targets] };

  const declared = profile.manifests.skills.find((entry) => entry.name === name);

  if (declared?.source !== "external") {
    throw new Error(`Not an external skill in the catalog: ${name}`);
  }

  return { skills: [], agents: [] };
}

/** `doctor` lines for each enabled external entry, given the skills found outside MFZ links. */
export async function externalSkillDiagnostics(
  profile: Pick<ResolvedProfile, "externalSkills">,
  installed: readonly OtherGlobalSkill[],
  toolVersion: (tool: string) => Promise<string | undefined>
): Promise<string[]> {
  const lines: string[] = [];

  for (const skill of profile.externalSkills) {
    const version = await toolVersion(skill.tool);

    if (version === undefined) {
      lines.push(`external-skill:missing\t${skill.name}\t${skill.tool} is not installed`);
      continue;
    }

    const owned = installed.filter((entry) => ownsSkill(skill, entry.name));
    const missing: string[] = [];

    for (const name of skill.select ?? []) {
      const found = owned.find((entry) => entry.name === name);

      const absent = skill.targets.filter(
        (target) => !visibleIn[target].some((folder) => found?.targets.includes(folder))
      );

      if (absent.length > 0) missing.push(`${name} (${absent.join(", ")})`);
    }

    if (missing.length > 0) {
      lines.push(`external-skill:missing\t${skill.name}\t${missing.join(", ")}\trun ${skill.sync}`);
    } else if (owned.length === 0) {
      lines.push(`external-skill:missing\t${skill.name}\tno skills installed\trun ${skill.sync}`);
    } else {
      const names = owned.map((entry) => entry.name).join(", ");

      lines.push(`external-skill:ok\t${skill.name}\t${skill.tool}@${version}\t${names}`);
    }
  }

  return lines;
}
