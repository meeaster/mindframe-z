import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { AgentName, RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";

export type SkillToggleTarget = Extract<AgentName, "opencode" | "claude-code">;
export type SkillToggleState = Record<string, boolean>;

function opencodeConfigPath(paths: RuntimePaths): string {
  return path.join(paths.root, ".opencode", "opencode.jsonc");
}

function claudeSettingsPath(paths: RuntimePaths): string {
  return path.join(paths.root, ".claude", "settings.local.json");
}

async function readJsonFile(file: string, jsonc: boolean): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = jsonc ? parseJsonc(raw) : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} must contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeJsonFile(file: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function ensureGitExcluded(root: string, pattern: string): Promise<void> {
  const excludeFile = path.join(root, ".git", "info", "exclude");
  try {
    const content = await readFile(excludeFile, "utf8");
    if (content.split("\n").some((line) => line.trimEnd() === pattern)) return;
    await appendFile(excludeFile, `\n${pattern}\n`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

export async function readLocalSkillOverrides(
  paths: RuntimePaths,
  target: SkillToggleTarget
): Promise<Record<string, boolean>> {
  if (target === "opencode") {
    const config = await readJsonFile(opencodeConfigPath(paths), true);
    const permission =
      typeof config.permission === "object" &&
      config.permission !== null &&
      !Array.isArray(config.permission)
        ? (config.permission as Record<string, unknown>)
        : {};
    const skill = stringRecord(permission.skill);
    return Object.fromEntries(
      Object.entries(skill).map(([name, value]) => [name, value !== "deny"])
    );
  }

  const settings = await readJsonFile(claudeSettingsPath(paths), false);
  const overrides = stringRecord(settings.skillOverrides);
  return Object.fromEntries(
    Object.entries(overrides).map(([name, value]) => [name, value !== "off"])
  );
}

export async function writeLocalSkillOverrides(
  paths: RuntimePaths,
  target: SkillToggleTarget,
  state: SkillToggleState
): Promise<void> {
  if (target === "opencode") {
    const file = opencodeConfigPath(paths);
    const config = await readJsonFile(file, true);
    const permission =
      typeof config.permission === "object" &&
      config.permission !== null &&
      !Array.isArray(config.permission)
        ? (config.permission as Record<string, unknown>)
        : {};
    config.permission = {
      ...permission,
      skill: { ...stringRecord(permission.skill), ...skillPermissionEntries(state) }
    };
    await writeJsonFile(file, config);
    await ensureGitExcluded(paths.root, ".opencode/opencode.jsonc");
    return;
  }

  const file = claudeSettingsPath(paths);
  const settings = await readJsonFile(file, false);
  settings.skillOverrides = {
    ...stringRecord(settings.skillOverrides),
    ...Object.fromEntries(
      Object.entries(state).map(([name, enabled]) => [name, enabled ? "on" : "off"])
    )
  };
  await writeJsonFile(file, settings);
  await ensureGitExcluded(paths.root, ".claude/settings.local.json");
}

export async function setLocalSkillState(
  paths: RuntimePaths,
  target: SkillToggleTarget,
  skillName: string,
  enabled: boolean
): Promise<void> {
  const current = await readLocalSkillOverrides(paths, target);
  await writeLocalSkillOverrides(paths, target, { ...current, [skillName]: enabled });
}

export async function resolveSkillToggleState(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  const defaults = Object.fromEntries(
    profile.enabledSkills
      .filter((skill) => skill.targets.includes(target))
      .map((skill) => [skill.name, skill.enabled])
  );
  return { ...defaults, ...(await readLocalSkillOverrides(paths, target)) };
}

function skillPermissionEntries(state: SkillToggleState): Record<string, "allow" | "deny"> {
  return Object.fromEntries(
    Object.entries(state).map(([name, enabled]) => [name, enabled ? "allow" : "deny"])
  );
}
