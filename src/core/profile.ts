import path from "node:path";
import { dedupe, expandHome, type AgentName, type RuntimePaths } from "./paths.js";
import {
  eachUpstream,
  homeDisplayName,
  loadManifests,
  type LoadedManifests,
  type OpenCodePlugin,
  type McpServer,
  type ProfileAgentDefaults,
  type CapabilityAgentName,
  type VendoredSkillTarget,
  type ProfileManifest,
  type InstructionReference,
  type CapabilityGroup,
  type ReferenceEntry,
  type SkillEntry,
  type ExternalSkillEntry,
  type ExtraFolder
} from "./manifests.js";
import { readVendorLock, validateVendoredSkill, validateVendoredSkills } from "../skills/vendor.js";
import { expandToolSkillSets } from "../skills/tool.js";
import { readDirEntries } from "./fs-util.js";
import { machineInstructionsDir } from "./path-util.js";
import { expandRepoPaths, repoExtraFolder, resolveRepo, type ResolvedRepo } from "./repos.js";
import type { JsonObject } from "./json.js";
import { appSlug, type AppFile } from "../executor/apps.js";
import { readAppSource } from "../executor/source.js";

type CatalogKind = "reference" | "repo" | "skill" | "mcp" | "opencode plugin" | "profile";

type SourceKind =
  | CatalogKind
  | "instruction"
  | "opencode command"
  | "opencode agent"
  | "executor app";

interface ProfileSources {
  references: Map<string, LoadedManifests>;
  repos: Map<string, LoadedManifests>;
  skills: Map<string, LoadedManifests>;
  mcp: Map<string, LoadedManifests>;
  instructions: Map<string, LoadedManifests>;
  plugins: Map<string, LoadedManifests>;
  commands: Map<string, LoadedManifests>;
  agents: Map<string, LoadedManifests>;
  executorApps: Map<string, LoadedManifests>;
}

interface ProfileBuild {
  profile: ProfileManifest;
  sources: ProfileSources;
  miseLayers: ResolvedMiseLayer[];
}

export interface ResolvedMiseLayer {
  name: string;
  root: string;
  content?: string;
}

export interface ProfileResolutionOptions {
  readonly evaluateAgents?: readonly AgentName[];
}

export interface ResolvedMcpServer {
  name: string;
  server: McpServer;
  agents: Partial<Record<CapabilityAgentName, boolean>>;
  // Hosted as an Executor app by `mfz executor apply`; direct renderers ignore it.
  executor: boolean;
}

/** A hand-written Executor app from a home's executor/apps/<name>/ folder. */
export interface ResolvedExecutorApp {
  name: string;
  directory: string;
  files: AppFile[];
}

type ResolvedVendor =
  | {
      repository: string;
      ref: string;
      subtree: string;
      commit: string;
      digest: string;
    }
  | {
      repository: string;
      ref: string;
      variants: Record<VendoredSkillTarget, { subtree: string; digest: string }>;
      commit: string;
      digest: string;
    };

interface SkillResolution {
  agents: ProfileAgentDefaults;
  toggleable: boolean;
  targets: CapabilityAgentName[];
  sourceRoot: string;
  /** Member skills wanted from a generated tool skill set or an external tool. */
  select?: string[];
}

/** A skill MFZ renders into the profile snapshot. */
export type ResolvedSkill = Exclude<SkillEntry, ExternalSkillEntry> &
  SkillResolution & {
    vendor?: ResolvedVendor;
    /** The generated tool skill set this member skill came from. */
    toolSet?: string;
  };

/** A skill a tool's own CLI installs; MFZ declares and checks it but never renders it. */
export type ResolvedExternalSkill = ExternalSkillEntry & SkillResolution;

export type DeclaredSkill = ResolvedSkill | ResolvedExternalSkill;

function isExternalSkill(skill: DeclaredSkill): skill is ResolvedExternalSkill {
  return skill.source === "external";
}

function isRenderedSkill(skill: DeclaredSkill): skill is ResolvedSkill {
  return skill.source !== "external";
}

export type TargetedMcpServer = ResolvedMcpServer & { enabled: boolean };

/** A catalog plugin enabled by the profile, with the root of the home that declares it. */
// A repo-sourced plugin carries the checkout directory it resolves to.
export type ResolvedOpenCodePlugin = OpenCodePlugin & { sourceRoot: string; directory?: string };

export interface ResolvedProfile {
  name: string;
  agents: AgentName[];
  profile: ProfileManifest;
  manifests: LoadedManifests;
  sources: ProfileSources;
  instructionFiles: string[];
  instructionReferences: Array<InstructionReference & { sourcePath: string }>;
  referencesDir: string;
  enabledReferences: ReferenceEntry[];
  enabledRepos: ResolvedRepo[];
  /** Skills agents receive, with each generated tool skill set expanded into its members. */
  enabledSkills: ResolvedSkill[];
  /** Enabled generated tool skill sets, as declared; refresh works on these. */
  toolSkillSets: ResolvedSkill[];
  /** Enabled skills a tool's own CLI installs; MFZ declares and checks them but never renders them. */
  externalSkills: ResolvedExternalSkill[];
  enabledOpenCodeCommands: string[];
  enabledOpenCodeAgents: string[];
  enabledOpenCodePlugins?: ResolvedOpenCodePlugin[];
  mcpServers: ResolvedMcpServer[];
  executorApps: ResolvedExecutorApp[];
  extraFolders: ExtraFolder[];
  miseLayers: ResolvedMiseLayer[];
}

export interface ResolvedSkillDeclarations {
  name: string;
  manifests: LoadedManifests;
  selectedSkills: DeclaredSkill[];
}

function emptySources(): ProfileSources {
  return {
    references: new Map(),
    repos: new Map(),
    skills: new Map(),
    mcp: new Map(),
    instructions: new Map(),
    plugins: new Map(),
    commands: new Map(),
    agents: new Map(),
    executorApps: new Map()
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
    repos: merge("repository", base.repos, child.repos),
    skills: merge("skill", base.skills, child.skills),
    mcp: merge("MCP", base.mcp, child.mcp),
    instructions: merge("instruction", base.instructions, child.instructions),
    plugins: merge("OpenCode plugin", base.plugins, child.plugins),
    commands: merge("OpenCode command", base.commands, child.commands),
    agents: merge("OpenCode agent", base.agents, child.agents),
    executorApps: merge("Executor app", base.executorApps, child.executorApps)
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
) {
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
    case "repo":
      return home.repos.some((entry) => entry.name === name);
    case "skill":
      return home.skills.some((entry) => entry.name === name);
    case "mcp":
      return name in home.mcpServers;
    case "opencode plugin":
      return home.opencodePlugins.some((entry) => entry.name === name);
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

function normalizeProfile(
  home: LoadedManifests,
  profile: ProfileManifest,
  options: { includeOpenCode: boolean }
): ProfileBuild {
  const sources = emptySources();

  const references = profile.references.map((rawName) => {
    const resolved = resolveCatalogName(home, rawName, "reference");
    setSource(sources.references, "reference", resolved.name, resolved.home);

    return resolved.name;
  });

  const repos = profile.repos.map((rawName) => {
    const resolved = resolveCatalogName(home, rawName, "repo");
    setSource(sources.repos, "repository", resolved.name, resolved.home);

    return resolved.name;
  });

  const skills: ProfileManifest["skills"] = {};

  for (const [rawName, config] of Object.entries(profile.skills)) {
    const resolved = resolveCatalogName(home, rawName, "skill");
    setSource(sources.skills, "skill", resolved.name, resolved.home);
    skills[resolved.name] = config;
  }

  const mcp: ProfileManifest["mcp"] = {};

  for (const [rawName, config] of Object.entries(profile.mcp)) {
    const resolved = resolveCatalogName(home, rawName, "mcp");
    setSource(sources.mcp, "MCP", resolved.name, resolved.home);
    mcp[resolved.name] = config;
  }

  const instructions = normalizeSourceNames(
    home,
    profile.instructions,
    sources.instructions,
    "instruction",
    "instruction",
    { allowLocalSlash: true }
  );

  const instructionReferencePaths = normalizeSourceNames(
    home,
    profile.instruction_references.map((reference) => reference.path),
    sources.instructions,
    "instruction",
    "instruction reference",
    { allowLocalSlash: true }
  );

  const instructionReferences = profile.instruction_references.map((reference, index) => ({
    ...reference,
    path: instructionReferencePaths[index]!
  }));

  const executorApps = normalizeSourceNames(
    home,
    profile.executor.apps,
    sources.executorApps,
    "executor app",
    "Executor app"
  );

  const opencode = options.includeOpenCode
    ? {
        ...profile.opencode,
        plugins: profile.opencode.plugins.map((rawName) => {
          const resolved = resolveCatalogName(home, rawName, "opencode plugin");
          setSource(sources.plugins, "OpenCode plugin", resolved.name, resolved.home);

          return resolved.name;
        }),
        // Options use the same catalog names, so a qualified key selects an upstream plugin's options.
        plugin_options: Object.fromEntries(
          Object.entries(profile.opencode.plugin_options).map(([rawName, options]) => [
            resolveCatalogName(home, rawName, "opencode plugin").name,
            options
          ])
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
      }
    : profile.opencode;

  const miseLayer: ResolvedMiseLayer = {
    name: profile.name,
    root: home.root
  };

  if (home.miseFiles.has(profile.name)) miseLayer.content = home.miseFiles.get(profile.name)!;

  return {
    profile: {
      ...profile,
      references,
      repos,
      skills,
      mcp,
      instructions,
      instruction_references: instructionReferences,
      executor: { apps: executorApps },
      opencode: opencode
    },
    sources,
    miseLayers: [miseLayer]
  };
}

type MergeValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | undefined
  | MergeValue[]
  | MergeInput;

interface MergeInput {
  [key: string]: MergeValue;
}

export function deepMerge<T extends object, U extends object>(base: T, child: U): T & U;
export function deepMerge(base: MergeInput, child: MergeInput): MergeInput {
  const result = new Map<string, MergeValue>(Object.entries(base));

  for (const [key, value] of Object.entries(child)) {
    const existing = result.get(key);
    result.set(
      key,
      isMergeObject(value) && isMergeObject(existing) ? deepMerge(existing, value) : value
    );
  }

  return Object.fromEntries(result);
}

export function mergeProfiles(base: ProfileManifest, child: ProfileManifest): ProfileManifest {
  const dotfiles = { ...base.dotfiles };

  for (const [key, value] of Object.entries(child.dotfiles)) {
    dotfiles[key] = key in dotfiles ? dotfiles[key] + "\n" + value : value;
  }

  return {
    name: child.name,
    extends: child.extends ?? base.extends,
    description: child.description || base.description,
    agents: child.agents.length > 0 ? child.agents : base.agents,
    instructions: dedupe([...base.instructions, ...child.instructions]),
    instruction_references: (() => {
      const map = new Map<string, InstructionReference>();

      for (const reference of base.instruction_references) map.set(reference.name, reference);

      for (const reference of child.instruction_references) map.set(reference.name, reference);

      return [...map.values()];
    })(),
    capability_groups: (() => {
      const map = new Map<string, CapabilityGroup>();

      for (const group of base.capability_groups) map.set(group.name, group);

      for (const group of child.capability_groups) map.set(group.name, group);

      return [...map.values()];
    })(),
    references: dedupe([...base.references, ...child.references]),
    repos: dedupe([...base.repos, ...child.repos]),
    extra_folders: (() => {
      const map = new Map<string, ExtraFolder>();

      for (const f of base.extra_folders) map.set(f.path, f);

      for (const f of child.extra_folders) map.set(f.path, f);

      return [...map.values()];
    })(),
    skills: deepMerge(base.skills, child.skills),
    mcp: mergeMcpConfigs(base.mcp, child.mcp),
    executor: { apps: dedupe([...base.executor.apps, ...child.executor.apps]) },
    opencode: {
      config: deepMerge(base.opencode.config, child.opencode.config),
      permissions: [...base.opencode.permissions, ...child.opencode.permissions],
      dependencies: { ...base.opencode.dependencies, ...child.opencode.dependencies },
      cli: deepMerge(base.opencode.cli, child.opencode.cli),
      global_instructions: child.opencode.global_instructions ?? base.opencode.global_instructions,
      plugins: dedupe([...base.opencode.plugins, ...child.opencode.plugins]),
      plugin_options: deepMerge(base.opencode.plugin_options, child.opencode.plugin_options),
      commands: dedupe([...base.opencode.commands, ...child.opencode.commands]),
      agents: dedupe([...base.opencode.agents, ...child.opencode.agents])
    },
    claude: deepMerge(base.claude, child.claude),
    codex: {
      config: deepMerge(base.codex.config, child.codex.config),
      plugins: deepMerge(base.codex.plugins, child.codex.plugins)
    },
    pi: {
      settings: deepMerge(base.pi.settings, child.pi.settings),
      subagent_config: deepMerge(base.pi.subagent_config, child.pi.subagent_config)
    },
    thread: {
      stores: (() => {
        const map = new Map<string, ProfileManifest["thread"]["stores"][number]>();

        for (const store of base.thread.stores) map.set(store.name, store);

        for (const store of child.thread.stores) map.set(store.name, store);

        return [...map.values()];
      })(),
      defaults: { ...base.thread.defaults, ...child.thread.defaults },
      update_strategy: child.thread.update_strategy ?? base.thread.update_strategy,
      credentials: child.thread.credentials ?? base.thread.credentials
    },
    dotfiles
  };
}

function mergeMcpConfigs(
  base: ProfileManifest["mcp"],
  child: ProfileManifest["mcp"]
): ProfileManifest["mcp"] {
  const merged: ProfileManifest["mcp"] = { ...base };

  for (const [name, childConfig] of Object.entries(child)) {
    const baseConfig = base[name];

    if (!baseConfig) {
      merged[name] = childConfig;
      continue;
    }

    const combined = deepMerge(baseConfig, childConfig);

    if (childConfig.agents && Object.values(childConfig.agents).some((enabled) => enabled)) {
      combined.agents = childConfig.agents;
    }

    merged[name] = combined;
  }

  return merged;
}

function resolveSkillConfig(
  config: ProfileManifest["skills"][string],
  agents: CapabilityAgentName[]
): ResolvedSkillConfig {
  if (!config?.agents) {
    throw new Error("Skill entries must declare agents after profile inheritance is resolved");
  }

  const targets = Object.entries(config.agents)
    .filter(([, enabled]) => enabled)
    .map(([target]) => target)
    .filter((target): target is CapabilityAgentName => agents.some((agent) => agent === target));

  const resolved: ResolvedSkillConfig = {
    agents: config.agents,
    toggleable: config.toggleable,
    targets
  };

  if (config.select !== undefined) resolved.select = config.select;

  return resolved;
}

function isMergeObject(value: MergeValue): value is MergeInput {
  return Object.prototype.toString.call(value) === "[object Object]";
}

interface ResolvedSkillConfig {
  agents: ProfileAgentDefaults;
  toggleable: boolean;
  targets: CapabilityAgentName[];
  select?: string[];
}

function capabilityAgent(agent: AgentName): CapabilityAgentName | undefined {
  if (agent === "pi") return undefined;

  return agent;
}

function resolveSelectedSkills(
  profileName: string,
  build: ProfileBuild,
  manifests: LoadedManifests,
  agents: CapabilityAgentName[]
): DeclaredSkill[] {
  return Object.entries(build.profile.skills).map(([skillName, config]): DeclaredSkill => {
    const sourceHome = build.sources.skills.get(skillName) ?? manifests;
    const skill = sourceHome.skills.find((entry) => entry.name === skillName);

    if (!skill) throw new Error(`Profile ${profileName} references unknown skill: ${skillName}`);

    if (config?.select !== undefined && !("generate" in skill) && skill.source !== "external") {
      throw new Error(
        `Profile ${profileName} sets select on ${skillName}, which is not a generated tool skill set or an external skill`
      );
    }

    return { ...skill, ...resolveSkillConfig(config, agents), sourceRoot: sourceHome.root };
  });
}

async function resolveEnabledSkills(
  profileName: string,
  build: ProfileBuild,
  manifests: LoadedManifests,
  agents: CapabilityAgentName[]
): Promise<DeclaredSkill[]> {
  const enabled = resolveSelectedSkills(profileName, build, manifests, agents).filter(
    (entry) => entry.targets.length > 0
  );

  const validatedVendorRoots = new Set<string>();

  for (const skill of enabled) {
    if (skill.source !== "vendored") continue;

    if (!validatedVendorRoots.has(skill.sourceRoot)) {
      const failures = await validateVendoredSkills(skill.sourceRoot);

      if (failures.length > 0) throw new Error(failures.join("; "));
      validatedVendorRoots.add(skill.sourceRoot);
    }

    const lock = await readVendorLock(skill.sourceRoot);
    const lockEntry = lock.skills[skill.name];

    if (!lockEntry) throw new Error(`Vendored skill ${skill.name} has no vendor lock entry`);
    await validateVendoredSkill(skill.sourceRoot, skill, lock);

    // The catalog may lead the promoted lock during a shape migration. Keep the desired entry
    // available to read-only profile commands without assigning it trusted vendor provenance.
    if ("variants" in skill !== "variants" in lockEntry) continue;

    if ("variants" in skill) {
      if (!("variants" in lockEntry)) {
        throw new Error(`Vendored skill ${skill.name} variant lock entry is missing variants`);
      }

      skill.vendor = {
        repository: skill.repo,
        ref: skill.ref,
        variants: {
          "claude-code": {
            subtree: skill.variants["claude-code"],
            digest: lockEntry.variants["claude-code"]
          },
          codex: {
            subtree: skill.variants.codex,
            digest: lockEntry.variants.codex
          },
          opencode: {
            subtree: skill.variants["opencode"],
            digest: lockEntry.variants["opencode"]
          }
        },
        commit: lockEntry.commit,
        digest: lockEntry.digest
      };
    } else {
      if ("variants" in lockEntry) {
        throw new Error(`Vendored skill ${skill.name} lock entry unexpectedly contains variants`);
      }

      skill.vendor = {
        repository: skill.repo,
        ref: skill.ref,
        subtree: skill.subtree,
        commit: lockEntry.commit,
        digest: lockEntry.digest
      };
    }
  }

  return enabled;
}

export async function resolveSkillDeclarations(
  paths: RuntimePaths,
  requestedProfile?: string
): Promise<ResolvedSkillDeclarations> {
  const manifests = await loadManifests(paths.root, paths.home);

  const name =
    requestedProfile ?? process.env.MFZ_PROFILE ?? manifests.machine.profile ?? "personal";

  const profileBuild = await resolveProfileByName(manifests, name, { includeOpenCode: false });

  const agents = profileBuild.profile.agents.flatMap((agent) => {
    const capability = capabilityAgent(agent);

    return capability === undefined ? [] : [capability];
  });

  return {
    name,
    manifests,
    selectedSkills: resolveSelectedSkills(name, profileBuild, manifests, agents)
  };
}

function resolveMcpServers(
  profileName: string,
  build: ProfileBuild,
  manifests: LoadedManifests
): ResolvedMcpServer[] {
  return Object.entries(build.profile.mcp).map(([serverName, config]): ResolvedMcpServer => {
    const sourceHome = build.sources.mcp.get(serverName) ?? manifests;
    const catalogServer = sourceHome.mcpServers[serverName];

    if (!catalogServer) {
      throw new Error(`Profile ${profileName} references unknown MCP server: ${serverName}`);
    }

    let server: McpServer = catalogServer;

    if (config.url !== undefined) {
      if (catalogServer.type !== "remote") {
        throw new Error(
          `Profile ${profileName} sets url for MCP server ${serverName}, which is a local server`
        );
      }

      server = { ...catalogServer, url: config.url };
    }

    const agents = config.agents ?? {};
    const executor = config.executor ?? false;

    if (Object.keys(agents).length === 0 && !executor) {
      throw new Error(
        `Profile ${profileName} MCP server ${serverName} has no route; declare agents or executor: true`
      );
    }

    if (executor) assertExecutorEligible(profileName, serverName, server);

    return { name: serverName, server, agents, executor };
  });
}

// Executor hosts the server from generated app source, which must hold no secrets or local setup.
function assertExecutorEligible(profileName: string, serverName: string, server: McpServer): void {
  const problem =
    server.type !== "remote"
      ? "is a local server; Executor can only host remote servers"
      : server.transport !== undefined && server.transport !== "http"
        ? `uses ${server.transport} transport; Executor needs http`
        : server.url.includes("{env:")
          ? "has an {env:...} reference in its URL, which cannot go into app source"
          : server.headers !== undefined
            ? "sets headers, which cannot go into app source"
            : undefined;

  if (problem !== undefined) {
    throw new Error(
      `Profile ${profileName} sets executor: true for MCP server ${serverName}, which ${problem}`
    );
  }
}

async function resolveExecutorApps(
  profileName: string,
  build: ProfileBuild,
  manifests: LoadedManifests,
  mcpServers: readonly ResolvedMcpServer[]
): Promise<ResolvedExecutorApp[]> {
  // Executor addresses apps by slug, so an app and a server app must not share one.
  const serverSlugs = new Map(
    mcpServers.flatMap((entry) => (entry.executor ? [[appSlug(entry.name), entry.name]] : []))
  );

  return Promise.all(
    build.profile.executor.apps.map(async (appName): Promise<ResolvedExecutorApp> => {
      if (appSlug(appName) !== appName) {
        throw new Error(
          `Profile ${profileName} declares Executor app ${appName}, which is not a valid app name; use lowercase letters, digits, and single hyphens, such as ${appSlug(appName)}`
        );
      }

      const server = serverSlugs.get(appName);

      if (server !== undefined) {
        throw new Error(
          `Profile ${profileName} declares Executor app ${appName}, which collides with MCP server ${server} that sets executor: true; rename one of them`
        );
      }

      const sourceHome = build.sources.executorApps.get(appName) ?? manifests;
      const directory = path.join(sourceHome.root, "executor", "apps", appName);

      return { name: appName, directory, files: await readAppSource(appName, directory) };
    })
  );
}

async function resolveProfileByName(
  manifests: LoadedManifests,
  name: string,
  options: { includeOpenCode: boolean; repoPathsHome?: string }
): Promise<ProfileBuild> {
  const resolvedName = resolveCatalogName(manifests, name, "profile");
  const profile = resolvedName.home.profiles.get(resolvedName.name);

  if (!profile) throw new Error(`Unknown profile: ${name}`);
  const own = normalizeProfile(resolvedName.home, profile, options);

  if (options.repoPathsHome !== undefined) {
    own.profile = withRepoPaths(own.profile, resolvedName.home, options.repoPathsHome);
  }

  if (!profile.extends) return own;
  const parent = await resolveProfileByName(resolvedName.home, profile.extends, options);

  return {
    profile: mergeProfiles(parent.profile, own.profile),
    sources: mergeSources(parent.sources, own.sources),
    miseLayers: [...parent.miseLayers, ...own.miseLayers]
  };
}

export const openCodeManagedConfigFields = [
  "$schema",
  "instructions",
  "mcp",
  "skills",
  "permissions",
  "plugins"
] as const;

export function assertOpenCodeConfigOwned(profile: ProfileManifest): void {
  for (const field of openCodeManagedConfigFields) {
    if (Object.hasOwn(profile.opencode.config, field)) {
      throw new Error(
        `OpenCode config field ${field} is generated by mindframe-z; remove it from opencode.config`
      );
    }
  }
}

// Top-level, non-hidden Markdown files in name order, so a numeric prefix sets
// their position after the profile's own instructions.
async function machineInstructionFiles(home: string): Promise<string[]> {
  const directory = machineInstructionsDir(home);
  const files: string[] = [];

  for (const entry of await readDirEntries(directory)) {
    if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")) {
      files.push(path.join(directory, entry.name));
    }
  }

  return files.sort();
}

export async function resolveProfile(
  paths: RuntimePaths,
  requestedProfile?: string,
  options: ProfileResolutionOptions = {}
): Promise<ResolvedProfile> {
  const manifests = await loadManifests(paths.root, paths.home);

  const name =
    requestedProfile ?? process.env.MFZ_PROFILE ?? manifests.machine.profile ?? "personal";

  const preliminary = await resolveProfileByName(manifests, name, {
    includeOpenCode: false,
    repoPathsHome: paths.home
  });

  const evaluateAgents = options.evaluateAgents ?? preliminary.profile.agents;
  const includeOpenCode = evaluateAgents.includes("opencode");

  const profileBuild = includeOpenCode
    ? await resolveProfileByName(manifests, name, { includeOpenCode, repoPathsHome: paths.home })
    : preliminary;

  const { sources } = profileBuild;
  const profile = profileBuild.profile;
  const agents = profile.agents;

  if (includeOpenCode) assertOpenCodeConfigOwned(profile);

  const skillCapabilityAgents = [
    ...new Set(
      [...agents, ...evaluateAgents].flatMap((agent) => {
        const capability = capabilityAgent(agent);

        return capability === undefined ? [] : [capability];
      })
    )
  ];

  const instructionFiles = [
    ...profile.instructions.map((file) => {
      const sourceHome = sources.instructions.get(file) ?? manifests;

      return path.resolve(
        sourceHome.root,
        file.startsWith("instructions/") ? file : path.join("instructions", file)
      );
    }),
    ...(await machineInstructionFiles(paths.home))
  ];

  const instructionReferences = profile.instruction_references.map((reference) => {
    const sourceHome = sources.instructions.get(reference.path) ?? manifests;

    return {
      ...reference,
      sourcePath: path.resolve(
        sourceHome.root,
        reference.path.startsWith("instructions/")
          ? reference.path
          : path.join("instructions", reference.path)
      )
    };
  });

  const referenceNames = dedupe(profile.references);

  const enabledReferences = referenceNames.map((refName) => {
    const sourceHome = sources.references.get(refName) ?? manifests;
    const ref = sourceHome.references.find((entry) => entry.name === refName);

    if (!ref) throw new Error(`Profile ${name} references unknown reference: ${refName}`);

    return ref;
  });

  const enabledRepos = resolveEnabledRepos(name, profile, sources, manifests, paths.home);

  const declaredSkills = await resolveEnabledSkills(
    name,
    profileBuild,
    manifests,
    skillCapabilityAgents
  );

  const externalSkills = declaredSkills.filter(isExternalSkill);
  const renderedSkills = declaredSkills.filter(isRenderedSkill);
  const toolSkillSets = renderedSkills.filter((skill) => "generate" in skill);
  const enabledSkills = await expandToolSkillSets(paths, renderedSkills);

  const enabledOpenCodeCommands = includeOpenCode ? dedupe(profile.opencode.commands) : [];
  const enabledOpenCodeAgents = includeOpenCode ? dedupe(profile.opencode.agents) : [];

  const enabledOpenCodePlugins = includeOpenCode
    ? dedupe(profile.opencode.plugins).map((pluginName): ResolvedOpenCodePlugin => {
        const sourceHome = sources.plugins.get(pluginName) ?? manifests;
        const plugin = sourceHome.opencodePlugins.find((entry) => entry.name === pluginName);

        if (!plugin)
          throw new Error(`Profile ${name} references unknown OpenCode plugin: ${pluginName}`);

        if (plugin.source !== "repo") return { ...plugin, sourceRoot: sourceHome.root };

        const repo = resolveCatalogName(sourceHome, plugin.repo, "repo");
        // SAFETY: resolveCatalogName fails unless the named repository exists in that home.
        const entry = repo.home.repos.find((candidate) => candidate.name === repo.name)!;
        const checkout = resolveRepo(entry, manifests.machine, paths.home).path;

        return {
          ...plugin,
          sourceRoot: sourceHome.root,
          directory: plugin.subdirectory ? path.join(checkout, plugin.subdirectory) : checkout
        };
      })
    : [];

  const mcpServers = resolveMcpServers(name, profileBuild, manifests);
  const executorApps = await resolveExecutorApps(name, profileBuild, manifests, mcpServers);

  const extraFolders: ExtraFolder[] = (() => {
    const map = new Map<string, ExtraFolder>();

    // Explicit extra folders override the grant a selected repository implies.
    for (const repo of enabledRepos) map.set(repo.path, repoExtraFolder(repo));

    for (const f of profile.extra_folders) map.set(f.path, f);

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
    instructionReferences,
    referencesDir: path.resolve(
      expandHome(process.env.MFZ_REFERENCES_DIR ?? manifests.machine.references_dir, paths.home)
    ),
    enabledReferences,
    enabledRepos,
    enabledSkills,
    toolSkillSets,
    externalSkills,
    enabledOpenCodeCommands,
    enabledOpenCodeAgents,
    enabledOpenCodePlugins,
    mcpServers,
    executorApps,
    extraFolders,
    miseLayers: profileBuild.miseLayers
  };
}

// Expands {repo:NAME} in the harness settings a profile passes through verbatim.
function withRepoPaths(
  profile: ProfileManifest,
  manifests: LoadedManifests,
  home: string
): ProfileManifest {
  const checkoutPath = (rawName: string): string => {
    const resolved = resolveCatalogName(manifests, rawName, "repo");
    // SAFETY: resolveCatalogName fails unless the named repository exists in that home.
    const entry = resolved.home.repos.find((candidate) => candidate.name === resolved.name)!;

    return resolveRepo(entry, manifests.machine, home).path;
  };

  const expand = (value: JsonObject): JsonObject => expandRepoPaths(value, checkoutPath);

  return {
    ...profile,
    opencode: {
      ...profile.opencode,
      config: expand(profile.opencode.config),
      cli: expand(profile.opencode.cli),
      plugin_options: Object.fromEntries(
        Object.entries(profile.opencode.plugin_options).map(([name, options]) => [
          name,
          expand(options)
        ])
      )
    },
    claude: { ...profile.claude, settings: expand(profile.claude.settings) },
    codex: { ...profile.codex, config: expand(profile.codex.config) },
    pi: {
      ...profile.pi,
      settings: expand(profile.pi.settings),
      subagent_config: expand(profile.pi.subagent_config)
    }
  };
}

function resolveEnabledRepos(
  profileName: string,
  profile: ProfileManifest,
  sources: ProfileSources,
  manifests: LoadedManifests,
  home: string
): ResolvedRepo[] {
  const repos = new Map<string, ResolvedRepo>();

  for (const repoName of profile.repos) {
    const sourceHome = sources.repos.get(repoName) ?? manifests;
    const entry = sourceHome.repos.find((candidate) => candidate.name === repoName);

    if (!entry)
      throw new Error(`Profile ${profileName} references unknown repository: ${repoName}`);
    repos.set(entry.name, resolveRepo(entry, manifests.machine, home));
  }

  // Machine config selects from the active home's catalog, like an unqualified profile entry.
  for (const rawName of manifests.machine.repos) {
    const resolved = resolveCatalogName(manifests, rawName, "repo");
    // SAFETY: resolveCatalogName fails unless the named repository exists in that home.
    const entry = resolved.home.repos.find((candidate) => candidate.name === resolved.name)!;
    repos.set(entry.name, resolveRepo(entry, manifests.machine, home));
  }

  return [...repos.values()];
}

export function filterMcpForTarget(
  profile: ResolvedProfile,
  target: AgentName
): TargetedMcpServer[] {
  const capabilityTarget = capabilityAgent(target);

  if (capabilityTarget === undefined) return [];

  return profile.mcpServers.flatMap((entry): TargetedMcpServer[] => {
    const enabled = entry.agents[capabilityTarget];

    if (enabled === undefined) return [];

    return [{ ...entry, enabled }];
  });
}

export function mcpDefaults(profile: ResolvedProfile, target: AgentName): Record<string, boolean> {
  const capabilityTarget: CapabilityAgentName | undefined =
    target === "opencode" ? "opencode" : target === "pi" ? undefined : target;

  return Object.fromEntries(
    profile.mcpServers.flatMap((server) =>
      capabilityTarget === undefined || server.agents[capabilityTarget] === undefined
        ? []
        : [[server.name, server.agents[capabilityTarget]]]
    )
  );
}
