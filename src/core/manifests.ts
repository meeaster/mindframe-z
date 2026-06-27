import { access, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import YAML from "yaml";
import { z } from "zod";

export const agentSchema = z.enum(["opencode", "claude-code"]);
const targetSchema = agentSchema;
const skillTargetSchema = z.enum(["opencode", "claude-code", "all"]);
const profileMcpConfigSchema = z.object({
  targets: z.array(targetSchema).min(1).optional(),
  enabled: z.boolean()
});
const profileSkillTargetsSchema = z
  .array(skillTargetSchema)
  .refine((targets) => !targets.includes("all") || targets.length === 1, {
    message: "Use either [all] or explicit skill targets, not both"
  });
const profileSkillConfigSchema = z.object({
  enabled: z.boolean().default(true),
  toggleable: z.boolean().default(true),
  targets: profileSkillTargetsSchema.optional()
});

export const referenceSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  description: z.string().default("")
});

export const refsManifestSchema = z.object({
  references: z.array(referenceSchema).default([])
});

export const skillSchema = z.object({
  name: z.string().min(1),
  source: z.enum(["local", "git"]),
  repo: z.string().optional(),
  skill: z.string().optional(),
  description: z.string().default(""),
  installer: z.literal("skills").default("skills")
});

export const skillsManifestSchema = z.object({
  skills: z.array(skillSchema).default([])
});

const mcpServerBaseSchema = z.object({
  description: z.string().default(""),
  type: z.enum(["remote", "local"]),
  transport: z.enum(["http", "sse", "stdio"]).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional()
});

export const mcpServerSchema = z.union([
  mcpServerBaseSchema.extend({ type: z.literal("remote"), url: z.string().min(1) }),
  mcpServerBaseSchema.extend({ type: z.literal("local"), command: z.array(z.string()).min(1) })
]);

export const mcpManifestSchema = z.object({
  servers: z.record(z.string(), mcpServerSchema).default({})
});

const miseToolValueSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

export const extraFolderSchema = z.object({
  path: z.string().min(1),
  description: z.string().default(""),
  read: z.enum(["allow", "ask", "deny"]).default("allow"),
  edit: z.enum(["allow", "ask", "deny"]).default("allow")
});

const miseTomlSchema = z.object({
  tools: z.record(z.string(), miseToolValueSchema).default({}),
  env: z.record(z.string(), z.coerce.string()).default({}),
  tool_alias: z.record(z.string(), z.coerce.string()).default({}),
  settings: z.record(z.string(), z.unknown()).default({})
});

const agentTaskModelSchema = z.object({
  name: z.string().min(1),
  variants: z.array(z.string()).optional(),
  default_variant: z.string().optional(),
  providers: z.array(z.string()).min(1)
});

const agentTaskAgentSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().optional()
});

const agentTaskSchema = z.object({
  models: z.array(agentTaskModelSchema).default([]),
  agents: z.array(agentTaskAgentSchema).default([])
});

export type AgentTaskConfig = z.infer<typeof agentTaskSchema>;

const opencodeConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  plugins: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  agent_task: agentTaskSchema.optional()
});

export const profileSchema = z
  .object({
    name: z.string().min(1),
    extends: z.string().optional(),
    description: z.string().default(""),
    agents: z.array(agentSchema).default(["opencode", "claude-code"]),
    instructions: z.array(z.string()).default([]),
    references: z.array(z.string()).default([]),
    skills: z
      .record(
        z.string(),
        z.union([profileSkillConfigSchema, profileSkillTargetsSchema, z.null()]).optional()
      )
      .default({}),
    mcp: z.record(z.string(), profileMcpConfigSchema).default({}),
    opencode: opencodeConfigSchema.default({
      config: {},
      plugins: [],
      commands: [],
      agents: []
    }),
    claude: z
      .object({
        model: z.string().optional(),
        settings: z.record(z.string(), z.unknown()).default({})
      })
      .default({ settings: {} }),
    mise: z
      .object({
        tools: z.record(z.string(), miseToolValueSchema).default({}),
        env: z.record(z.string(), z.string()).default({}),
        tool_alias: z.record(z.string(), z.string()).default({}),
        settings: z.record(z.string(), z.unknown()).default({})
      })
      .default({ tools: {}, env: {}, tool_alias: {}, settings: {} }),
    dotfiles: z.record(z.string(), z.string()).default({}),
    extra_folders: z.array(extraFolderSchema).default([])
  })
  .strict();

export const sandboxCredentialModeSchema = z.enum(["bedrock", "subscription"]);

export const machineSchema = z.object({
  profile: z.string().optional(),
  repo_path: z.string().optional(),
  references_dir: z.string().default("~/references"),
  extra_folders: z.array(extraFolderSchema).default([]),
  git: z
    .object({
      name: z.string().optional(),
      email: z.string().optional()
    })
    .default({}),
  sandbox: z
    .object({
      credentials: sandboxCredentialModeSchema.optional()
    })
    .default({}),
  opencode: z.record(z.string(), z.unknown()).default({})
});

export type ExtraFolder = z.infer<typeof extraFolderSchema>;
export type ReferenceEntry = z.infer<typeof referenceSchema>;
export type SkillEntry = z.infer<typeof skillSchema>;
export type ToolTargetName = z.infer<typeof targetSchema>;
export type ProfileSkillTarget = z.infer<typeof skillTargetSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type ProfileManifest = z.infer<typeof profileSchema>;
export type MachineManifest = z.infer<typeof machineSchema>;
export type SandboxCredentialMode = z.infer<typeof sandboxCredentialModeSchema>;

export interface LoadedManifests {
  references: ReferenceEntry[];
  skills: SkillEntry[];
  mcpServers: Record<string, McpServer>;
  profiles: Map<string, ProfileManifest>;
  machine: MachineManifest;
}

export interface ManifestValidationResult {
  file: string;
  ok: boolean;
  error?: string;
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

async function validateYamlFile<T>(
  file: string,
  schema: z.ZodType<T>
): Promise<ManifestValidationResult | null> {
  if (!(await exists(file))) return null;
  try {
    schema.parse(YAML.parse(await readFile(file, "utf8")));
    return { file, ok: true };
  } catch (error) {
    return { file, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function validateManifests(
  root: string,
  home?: string
): Promise<ManifestValidationResult[]> {
  const files: Array<{ file: string; schema: z.ZodType }> = [
    { file: path.join(root, "shared", "refs.yml"), schema: refsManifestSchema },
    { file: path.join(root, "shared", "skills.yml"), schema: skillsManifestSchema },
    { file: path.join(root, "shared", "mcp.yml"), schema: mcpManifestSchema }
  ];

  const effectiveHome = home ?? process.env.HOME;
  if (effectiveHome) {
    files.push({
      file: path.join(effectiveHome, ".mindframe-z", "config.yml"),
      schema: machineSchema
    });
  }

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
      if (stat.isDirectory()) {
        files.push({ file: path.join(fullPath, "profile.yml"), schema: profileSchema });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const results: ManifestValidationResult[] = [];
  for (const entry of files) {
    const result = await validateYamlFile(entry.file, entry.schema);
    if (result) results.push(result);
  }
  return results;
}

async function readDotfileEntries(dir: string, prefix = ""): Promise<Array<[string, string]>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: Array<[string, string]> = [];
  for (const entry of entries) {
    if (entry.name === "profile.yml" || entry.name === "mise.toml") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [childRel, content] of await readDotfileEntries(full, rel)) {
        result.push([childRel, content]);
      }
    } else if (entry.isFile()) {
      result.push([rel, await readFile(full, "utf8")]);
    }
  }
  return result;
}

export async function loadManifests(root: string, home?: string): Promise<LoadedManifests> {
  const refs = await readYaml(path.join(root, "shared", "refs.yml"), refsManifestSchema, {
    references: []
  });
  const skills = await readYaml(path.join(root, "shared", "skills.yml"), skillsManifestSchema, {
    skills: []
  });
  const mcp = await readYaml(path.join(root, "shared", "mcp.yml"), mcpManifestSchema, {
    servers: {}
  });
  const effectiveHome = home ?? process.env.HOME;
  const machine = effectiveHome
    ? await readYaml(path.join(effectiveHome, ".mindframe-z", "config.yml"), machineSchema, {
        references_dir: "~/references",
        extra_folders: [],
        git: {},
        sandbox: {},
        opencode: {}
      })
    : {
        references_dir: "~/references" as const,
        extra_folders: [],
        git: {},
        sandbox: {},
        opencode: {}
      };
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
        agents: ["opencode", "claude-code"],
        instructions: [],
        references: [],
        skills: {},
        mcp: {},
        opencode: { config: {}, plugins: [], commands: [], agents: [] },
        claude: { settings: {} },
        mise: { tools: {}, env: {}, tool_alias: {}, settings: {} },
        dotfiles: {},
        extra_folders: [],
        description: ""
      });

      const miseToml = path.join(fullPath, "mise.toml");
      if (await exists(miseToml)) {
        try {
          const raw = await readFile(miseToml, "utf8");
          const toml = miseTomlSchema.parse(parse(raw));
          profile.mise.tools = toml.tools;
          profile.mise.env = toml.env;
          profile.mise.tool_alias = toml.tool_alias;
          profile.mise.settings = toml.settings;
        } catch {
          // Malformed TOML — skip, keep YAML defaults
        }
      }

      for (const [rel, content] of await readDotfileEntries(fullPath)) {
        profile.dotfiles[rel] = content;
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
    machine
  };
}
