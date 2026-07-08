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

type CatalogKind = "reference" | "skill" | "mcp" | "profile";

interface ProfileSources {
  references: Map<string, LoadedManifests>;
  skills: Map<string, LoadedManifests>;
  mcp: Map<string, LoadedManifests>;
  instructions: Map<string, LoadedManifests>;
  plugins: Map<string, LoadedManifests>;
  commands: Map<string, LoadedManifests>;
  agents: Map<string, LoadedManifests>;
}

interface ProfileBuild {
  profile: ProfileManifest;
  sources: ProfileSources;
}

export interface ResolvedMcpServer {
  name: string;
  server: McpServer;
  agents: ProfileAgentDefaults;
}

export type ResolvedSkill = SkillEntry & {
  agents: ProfileAgentDefaults;
  toggleable: boolean;
  targets: ToolTargetName[];
  sourceRoot: string;
};

export type TargetedMcpServer = ResolvedMcpServer & { enabled: boolean };

export interface ResolvedProfile {
  name: string;
  agents: AgentName[];
  profile: ProfileManifest;
  manifests: LoadedManifests;
  sources: ProfileSources;
  instructionFiles: string[];
  referencesDir: string;
  enabledReferences: ReferenceEntry[];
  enabledSkills: ResolvedSkill[];
  enabledCommands: string[];
  enabledAgents: string[];
  mcpServers: ResolvedMcpServer[];
  extraFolders: ExtraFolder[];
}

function emptySources(): ProfileSources {
  return {
    references: new Map(),
    skills: new Map(),
    mcp: new Map(),
    instructions: new Map(),
    plugins: new Map(),
    commands: new Map(),
    agents: new Map()
  };
}

function mergeSources(base: ProfileSources, child: ProfileSources): ProfileSources {
  const merge = (
    kind: string,
    a: Map<string, LoadedManifests>,
    b: Map<string, LoadedManifests>
  ) => {
    const merged = new Map(a);
    for (const [name, home] of b) {
      const existing = merged.get(name);
      if (existing && existing.root !== home.root) {
        throw new Error(
          `Active ${kind} collision for ${name}: ${homeDisplayName(existing)} and ${homeDisplayName(home)}`
        );
      }
      merged.set(name, home);
    }
    return merged;
  };
  return {
    references: merge("reference", base.references, child.references),
    skills: merge("skill", base.skills, child.skills),
    mcp: merge("MCP", base.mcp, child.mcp),
    instructions: merge("instruction", base.instructions, child.instructions),
    plugins: merge("OpenCode plugin", base.plugins, child.plugins),
    commands: merge("OpenCode command", base.commands, child.commands),
    agents: merge("OpenCode agent", base.agents, child.agents)
  };
}

function setSource(
  map: Map<string, LoadedManifests>,
  kind: string,
  name: string,
  home: LoadedManifests
): void {
  const existing = map.get(name);
  if (existing && existing.root !== home.root) {
    throw new Error(
      `Active ${kind} collision for ${name}: ${homeDisplayName(existing)} and ${homeDisplayName(home)}`
    );
  }
  map.set(name, home);
}

function homeDisplayName(home: LoadedManifests): string {
  return home.aliasPath.length > 0 ? home.aliasPath.join("/") : "local";
}

function homeByAliasPath(home: LoadedManifests, aliases: string[]): LoadedManifests | null {
  if (aliases.length === 0) return home;
  return (
    eachUpstream(home).find((candidate) => candidate.aliasPath.join("/") === aliases.join("/")) ??
    null
  );
}

function eachUpstream(home: LoadedManifests): LoadedManifests[] {
  return home.upstream ? [home.upstream, ...eachUpstream(home.upstream)] : [];
}

function hasLocalDefinition(home: LoadedManifests, kind: CatalogKind, name: string): boolean {
  switch (kind) {
    case "reference":
      return home.references.some((entry) => entry.name === name);
    case "skill":
      return home.skills.some((entry) => entry.name === name);
    case "mcp":
      return name in home.mcpServers;
    case "profile":
      return home.profiles.has(name);
  }
}

function findUpstreamDefinition(
  home: LoadedManifests,
  kind: CatalogKind,
  name: string
): LoadedManifests | null {
  return eachUpstream(home).find((candidate) => hasLocalDefinition(candidate, kind, name)) ?? null;
}

function resolveCatalogName(
  home: LoadedManifests,
  rawName: string,
  kind: CatalogKind
): { name: string; home: LoadedManifests } {
  const parts = rawName.split("/");
  if (parts.length > 1 && home.upstream?.aliasPath[0] === parts[0]) {
    const name = parts.at(-1)!;
    const target = homeByAliasPath(home, parts.slice(0, -1));
    if (!target)
      throw new Error(`Unknown upstream alias in ${kind}: ${parts.slice(0, -1).join("/")}`);
    if (!hasLocalDefinition(target, kind, name)) {
      throw new Error(`Unknown ${kind}: ${rawName}`);
    }
    return { name, home: target };
  }

  if (rawName.includes("/")) {
    throw new Error(`Unknown upstream alias in ${kind}: ${parts[0]}`);
  }
  if (hasLocalDefinition(home, kind, rawName)) return { name: rawName, home };
  const upstream = findUpstreamDefinition(home, kind, rawName);
  if (upstream) {
    throw new Error(
      `Unknown local ${kind}: ${rawName}. Did you mean ${upstream.aliasPath.join("/")}/${rawName}?`
    );
  }
  throw new Error(`Unknown ${kind}: ${rawName}`);
}

function normalizeProfile(home: LoadedManifests, profile: ProfileManifest): ProfileBuild {
  const sources = emptySources();
  const references = profile.references.map((rawName) => {
    const resolved = resolveCatalogName(home, rawName, "reference");
    setSource(sources.references, "reference", resolved.name, resolved.home);
    return resolved.name;
  });
  const skills = Object.fromEntries(
    Object.entries(profile.skills).map(([rawName, config]) => {
      const resolved = resolveCatalogName(home, rawName, "skill");
      setSource(sources.skills, "skill", resolved.name, resolved.home);
      return [resolved.name, config];
    })
  ) as ProfileManifest["skills"];
  const mcp = Object.fromEntries(
    Object.entries(profile.mcp).map(([rawName, config]) => {
      const resolved = resolveCatalogName(home, rawName, "mcp");
      setSource(sources.mcp, "MCP", resolved.name, resolved.home);
      return [resolved.name, config];
    })
  ) as ProfileManifest["mcp"];
  const instructions = profile.instructions.map((rawName) => {
    const parts = rawName.split("/");
    if (parts.length > 1 && home.upstream?.aliasPath[0] === parts[0]) {
      const target = homeByAliasPath(home, parts.slice(0, -1));
      if (!target)
        throw new Error(`Unknown upstream alias in instruction: ${parts.slice(0, -1).join("/")}`);
      const name = parts.at(-1)!;
      setSource(sources.instructions, "instruction", name, target);
      return name;
    }
    setSource(sources.instructions, "instruction", rawName, home);
    return rawName;
  });
  const opencode = {
    ...profile.opencode,
    plugins: profile.opencode.plugins.map((rawName) => {
      const parts = rawName.split("/");
      const target =
        parts.length > 1 && home.upstream?.aliasPath[0] === parts[0]
          ? homeByAliasPath(home, parts.slice(0, -1))
          : home;
      if (!target) throw new Error(`Unknown upstream alias in opencode plugin: ${parts[0]}`);
      const name = parts.at(-1)!;
      setSource(sources.plugins, "OpenCode plugin", name, target);
      return name;
    }),
    commands: profile.opencode.commands.map((rawName) => {
      const parts = rawName.split("/");
      const target =
        parts.length > 1 && home.upstream?.aliasPath[0] === parts[0]
          ? homeByAliasPath(home, parts.slice(0, -1))
          : home;
      if (!target) throw new Error(`Unknown upstream alias in opencode command: ${parts[0]}`);
      const name = parts.at(-1)!;
      setSource(sources.commands, "OpenCode command", name, target);
      return name;
    }),
    agents: profile.opencode.agents.map((rawName) => {
      const parts = rawName.split("/");
      const target =
        parts.length > 1 && home.upstream?.aliasPath[0] === parts[0]
          ? homeByAliasPath(home, parts.slice(0, -1))
          : home;
      if (!target) throw new Error(`Unknown upstream alias in opencode agent: ${parts[0]}`);
      const name = parts.at(-1)!;
      setSource(sources.agents, "OpenCode agent", name, target);
      return name;
    })
  };

  return { profile: { ...profile, references, skills, mcp, instructions, opencode }, sources };
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
): Promise<ProfileBuild> {
  const resolvedName = resolveCatalogName(manifests, name, "profile");
  const profile = resolvedName.home.profiles.get(resolvedName.name);
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  const own = normalizeProfile(resolvedName.home, profile);
  if (!profile.extends) return own;
  const parent = await resolveProfileByName(resolvedName.home, profile.extends);
  return {
    profile: mergeProfiles(parent.profile, own.profile),
    sources: mergeSources(parent.sources, own.sources)
  };
}

export async function resolveProfile(
  paths: RuntimePaths,
  requestedProfile?: string
): Promise<ResolvedProfile> {
  const manifests = await loadManifests(paths.root, paths.home);
  const name =
    requestedProfile ?? process.env.MFZ_PROFILE ?? manifests.machine.profile ?? "personal";
  const profileBuild = await resolveProfileByName(manifests, name);
  const { profile, sources } = profileBuild;
  const agents = profile.agents;

  const instructionFiles = profile.instructions.map((file) => {
    const sourceHome = sources.instructions.get(file) ?? manifests;
    return path.resolve(
      sourceHome.root,
      file.startsWith("instructions/") ? file : path.join("instructions", file)
    );
  });
  const referenceNames = dedupe(profile.references);
  const enabledReferences = referenceNames.map((refName) => {
    const sourceHome = sources.references.get(refName) ?? manifests;
    const ref = sourceHome.references.find((entry) => entry.name === refName);
    if (!ref) throw new Error(`Profile ${name} references unknown reference: ${refName}`);
    return ref;
  });
  const enabledSkills = Object.entries(profile.skills)
    .map(([skillName, config]) => {
      const sourceHome = sources.skills.get(skillName) ?? manifests;
      const skill = sourceHome.skills.find((s) => s.name === skillName);
      if (!skill) throw new Error(`Profile ${name} references unknown skill: ${skillName}`);
      return { ...skill, ...resolveSkillConfig(config, agents), sourceRoot: sourceHome.root };
    })
    .filter((entry) => entry.targets.length > 0);
  const enabledCommands = dedupe(profile.opencode.commands);
  const enabledAgents = dedupe(profile.opencode.agents);
  const mcpServers = Object.entries(profile.mcp).map(([serverName, { agents: mcpAgents }]) => {
    const sourceHome = sources.mcp.get(serverName) ?? manifests;
    const server = sourceHome.mcpServers[serverName];
    if (!server) throw new Error(`Profile ${name} references unknown MCP server: ${serverName}`);
    return { name: serverName, server, agents: mcpAgents };
  });

  const extraFolders: ExtraFolder[] = (() => {
    const map = new Map<string, ExtraFolder>();
    for (const f of profile.extra_folders) map.set(f.path, f);
    for (const upstream of eachUpstream(manifests)) {
      map.set(upstream.root, {
        path: upstream.root,
        description: `Upstream mindframe-z home ${homeDisplayName(upstream)}`,
        read: "allow",
        edit: "allow"
      });
    }
    for (const f of manifests.machine.extra_folders) map.set(f.path, f);
    return [...map.values()];
  })();

  return {
    name,
    agents,
    profile,
    manifests,
    sources,
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
