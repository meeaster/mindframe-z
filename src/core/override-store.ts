import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { overrideStorePath, type AgentName, type RuntimePaths } from "./paths.js";
import type { ResolvedProfile } from "./profile.js";

export type OverrideKind = "mcp" | "skills";

const booleanMapSchema = z.record(z.string(), z.boolean()).default({});
const payloadSchema = z
  .object({
    argv: z.array(z.string()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional()
  })
  .default({});
const projectHarnessSchema = z
  .object({
    mcp: booleanMapSchema.optional(),
    skills: booleanMapSchema.optional(),
    payload: payloadSchema.optional()
  })
  .default({});
const projectSchema = z.record(z.string(), projectHarnessSchema);
const overrideStoreSchema = z.object({ projects: z.record(z.string(), projectSchema).default({}) });

export interface ProjectHarnessOverrides {
  mcp?: Record<string, boolean>;
  skills?: Record<string, boolean>;
  payload?: {
    argv?: string[];
    config?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  };
}

export interface OverrideStore {
  projects: Record<string, Partial<Record<AgentName, ProjectHarnessOverrides>>>;
}

export async function findProjectRoot(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd });
    const root = stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

export async function readOverrideStore(home: string): Promise<OverrideStore> {
  const file = overrideStorePath(home);
  try {
    return overrideStoreSchema.parse(JSON.parse(await readFile(file, "utf8"))) as OverrideStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    throw new Error(
      `Failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function writeOverrideStore(home: string, store: OverrideStore): Promise<void> {
  const file = overrideStorePath(home);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export function projectOverrides(
  store: OverrideStore,
  projectRoot: string,
  target: AgentName,
  kind: OverrideKind
): Record<string, boolean> {
  return { ...store.projects[projectRoot]?.[target]?.[kind] };
}

export async function writeProjectOverrideDelta(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  projectRoot: string,
  target: AgentName,
  kind: OverrideKind,
  next: Record<string, boolean>,
  baseDefaults?: Record<string, boolean>
): Promise<void> {
  const store = await readOverrideStore(paths.home);
  const project = { ...store.projects[projectRoot] };
  const current = { ...project[target]?.[kind] };
  const defaults =
    baseDefaults ??
    (kind === "mcp" ? mcpDefaults(profile, target) : skillDefaults(profile, target));

  for (const [name, enabled] of Object.entries(next)) {
    if (defaults[name] === undefined) {
      throw new Error(
        `${kind === "mcp" ? "MCP server" : "Skill"} ${name} is not available for ${target}`
      );
    }
    if (defaults[name] === enabled) delete current[name];
    else current[name] = enabled;
  }

  const nextHarness = pruneHarness({ ...project[target], [kind]: current });
  if (nextHarness) project[target] = nextHarness;
  else delete project[target];
  store.projects[projectRoot] = project;
  await renderProjectPayloads(paths, profile, store, projectRoot);
  pruneProject(store, projectRoot);
  await writeOverrideStore(paths.home, store);
}

export async function renderAllPayloads(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<void> {
  const store = await readOverrideStore(paths.home);
  for (const projectRoot of Object.keys(store.projects)) {
    await renderProjectPayloads(paths, profile, store, projectRoot);
    pruneProject(store, projectRoot);
  }
  await writeOverrideStore(paths.home, store);
}

export function effectiveProjectState(
  store: OverrideStore,
  projectRoot: string | undefined,
  profile: ResolvedProfile,
  target: AgentName,
  kind: OverrideKind
): Record<string, boolean> {
  const defaults = kind === "mcp" ? mcpDefaults(profile, target) : skillDefaults(profile, target);
  if (!projectRoot) return defaults;
  return { ...defaults, ...projectOverrides(store, projectRoot, target, kind) };
}

export function mcpDefaults(profile: ResolvedProfile, target: AgentName): Record<string, boolean> {
  return Object.fromEntries(
    (profile.mcpServers ?? []).flatMap((server) =>
      server.route === "executor" || server.agents[target] === undefined
        ? []
        : [[server.name, server.agents[target]]]
    )
  );
}

export function skillDefaults(
  profile: ResolvedProfile,
  target: AgentName
): Record<string, boolean> {
  return Object.fromEntries(
    (profile.enabledSkills ?? []).flatMap((skill) =>
      skill.agents[target] === undefined ? [] : [[skill.name, skill.agents[target]]]
    )
  );
}

async function renderProjectPayloads(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  store: OverrideStore,
  projectRoot: string
): Promise<void> {
  const project = store.projects[projectRoot];
  if (!project) return;
  for (const target of ["opencode", "claude-code", "codex"] as const) {
    const section = project[target];
    if (!section) continue;
    const mcp = pruneDefaults(section.mcp ?? {}, mcpDefaults(profile, target));
    const skills = pruneDefaults(section.skills ?? {}, skillDefaults(profile, target));
    const payload = await renderPayload(paths, profile, target, mcp, skills);
    const nextSection: ProjectHarnessOverrides = { ...section, mcp, skills };
    if (payload) nextSection.payload = payload;
    else delete nextSection.payload;
    const pruned = pruneHarness(nextSection);
    if (pruned) project[target] = pruned;
    else delete project[target];
  }
}

function pruneDefaults(
  overrides: Record<string, boolean>,
  defaults: Record<string, boolean>
): Record<string, boolean> {
  const pruned: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(overrides)) {
    if (defaults[name] !== enabled) pruned[name] = enabled;
  }
  return pruned;
}

async function renderPayload(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: AgentName,
  mcp: Record<string, boolean>,
  skills: Record<string, boolean>
): Promise<ProjectHarnessOverrides["payload"]> {
  if (target === "opencode") {
    return {
      config: {
        ...(Object.keys(mcp).length > 0
          ? {
              mcp: Object.fromEntries(
                Object.entries(mcp).map(([name, enabled]) => [name, { enabled }])
              )
            }
          : {}),
        ...(Object.keys(skills).length > 0
          ? {
              permission: {
                skill: Object.fromEntries(
                  Object.entries(skills).map(([name, enabled]) => [
                    name,
                    enabled ? "allow" : "deny"
                  ])
                )
              }
            }
          : {})
      }
    };
  }

  if (target === "claude-code") {
    return Object.keys(skills).length > 0
      ? {
          settings: {
            skillOverrides: Object.fromEntries(
              Object.entries(skills).map(([name, enabled]) => [name, enabled ? "on" : "off"])
            )
          }
        }
      : {};
  }

  if (target === "pi") return {};

  const argv = Object.entries(mcp).flatMap(([name, enabled]) => [
    "-c",
    `mcp_servers.${name}.enabled=${enabled}`
  ]);
  if (Object.keys(skills).length > 0) {
    argv.push(
      "-c",
      `skills.config=${JSON.stringify(await codexSkillsConfig(paths, profile, skills))}`
    );
  }
  return argv.length > 0 ? { argv } : {};
}

async function codexSkillsConfig(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  overrides: Record<string, boolean>
): Promise<Array<{ path: string; enabled: boolean }>> {
  const state = { ...skillDefaults(profile, "codex"), ...overrides };
  const entries = await Promise.all(
    Object.entries(state).map(async ([name, enabled]) => ({
      path: await resolveCodexSkillPath(paths, name),
      enabled
    }))
  );
  return entries;
}

async function resolveCodexSkillPath(paths: RuntimePaths, skillName: string): Promise<string> {
  return path.join(paths.home, ".agents", "skills", skillName, "SKILL.md");
}

function pruneHarness(section: ProjectHarnessOverrides): ProjectHarnessOverrides | undefined {
  if (section.mcp && Object.keys(section.mcp).length === 0) delete section.mcp;
  if (section.skills && Object.keys(section.skills).length === 0) delete section.skills;
  if (section.payload?.config && Object.keys(section.payload.config).length === 0)
    delete section.payload.config;
  if (section.payload?.settings && Object.keys(section.payload.settings).length === 0)
    delete section.payload.settings;
  if (section.payload?.argv && section.payload.argv.length === 0) delete section.payload.argv;
  if (section.payload && Object.keys(section.payload).length === 0) delete section.payload;
  return section.mcp || section.skills || section.payload ? section : undefined;
}

function pruneProject(store: OverrideStore, projectRoot: string): void {
  const project = store.projects[projectRoot];
  if (!project) return;
  for (const target of ["opencode", "claude-code", "codex"] as const) {
    if (!project[target]) delete project[target];
  }
  if (Object.keys(project).length === 0) delete store.projects[projectRoot];
}
