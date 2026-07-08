import { access, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import YAML from "yaml";
import { z } from "zod";

export const agentSchema = z.enum(["opencode", "claude-code", "codex"]);
const targetSchema = agentSchema;
const agentsMapSchema = z
  .partialRecord(agentSchema, z.boolean())
  .refine((agents) => Object.keys(agents).length > 0, {
    message: "agents must contain at least one harness"
  });
const profileMcpConfigSchema = z
  .object({
    agents: agentsMapSchema
  })
  .strict()
  .refine((config) => config.agents["claude-code"] !== false, {
    message: "MCP entries cannot set claude-code to false"
  });
const profileSkillConfigSchema = z
  .object({
    agents: agentsMapSchema.optional(),
    toggleable: z.boolean().default(true)
  })
  .strict();

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
  // Upstream URL when the folder is a git clone — surfaced in a thread digest's Sources so a
  // reader can reopen it. Optional: many extra folders (mounts, config dirs) have no upstream.
  url: z.string().optional(),
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

export const threadHarnessSchema = z.enum(["claude-code", "opencode"]);

// Bounded identifier for thread slugs and destination names: lowercase alnum
// start, then alnum plus . _ - — no path separators, no leading dot. The
// leading-alnum rule already excludes bare "." / ".." and any "/" or "\".
export const threadIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "must be lowercase alphanumeric with . _ - and no path separators"
  );

export const threadDestinationSchema = z.object({
  name: threadIdentifierSchema,
  remote: z.string().optional(),
  no_push: z.boolean().default(false),
  default: z.boolean().default(false)
});

// A session archive: an S3 destination for raw, full-fidelity session backups,
// sibling to thread `destinations` (which back up the *synthesized* store). Exactly
// one archive is `default: true` and writable; the rest are read-only sources a
// consumer may hydrate from. Creds resolve via the SDK default provider chain,
// optionally pinned to a named `profile`. mfz never stores a secret here.
export const archiveSchema = z.object({
  name: threadIdentifierSchema,
  bucket: z.string().min(1),
  region: z.string().min(1),
  profile: z.string().optional(),
  prefix: z.string().default(""),
  default: z.boolean().default(false)
});

export const sandboxCredentialModeSchema = z.enum(["bedrock", "subscription"]);

export const threadDefaultsSchema = z.object({
  discover: z.string().optional(),
  gather: z.string().optional(),
  synthesize: z.string().optional(),
  triage: z.string().optional(),
  quiescence_minutes: z.number().nonnegative().optional(),
  // Omitted digest inherits the resolved synthesize model (see
  // resolveSynthesisDefaults) so existing profiles keep their current behavior.
  digest: z.string().optional(),
  // Optional through parse/merge so an omitting child inherits the parent value
  // instead of clobbering it with an auto-filled default. Defaulted at point of
  // use in `resolveSessionSources`.
  session_sources: z.array(threadHarnessSchema).optional()
});

const profileThreadSchema = z
  .object({
    destinations: z.array(threadDestinationSchema).default([]),
    defaults: threadDefaultsSchema.default({}),
    // How a changed session is refreshed during ingest. "full" re-reads and
    // re-synthesizes the whole session (best fidelity, cheap even worst-case);
    // "delta" reads only messages after the stored watermark and revises the
    // prior session file. Behavior mode, not a model selection, so it sits
    // beside `defaults` rather than inside them. Global-only for now.
    // Left optional (no parse-time default) so a child profile that omits it
    // inherits the parent's value rather than clobbering it with a filled-in
    // default; the "full" default is applied at consumption in ingest.
    update_strategy: z.enum(["full", "delta"]).optional(),
    // How thread dispatch containers authenticate to the model provider.
    // "subscription" mounts the Claude OAuth token (the default, unchanged
    // behavior); "bedrock" runs the operator's credential-process refresh and
    // mounts scoped AWS creds. Explicit per profile so it never silently
    // changes based on ambient host state.
    credentials: sandboxCredentialModeSchema.default("subscription")
  })
  .default({
    destinations: [],
    defaults: {},
    credentials: "subscription"
  });

const machineThreadSchema = z
  .object({
    destinations: z.array(threadDestinationSchema).default([])
  })
  .default({ destinations: [] });

const opencodeConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  plugins: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  agent_task: agentTaskSchema.optional()
});

export const codexPluginSchema = z.object({
  enabled: z.boolean(),
  toggleable: z.boolean().optional()
});

const codexConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  plugins: z.record(z.string(), codexPluginSchema).default({})
});

export const profileSchema = z
  .object({
    name: z.string().min(1),
    extends: z.string().optional(),
    description: z.string().default(""),
    agents: z.array(agentSchema).default(["opencode", "claude-code", "codex"]),
    instructions: z.array(z.string()).default([]),
    references: z.array(z.string()).default([]),
    skills: z.record(z.string(), profileSkillConfigSchema.optional()).default({}),
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
    codex: codexConfigSchema.default({ config: {}, plugins: {} }),
    mise: z
      .object({
        tools: z.record(z.string(), miseToolValueSchema).default({}),
        env: z.record(z.string(), z.string()).default({}),
        tool_alias: z.record(z.string(), z.string()).default({}),
        settings: z.record(z.string(), z.unknown()).default({})
      })
      .default({ tools: {}, env: {}, tool_alias: {}, settings: {} }),
    thread: profileThreadSchema,
    dotfiles: z.record(z.string(), z.string()).default({}),
    extra_folders: z.array(extraFolderSchema).default([])
  })
  .strict();

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
  thread: machineThreadSchema,
  archives: z.array(archiveSchema).default([]),
  opencode: z.record(z.string(), z.unknown()).default({}),
  claude: z.record(z.string(), z.unknown()).default({})
});

export type ExtraFolder = z.infer<typeof extraFolderSchema>;
export type ReferenceEntry = z.infer<typeof referenceSchema>;
export type SkillEntry = z.infer<typeof skillSchema>;
export type ToolTargetName = z.infer<typeof targetSchema>;
export type ProfileAgentDefaults = Partial<Record<ToolTargetName, boolean>>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type ProfileManifest = z.infer<typeof profileSchema>;
export type MachineManifest = z.infer<typeof machineSchema>;
export type Archive = z.infer<typeof archiveSchema>;
export type SandboxCredentialMode = z.infer<typeof sandboxCredentialModeSchema>;
export type ThreadDestination = z.infer<typeof threadDestinationSchema>;
export type ThreadDefaults = z.infer<typeof threadDefaultsSchema>;
export type ThreadHarness = z.infer<typeof threadHarnessSchema>;

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
        thread: { destinations: [] },
        archives: [],
        opencode: {},
        claude: {}
      })
    : {
        references_dir: "~/references" as const,
        extra_folders: [],
        git: {},
        sandbox: {},
        thread: { destinations: [] },
        archives: [],
        opencode: {},
        claude: {}
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
        agents: ["opencode", "claude-code", "codex"],
        instructions: [],
        references: [],
        skills: {},
        mcp: {},
        opencode: { config: {}, plugins: [], commands: [], agents: [] },
        claude: { settings: {} },
        codex: { config: {}, plugins: {} },
        mise: { tools: {}, env: {}, tool_alias: {}, settings: {} },
        thread: {
          destinations: [],
          defaults: {},
          credentials: "subscription"
        },
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
