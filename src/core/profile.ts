import path from "node:path";
import { dedupe, expandHome, type AgentName, type RuntimePaths } from "./paths.js";
import {
  eachUpstream,
  homeDisplayName,
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
type SourceKind =
  | CatalogKind
  | "instruction"
  | "opencode plugin"
  | "opencode TUI plugin"
  | "opencode command"
  | "opencode agent";

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

function resolveQualifiedName(
  home: LoadedManifests,
  rawName: string,
  kind: SourceKind,
  options: { allowLocalSlash?: boolean } = {}
): { name: string; home: LoadedManifests } {
  const parts = rawName.split("/");
  const upstream = eachUpstream(home)
    .sort((a, b) => b.aliasPath.length - a.aliasPath.length)
    .find((candidate) => candidate.aliasPath.every((alias, index) => parts[index] === alias));

  if (upstream) {
    const name = parts.slice(upstream.aliasPath.length).join("/");
    if (!name) throw new Error(`Missing ${kind} after upstream alias: ${rawName}`);
    return { name, home: upstream };
  }

  if (parts.length > 1 && !options.allowLocalSlash) {
    throw new Error(`Unknown upstream alias in ${kind}: ${parts[0]}`);
  }

  return { name: rawName, home };
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
  const resolved = resolveQualifiedName(home, rawName, kind);
  if (resolved.home !== home) {
    if (!hasLocalDefinition(resolved.home, kind, resolved.name)) {
      throw new Error(`Unknown ${kind}: ${rawName}`);
    }
    return resolved;
  }

  if (hasLocalDefinition(home, kind, resolved.name)) return resolved;
  const upstream = findUpstreamDefinition(home, kind, resolved.name);
  if (upstream) {
    throw new Error(
      `Unknown local ${kind}: ${rawName}. Did you mean ${upstream.aliasPath.join("/")}/${resolved.name}?`
    );
  }
  throw new Error(`Unknown ${kind}: ${rawName}`);
}

function normalizeSourceNames(
  home: LoadedManifests,
  names: readonly string[],
  sourceMap: Map<string, LoadedManifests>,
  kind: SourceKind,
  label: string,
  options: { allowLocalSlash?: boolean } = {}
): string[] {
  return names.map((rawName) => {
    const resolved = resolveQualifiedName(home, rawName, kind, options);
    setSource(sourceMap, label, resolved.name, resolved.home);
    return resolved.name;
  });
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
  const instructions = normalizeSourceNames(
    home,
    profile.instructions,
    sources.instructions,
    "instruction",
    "instruction",
    { allowLocalSlash: true }
  );
  const opencode = {
    ...profile.opencode,
    plugins: normalizeSourceNames(
      home,
      profile.opencode.plugins,
      sources.plugins,
      "opencode plugin",
      "OpenCode plugin"
    ),
    tui_plugins: normalizeSourceNames(
      home,
      profile.opencode.tui_plugins,
      sources.plugins,
      "opencode TUI plugin",
      "OpenCode TUI plugin"
    ),
    commands: normalizeSourceNames(
      home,
      profile.opencode.commands,
      sources.commands,
      "opencode command",
      "OpenCode command"
    ),
    agents: normalizeSourceNames(
      home,
      profile.opencode.agents,
      sources.agents,
      "opencode agent",
      "OpenCode agent"
    )
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
      dependencies: { ...base.opencode.dependencies, ...child.opencode.dependencies },
      plugins: dedupe([...base.opencode.plugins, ...child.opencode.plugins]),
      tui: deepMerge(base.opencode.tui, child.opencode.tui),
      tui_plugins: dedupe([...base.opencode.tui_plugins, ...child.opencode.tui_plugins]),
      commands: dedupe([...base.opencode.commands, ...child.opencode.commands]),
      agents: dedupe([...base.opencode.agents, ...child.opencode.agents]),
      delegate_general: child.opencode.delegate_general ?? base.opencode.delegate_general
    },
    claude: deepMerge(base.claude, child.claude) as ProfileManifest["claude"],
    codex: {
      config: deepMerge(base.codex.config, child.codex.config),
      plugins: deepMerge(
        base.codex.plugins,
        child.codex.plugins
      ) as ProfileManifest["codex"]["plugins"]
    },
    pi: {
      settings: deepMerge(base.pi.settings, child.pi.settings),
      subagent_config: deepMerge(base.pi.subagent_config, child.pi.subagent_config)
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
  const targets = Object.entries(config.agents)
    .filter(([, enabled]) => enabled)
    .map(([target]) => target)
    .filter((target): target is ToolTargetName => agents.includes(target as AgentName));
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
