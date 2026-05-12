import path from "node:path";
import { dedupe, expandHome, type RuntimePaths } from "./paths.js";
import {
  loadManifests,
  type LoadedManifests,
  type McpServer,
  type ProfileManifest,
  type ReferenceEntry,
  type SkillEntry,
} from "./manifests.js";

export interface ResolvedMcpServer {
  name: string;
  server: McpServer;
  enabled: boolean;
}

export interface ResolvedProfile {
  name: string;
  profile: ProfileManifest;
  manifests: LoadedManifests;
  instructionFiles: string[];
  referencesDir: string;
  enabledReferences: ReferenceEntry[];
  enabledSkills: SkillEntry[];
  mcpServers: ResolvedMcpServer[];
}

function deepMerge(
  base: Record<string, unknown>,
  child: Record<string, unknown>,
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
        value as Record<string, unknown>,
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
    targets: child.targets.length > 0 ? child.targets : base.targets,
    instructions: dedupe([...base.instructions, ...child.instructions]),
    references: dedupe([...base.references, ...child.references]),
    skills: dedupe([...base.skills, ...child.skills]),
    mcp: { ...base.mcp, ...child.mcp },
    opencode: deepMerge(base.opencode, child.opencode),
    opencode_plugins: dedupe([...base.opencode_plugins, ...child.opencode_plugins]),
    claude: deepMerge(base.claude, child.claude) as ProfileManifest["claude"],
    mise: {
      tools: deepMerge(
        base.mise.tools as Record<string, unknown>,
        child.mise.tools as Record<string, unknown>,
      ) as ProfileManifest["mise"]["tools"],
      env: { ...base.mise.env, ...child.mise.env },
      tool_alias: { ...base.mise.tool_alias, ...child.mise.tool_alias },
    },
    dotfiles,
  };
}

async function resolveProfileByName(
  manifests: LoadedManifests,
  name: string,
): Promise<ProfileManifest> {
  const profile = manifests.profiles.get(name);
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  if (!profile.extends) return profile;
  const parent = await resolveProfileByName(manifests, profile.extends);
  return mergeProfiles(parent, profile);
}

export async function resolveProfile(
  paths: RuntimePaths,
  requestedProfile?: string,
): Promise<ResolvedProfile> {
  const manifests = await loadManifests(paths.root, paths.home);
  const name =
    requestedProfile ?? process.env.MFZ_PROFILE ?? manifests.machine.profile ?? "personal";
  const profile = await resolveProfileByName(manifests, name);

  const instructionFiles = profile.instructions.map((file) => path.resolve(paths.root, file));
  const referenceNames = dedupe(profile.references);
  const enabledReferences = referenceNames.map((refName) => {
    const ref = manifests.references.find((entry) => entry.name === refName);
    if (!ref) throw new Error(`Profile ${name} references unknown reference: ${refName}`);
    return ref;
  });
  const enabledSkills = profile.skills.map((skillName) => {
    const skill = manifests.skills.find((s) => s.name === skillName);
    if (!skill) throw new Error(`Profile ${name} references unknown skill: ${skillName}`);
    return skill;
  });
  const mcpServers = Object.entries(profile.mcp).map(([serverName, { enabled }]) => {
    const server = manifests.mcpServers[serverName];
    if (!server) throw new Error(`Profile ${name} references unknown MCP server: ${serverName}`);
    return { name: serverName, server, enabled };
  });

  return {
    name,
    profile,
    manifests,
    instructionFiles,
    referencesDir: path.resolve(
      expandHome(process.env.MFZ_REFERENCES_DIR ?? manifests.machine.references_dir, paths.home),
    ),
    enabledReferences,
    enabledSkills,
    mcpServers,
  };
}

export function filterMcpForTarget(
  profile: ResolvedProfile,
  target: "opencode" | "claude-code",
): ResolvedMcpServer[] {
  return profile.mcpServers.filter((entry) => entry.server.targets.includes(target));
}
