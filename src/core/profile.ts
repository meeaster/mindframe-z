import path from "node:path";
import { dedupe, expandHome, type AgentName, type RuntimePaths } from "./paths.js";
import {
  loadManifests,
  type LoadedManifests,
  type McpServer,
  type ProfileManifest,
  type ToolTargetName,
  type ReferenceEntry,
  type SkillEntry,
  type ExtraFolder
} from "./manifests.js";

export interface ResolvedMcpServer {
  name: string;
  server: McpServer;
  targets: ToolTargetName[];
  enabled: boolean;
}

export type ResolvedSkill = SkillEntry & {
  enabled: boolean;
  toggleable: boolean;
  targets: ToolTargetName[];
};

export interface ResolvedProfile {
  name: string;
  agents: AgentName[];
  profile: ProfileManifest;
  manifests: LoadedManifests;
  instructionFiles: string[];
  referencesDir: string;
  enabledReferences: ReferenceEntry[];
  enabledSkills: ResolvedSkill[];
  enabledCommands: string[];
  enabledAgents: string[];
  mcpServers: ResolvedMcpServer[];
  extraFolders: ExtraFolder[];
}

export function deepMerge(
  base: Record<string, unknown>,
  child: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(child)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function mergeProfiles(base: ProfileManifest, child: ProfileManifest): ProfileManifest {
  const dotfiles: Record<string, string> = { ...base.dotfiles };
  for (const [key, value] of Object.entries(child.dotfiles)) {
    dotfiles[key] = key in dotfiles ? dotfiles[key] + "\n" + value : value;
  }

  return {
    name: child.name,
    extends: child.extends ?? base.extends,
    description: child.description || base.description,
    agents: child.agents.length > 0 ? child.agents : base.agents,
    instructions: dedupe([...base.instructions, ...child.instructions]),
    references: dedupe([...base.references, ...child.references]),
    extra_folders: (() => {
      const map = new Map<string, ExtraFolder>();
      for (const f of base.extra_folders) map.set(f.path, f);
      for (const f of child.extra_folders) map.set(f.path, f);
      return [...map.values()];
    })(),
    skills: deepMerge(base.skills, child.skills) as ProfileManifest["skills"],
    mcp: deepMerge(base.mcp, child.mcp) as ProfileManifest["mcp"],
    opencode: {
      config: deepMerge(base.opencode.config, child.opencode.config),
      plugins: dedupe([...base.opencode.plugins, ...child.opencode.plugins]),
      commands: dedupe([...base.opencode.commands, ...child.opencode.commands]),
      agents: dedupe([...base.opencode.agents, ...child.opencode.agents]),
      agent_task: child.opencode.agent_task ?? base.opencode.agent_task
    },
    claude: deepMerge(base.claude, child.claude) as ProfileManifest["claude"],
    mise: {
      tools: deepMerge(
        base.mise.tools as Record<string, unknown>,
        child.mise.tools as Record<string, unknown>
      ) as ProfileManifest["mise"]["tools"],
      env: { ...base.mise.env, ...child.mise.env },
      tool_alias: { ...base.mise.tool_alias, ...child.mise.tool_alias },
      settings: { ...base.mise.settings, ...child.mise.settings }
    },
    dotfiles
  };
}

function resolveSkillConfig(
  config: ProfileManifest["skills"][string],
  agents: AgentName[]
): { enabled: boolean; toggleable: boolean; targets: ToolTargetName[] } {
  if (!config) return { enabled: true, toggleable: true, targets: agents };
  const targets = Array.isArray(config) ? config : (config.targets ?? agents);
  return {
    enabled: Array.isArray(config) ? true : config.enabled,
    toggleable: Array.isArray(config) ? true : config.toggleable,
    targets: targets.includes("all")
      ? agents
      : targets.filter((target): target is ToolTargetName => target !== "all")
  };
}

async function resolveProfileByName(
  manifests: LoadedManifests,
  name: string
): Promise<ProfileManifest> {
  const profile = manifests.profiles.get(name);
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  if (!profile.extends) return profile;
  const parent = await resolveProfileByName(manifests, profile.extends);
  return mergeProfiles(parent, profile);
}

export async function resolveProfile(
  paths: RuntimePaths,
  requestedProfile?: string
): Promise<ResolvedProfile> {
  const manifests = await loadManifests(paths.root, paths.home);
  const name =
    requestedProfile ?? process.env.MFZ_PROFILE ?? manifests.machine.profile ?? "personal";
  const profile = await resolveProfileByName(manifests, name);
  const agents = profile.agents;

  const instructionFiles = profile.instructions.map((file) => path.resolve(paths.root, file));
  const referenceNames = dedupe(profile.references);
  const enabledReferences = referenceNames.map((refName) => {
    const ref = manifests.references.find((entry) => entry.name === refName);
    if (!ref) throw new Error(`Profile ${name} references unknown reference: ${refName}`);
    return ref;
  });
  const enabledSkills = Object.entries(profile.skills)
    .map(([skillName, config]) => {
      const skill = manifests.skills.find((s) => s.name === skillName);
      if (!skill) throw new Error(`Profile ${name} references unknown skill: ${skillName}`);
      return { ...skill, ...resolveSkillConfig(config, agents) };
    })
    .filter((entry) => entry.targets.length > 0);
  const enabledCommands = dedupe(profile.opencode.commands);
  const enabledAgents = dedupe(profile.opencode.agents);
  const mcpServers = Object.entries(profile.mcp).map(([serverName, { enabled, targets }]) => {
    const server = manifests.mcpServers[serverName];
    if (!server) throw new Error(`Profile ${name} references unknown MCP server: ${serverName}`);
    return { name: serverName, server, targets: targets ?? agents, enabled };
  });

  const extraFolders: ExtraFolder[] = (() => {
    const map = new Map<string, ExtraFolder>();
    for (const f of profile.extra_folders) map.set(f.path, f);
    for (const f of manifests.machine.extra_folders) map.set(f.path, f);
    return [...map.values()];
  })();

  return {
    name,
    agents,
    profile,
    manifests,
    instructionFiles,
    referencesDir: path.resolve(
      expandHome(process.env.MFZ_REFERENCES_DIR ?? manifests.machine.references_dir, paths.home)
    ),
    enabledReferences,
    enabledSkills,
    enabledCommands,
    enabledAgents,
    mcpServers,
    extraFolders
  };
}

export function filterMcpForTarget(
  profile: ResolvedProfile,
  target: "opencode" | "claude-code"
): ResolvedMcpServer[] {
  return profile.mcpServers.filter((entry) => entry.targets.includes(target));
}
