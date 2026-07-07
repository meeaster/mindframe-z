import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { writeSkillOverridesFile } from "../core/skill-overrides.js";
import type { ResolvedProfile } from "../core/profile.js";
import { ensureActiveGitExcluded, type SkillConfigPaths } from "./skill-config-paths.js";
import type { SkillToggleState } from "./skill-toggle-state.js";

function codexSkillNameFromPath(
  skillPath: string,
  skillNames: ReadonlySet<string>
): string | undefined {
  const parent = path.basename(path.dirname(skillPath));
  return skillNames.has(parent) ? parent : undefined;
}

export async function readCodexSkillOverrides(
  file: string,
  profile: ResolvedProfile
): Promise<SkillToggleState> {
  return readCodexSkillOverridesForNames(
    file,
    new Set(profile.enabledSkills.map((skill) => skill.name))
  );
}

export async function readCodexSkillOverridesForNames(
  file: string,
  skillNames: ReadonlySet<string>
): Promise<SkillToggleState> {
  let doc: Record<string, unknown> = {};
  try {
    const parsed = parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  const skills = doc.skills;
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) return {};
  const entries = (skills as Record<string, unknown>).config;
  if (!Array.isArray(entries)) return {};

  const state: SkillToggleState = {};
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.enabled !== "boolean") continue;
    const name = codexSkillNameFromPath(record.path, skillNames);
    if (name) state[name] = record.enabled;
  }
  return state;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexSkillPath(
  configPaths: SkillConfigPaths,
  skillName: string
): Promise<string> {
  const candidates = [
    ...(configPaths.scope === "repo"
      ? [path.join(configPaths.repoRoot, ".agents", "skills", skillName, "SKILL.md")]
      : []),
    path.join(configPaths.home, ".agents", "skills", skillName, "SKILL.md")
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(
    `Cannot toggle ${skillName} for codex: installed SKILL.md path could not be resolved`
  );
}

export async function replaceCodexSkillOverrides(
  configPaths: SkillConfigPaths,
  state: SkillToggleState
): Promise<void> {
  let doc: Record<string, unknown> = {};
  try {
    const parsed = parse(await readFile(configPaths.active.codex, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing config starts from an empty TOML document.
  }

  const existingSkills =
    typeof doc.skills === "object" && doc.skills !== null && !Array.isArray(doc.skills)
      ? { ...(doc.skills as Record<string, unknown>) }
      : {};
  const existingConfig = Array.isArray(existingSkills.config) ? existingSkills.config : [];
  const managedPaths = new Set<string>();
  const nextConfig: unknown[] = [];
  for (const [name, enabled] of Object.entries(state)) {
    const skillPath = await resolveCodexSkillPath(configPaths, name);
    managedPaths.add(skillPath);
    nextConfig.push({ path: skillPath, enabled });
  }
  for (const entry of existingConfig) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      nextConfig.push(entry);
      continue;
    }
    const skillPath = (entry as Record<string, unknown>).path;
    if (typeof skillPath !== "string" || !managedPaths.has(skillPath)) nextConfig.push(entry);
  }
  doc.skills = { ...existingSkills, config: nextConfig };

  await mkdir(path.dirname(configPaths.active.codex), { recursive: true });
  await writeFile(configPaths.active.codex, stringify(doc), "utf8");
  if (configPaths.scope === "global") {
    await writeSkillOverridesFile(configPaths.state.codex, state);
  }
  await ensureActiveGitExcluded(configPaths, "codex");
}
