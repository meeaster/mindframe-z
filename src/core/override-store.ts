import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "./fs-util.js";
import { writeJsonAtomicOutcome, type WriteFileOptions } from "./file-operations.js";
import type { OperationCompletion, OperationOutcome } from "./operations.js";
import { jsonValueSchema, type JsonObject } from "./json.js";
import { overrideStorePath, type AgentName, type RuntimePaths } from "./paths.js";
import type { CapabilityAgentName } from "./manifests.js";
import type { ResolvedProfile } from "./profile.js";

export type OverrideKind = "mcp" | "skills";
export type OverrideTarget = AgentName;

interface BooleanOverrides {
  [name: string]: boolean;
}

const booleanMapSchema = z.record(z.string(), z.boolean()).default({});
const payloadSchema = z
  .object({
    argv: z.array(z.string()).optional(),
    config: z.record(z.string(), jsonValueSchema).optional(),
    settings: z.record(z.string(), jsonValueSchema).optional()
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
    config?: JsonObject;
    settings?: JsonObject;
  };
}

export interface OverrideStore {
  projects: Record<string, Partial<Record<OverrideTarget, ProjectHarnessOverrides>>>;
}

export async function readOverrideStore(home: string): Promise<OverrideStore> {
  const file = overrideStorePath(home);
  try {
    return overrideStoreSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    // SAFETY: Node filesystem errors expose the standard errno code property.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { projects: {} };
    }
    throw new Error(
      `Failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function writeOverrideStore(home: string, store: OverrideStore): Promise<void> {
  await writeJsonFileAtomic(overrideStorePath(home), store);
}

export function projectOverrides(
  store: OverrideStore,
  projectRoot: string,
  target: OverrideTarget,
  kind: OverrideKind
): BooleanOverrides {
  return { ...store.projects[projectRoot]?.[target]?.[kind] };
}

export async function writeProjectOverrideDelta(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  projectRoot: string,
  target: OverrideTarget,
  kind: OverrideKind,
  next: Record<string, boolean>,
  baseDefaults?: Record<string, boolean>
): Promise<void> {
  if (target === "opencode-v2") {
    throw new Error("OpenCode V2 project overrides are not supported");
  }
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
  profile: ResolvedProfile,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const store = await readOverrideStore(paths.home);
  for (const projectRoot of Object.keys(store.projects)) {
    await renderProjectPayloads(paths, profile, store, projectRoot);
    pruneProject(store, projectRoot);
  }
  const options: WriteFileOptions = {
    category: "bookkeeping",
    significance: "internal"
  };
  if (onComplete) options.onComplete = onComplete;
  return writeJsonAtomicOutcome(overrideStorePath(paths.home), store, options);
}

export function effectiveProjectState(
  store: OverrideStore,
  projectRoot: string | undefined,
  profile: ResolvedProfile,
  target: OverrideTarget,
  kind: OverrideKind
): BooleanOverrides {
  const defaults = kind === "mcp" ? mcpDefaults(profile, target) : skillDefaults(profile, target);
  if (!projectRoot) return defaults;
  return { ...defaults, ...projectOverrides(store, projectRoot, target, kind) };
}

export function mcpDefaults(profile: ResolvedProfile, target: AgentName): Record<string, boolean> {
  const capabilityTarget: CapabilityAgentName | undefined =
    target === "opencode-v2" ? "opencode" : target === "pi" ? undefined : target;
  return Object.fromEntries(
    (profile.mcpServers ?? []).flatMap((server) =>
      capabilityTarget === undefined ||
      server.agents === undefined ||
      server.agents[capabilityTarget] === undefined
        ? []
        : [[server.name, server.agents[capabilityTarget]]]
    )
  );
}

export function skillDefaults(
  profile: ResolvedProfile,
  target: AgentName
): Record<string, boolean> {
  const capabilityTarget: CapabilityAgentName | undefined =
    target === "opencode-v2" ? "opencode" : target === "pi" ? undefined : target;
  return Object.fromEntries(
    (profile.enabledSkills ?? []).flatMap((skill) =>
      capabilityTarget === undefined || skill.agents[capabilityTarget] === undefined
        ? []
        : [[skill.name, skill.agents[capabilityTarget]]]
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
  for (const target of ["claude-code", "codex"] as const) {
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

function pruneDefaults(overrides: BooleanOverrides, defaults: BooleanOverrides): BooleanOverrides {
  const pruned: BooleanOverrides = {};
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
  for (const target of ["claude-code", "codex"] as const) {
    if (!project[target]) delete project[target];
  }
  if (Object.keys(project).length === 0) delete store.projects[projectRoot];
}
