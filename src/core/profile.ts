import path from "node:path";
import { dedupe, expandHome, type AgentName, type RuntimePaths } from "./paths.js";
import {
  loadManifests,
  type LoadedManifests,
  type McpServer,
  type ProfileAgentDefaults,
  type ProfileManifest,
  type ToolTargetName,
  type ReferenceEntry,
  type SkillEntry,
  type ExtraFolder
} from "./manifests.js";

export interface ResolvedMcpServer {
  name: string;
  server: McpServer;
  agents: ProfileAgentDefaults;
}

export type ResolvedSkill = SkillEntry & {
  agents: ProfileAgentDefaults;
  toggleable: boolean;
  targets: ToolTargetName[];
};

export type TargetedMcpServer = ResolvedMcpServer & { enabled: boolean };

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

export function mergeProfiles(base: ProfileManifest, child: ProfileManifest): ProfileManifest {
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
    codex: {
      config: deepMerge(base.codex.config, child.codex.config),
      plugins: deepMerge(
        base.codex.plugins,
        child.codex.plugins
      ) as ProfileManifest["codex"]["plugins"]
    },
    mise: {
      tools: deepMerge(
        base.mise.tools as Record<string, unknown>,
        child.mise.tools as Record<string, unknown>
      ) as ProfileManifest["mise"]["tools"],
      env: { ...base.mise.env, ...child.mise.env },
      tool_alias: { ...base.mise.tool_alias, ...child.mise.tool_alias },
      settings: { ...base.mise.settings, ...child.mise.settings }
    },
    thread: {
      destinations: (() => {
        const map = new Map<string, ProfileManifest["thread"]["destinations"][number]>();
        for (const destination of base.thread.destinations) map.set(destination.name, destination);
        for (const destination of child.thread.destinations) map.set(destination.name, destination);
        return [...map.values()];
      })(),
      defaults: { ...base.thread.defaults, ...child.thread.defaults },
      update_strategy: child.thread.update_strategy ?? base.thread.update_strategy,
      credentials: child.thread.credentials ?? base.thread.credentials
    },
    dotfiles
  };
}

function resolveSkillConfig(
  config: ProfileManifest["skills"][string],
  agents: AgentName[]
): { agents: ProfileAgentDefaults; toggleable: boolean; targets: ToolTargetName[] } {
  if (!config?.agents) {
    throw new Error("Skill entries must declare agents after profile inheritance is resolved");
  }
  const targets = Object.keys(config.agents).filter((target): target is ToolTargetName =>
    agents.includes(target as AgentName)
  );
  return {
    agents: config.agents,
    toggleable: config.toggleable,
    targets
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
  const mcpServers = Object.entries(profile.mcp).map(([serverName, { agents: mcpAgents }]) => {
    const server = manifests.mcpServers[serverName];
    if (!server) throw new Error(`Profile ${name} references unknown MCP server: ${serverName}`);
    return { name: serverName, server, agents: mcpAgents };
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
  target: ToolTargetName
): TargetedMcpServer[] {
  return profile.mcpServers.flatMap((entry) =>
    entry.agents[target] === undefined ? [] : [{ ...entry, enabled: entry.agents[target] }]
  );
}
