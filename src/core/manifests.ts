import { access, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import YAML from "yaml";
import { z } from "zod";

const targetSchema = z.enum(["opencode", "claude-code"]);

export const referenceSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  description: z.string().default(""),
});

export const refsManifestSchema = z.object({
  references: z.array(referenceSchema).default([]),
});

export const skillSchema = z.object({
  name: z.string().min(1),
  source: z.enum(["local", "git"]),
  path: z.string().optional(),
  repo: z.string().optional(),
  skill: z.string().optional(),
  description: z.string().default(""),
  targets: z.array(targetSchema).default(["opencode", "claude-code"]),
  installer: z.literal("npx-skills").default("npx-skills"),
});

export const skillsManifestSchema = z.object({
  skills: z.array(skillSchema).default([]),
});

const mcpServerBaseSchema = z.object({
  description: z.string().default(""),
  targets: z.array(targetSchema).default(["opencode"]),
  type: z.enum(["remote", "local"]),
  transport: z.enum(["http", "sse", "stdio"]).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpServerSchema = z.union([
  mcpServerBaseSchema.extend({ type: z.literal("remote"), url: z.string().min(1) }),
  mcpServerBaseSchema.extend({ type: z.literal("local"), command: z.array(z.string()).min(1) }),
]);

export const mcpManifestSchema = z.object({
  servers: z.record(z.string(), mcpServerSchema).default({}),
});

const miseToolValueSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const miseTomlSchema = z.object({
  tools: z.record(z.string(), miseToolValueSchema).default({}),
  env: z.record(z.string(), z.coerce.string()).default({}),
  tool_alias: z.record(z.string(), z.coerce.string()).default({}),
});

export const profileSchema = z.object({
  name: z.string().min(1),
  extends: z.string().optional(),
  description: z.string().default(""),
  targets: z.array(targetSchema).default(["opencode", "claude-code"]),
  instructions: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  mcp: z.record(z.string(), z.object({ enabled: z.boolean() })).default({}),
  opencode: z.record(z.string(), z.unknown()).default({}),
  opencode_plugins: z.array(z.string()).default([]),
  claude: z
    .object({
      model: z.string().optional(),
      settings: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ settings: {} }),
  mise: z
    .object({
      tools: z.record(z.string(), miseToolValueSchema).default({}),
      env: z.record(z.string(), z.string()).default({}),
      tool_alias: z.record(z.string(), z.string()).default({}),
    })
    .default({ tools: {}, env: {}, tool_alias: {} }),
  dotfiles: z.record(z.string(), z.string()).default({}),
});

export const machineSchema = z.object({
  profile: z.string().optional(),
  references_dir: z.string().default("~/references"),
  opencode: z.record(z.string(), z.unknown()).default({}),
});

export type ReferenceEntry = z.infer<typeof referenceSchema>;
export type SkillEntry = z.infer<typeof skillSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type ProfileManifest = z.infer<typeof profileSchema>;
export type MachineManifest = z.infer<typeof machineSchema>;

export interface LoadedManifests {
  references: ReferenceEntry[];
  skills: SkillEntry[];
  mcpServers: Record<string, McpServer>;
  profiles: Map<string, ProfileManifest>;
  machine: MachineManifest;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readYaml<T>(file: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  if (!(await exists(file))) return fallback;
  const parsed = YAML.parse(await readFile(file, "utf8"));
  return schema.parse(parsed);
}

export async function loadManifests(root: string, home?: string): Promise<LoadedManifests> {
  const refs = await readYaml(path.join(root, "shared", "refs.yml"), refsManifestSchema, {
    references: [],
  });
  const skills = await readYaml(path.join(root, "shared", "skills.yml"), skillsManifestSchema, {
    skills: [],
  });
  const mcp = await readYaml(path.join(root, "shared", "mcp.yml"), mcpManifestSchema, {
    servers: {},
  });
  const effectiveHome = home ?? process.env.HOME;
  const machine = effectiveHome
    ? await readYaml(path.join(effectiveHome, ".mindframe-z", "config.yml"), machineSchema, {
        references_dir: "~/references",
        opencode: {},
      })
    : { references_dir: "~/references" as const, opencode: {} };
  const profileMap = new Map<string, ProfileManifest>();
  const profilesDir = path.join(root, "profiles");
  try {
    for (const entry of await readdir(profilesDir)) {
      const fullPath = path.join(profilesDir, entry);
      let stat;
      try {
        stat = await lstat(fullPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const profileYaml = path.join(fullPath, "profile.yml");
      if (!(await exists(profileYaml))) continue;
      const profile = await readYaml(profileYaml, profileSchema, {
        name: entry,
        targets: ["opencode", "claude-code"],
        instructions: [],
        references: [],
        skills: [],
        mcp: {},
        opencode: {},
        opencode_plugins: [],
        claude: { settings: {} },
        mise: { tools: {}, env: {}, tool_alias: {} },
        dotfiles: {},
        description: "",
      });

      const miseToml = path.join(fullPath, "mise.toml");
      if (await exists(miseToml)) {
        try {
          const raw = await readFile(miseToml, "utf8");
          const toml = miseTomlSchema.parse(parse(raw));
          profile.mise.tools = toml.tools;
          profile.mise.env = toml.env;
          profile.mise.tool_alias = toml.tool_alias;
        } catch {
          // Malformed TOML — skip, keep YAML defaults
        }
      }

      for (const f of await readdir(fullPath)) {
        if (f === "profile.yml" || f === "mise.toml") continue;
        const content = await readFile(path.join(fullPath, f), "utf8");
        profile.dotfiles[f] = content;
      }

      profileMap.set(profile.name, profile);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    references: refs.references,
    skills: skills.skills,
    mcpServers: mcp.servers,
    profiles: profileMap,
    machine,
  };
}
