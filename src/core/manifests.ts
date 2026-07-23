import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import YAML from "yaml";
import { z } from "zod";
import { pathExists } from "./fs-util.js";
import { resolveUpstreamHomeRoot } from "./upstream-clones.js";

export const agentSchema = z.enum(["opencode", "claude-code", "codex", "pi"]);
const targetSchema = agentSchema;
const agentsMapSchema = z
  .partialRecord(agentSchema, z.boolean())
  .refine((agents) => Object.keys(agents).length > 0, {
    message: "agents must contain at least one harness"
  });
const mcpAgentSchema = z.enum(["opencode", "claude-code", "codex"]);
const mcpDisabledAgentSchema = mcpAgentSchema.exclude(["claude-code"]);
type McpAgentName = z.infer<typeof mcpAgentSchema>;
type NormalizedMcpAgents = Partial<Record<McpAgentName, boolean>>;
export const executorConnectionNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "must be a lowercase address-safe Executor connection name without dots, hyphens, or punctuation"
  );
const executorConnectionMapSchema = z
  .record(executorConnectionNameSchema, z.string().min(1))
  .refine((connections) => Object.keys(connections).length > 0, {
    message: "connections must contain at least one named connection"
  });

const conciseMcpAgentsSchema = z
  .array(mcpAgentSchema)
  .min(1)
  .refine((agents) => new Set(agents).size === agents.length, {
    message: "agents must not contain duplicate harnesses"
  });
const conciseDisabledMcpAgentsSchema = z
  .array(mcpDisabledAgentSchema)
  .min(1)
  .refine((agents) => new Set(agents).size === agents.length, {
    message: "agents must not contain duplicate harnesses"
  });
const groupedMcpAgentsSchema = z
  .union([
    z
      .object({
        enabled: conciseMcpAgentsSchema,
        disabled: conciseDisabledMcpAgentsSchema.optional()
      })
      .strict(),
    z
      .object({
        enabled: conciseMcpAgentsSchema.optional(),
        disabled: conciseDisabledMcpAgentsSchema
      })
      .strict()
  ])
  .superRefine((agents, context) => {
    const enabled = agents.enabled ?? [];
    const disabled = agents.disabled ?? [];
    const conflict = disabled.find((agent) => enabled.includes(agent));
    if (conflict) {
      context.addIssue({
        code: "custom",
        message: `harness ${conflict} cannot be both enabled and disabled`,
        path: ["enabled"]
      });
    }
  });
const directMcpAgentsSchema = z
  .union([conciseMcpAgentsSchema, groupedMcpAgentsSchema])
  .transform((agents): NormalizedMcpAgents => {
    const normalized: NormalizedMcpAgents = {};
    if (Array.isArray(agents)) {
      for (const agent of agents) normalized[agent] = true;
      return normalized;
    }
    for (const agent of agents.enabled ?? []) normalized[agent] = true;
    for (const agent of agents.disabled ?? []) normalized[agent] = false;
    return normalized;
  });
const profileMcpConfigSchema = z.union([
  z
    .object({
      route: z.literal("direct").optional(),
      agents: directMcpAgentsSchema
    })
    .strict()
    .transform(({ agents }) => ({ route: "direct" as const, agents })),
  z
    .object({
      route: z.literal("executor"),
      connections: executorConnectionMapSchema.optional()
    })
    .strict()
]);
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

export const homeManifestSchema = z
  .object({
    description: z.string().optional(),
    extends: z
      .object({
        name: z.string().min(1),
        repo: z.string().min(1)
      })
      .strict()
      .optional()
  })
  .strict();

const skillNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe skill directory name");

const skillPathSchema = z
  .string()
  .min(1)
  .regex(
    /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\/\/)(?!.*(?:^|\/)\.git(?:\/|$)).+$/i,
    "must be a relative POSIX path"
  )
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "must be a relative POSIX path without empty, . or .. segments"
  )
  .refine(
    (value) =>
      value.split("/").every(
        (part) =>
          !part.endsWith(".") &&
          !part.endsWith(" ") &&
          ![...part].some((character) => {
            const code = character.charCodeAt(0);
            return code < 0x20 || '<>:"|?*'.includes(character);
          }) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part) &&
          part.toLowerCase() !== ".git"
      ),
    "must contain portable path components"
  );

const httpsRepositorySchema = z
  .string()
  .url()
  .regex(/^https:\/\/(?![^/]*@)\S+$/, "must use HTTPS without credentials or whitespace")
  .refine((value) => value.trim() === value && !/\s/u.test(value), "must not contain whitespace")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "must be an HTTPS repository URL without credentials");

function safeGitRef(value: string): boolean {
  return !value.startsWith("-") && [...value].every((character) => character.charCodeAt(0) > 32);
}

const skillFields = {
  name: skillNameSchema,
  description: z.string().default("")
};

const localSkillSchema = z
  .object({
    ...skillFields,
    source: z.literal("local"),
    skill: skillPathSchema.optional()
  })
  .strict();

const vendoredSkillSchema = z
  .object({
    ...skillFields,
    source: z.literal("vendored"),
    repo: httpsRepositorySchema,
    ref: z
      .string()
      .min(1)
      .regex(/^(?!-)(?!.*\s).+$/, "must not start with an option marker or contain whitespace")
      .refine(safeGitRef, "must be a Git ref without option or whitespace characters"),
    subtree: skillPathSchema
  })
  .strict();

export const skillSchema = z.discriminatedUnion("source", [localSkillSchema, vendoredSkillSchema]);

export const vendorLockEntrySchema = z
  .object({
    commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase Git commit SHA"),
    digest: z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 content digest")
  })
  .strict();

export const vendorLockSchema = z
  .object({
    skills: z.record(skillNameSchema, vendorLockEntrySchema).default({})
  })
  .strict();

export const skillsManifestSchema = z.object({
  skills: z.array(skillSchema).default([])
});

const mcpServerBaseSchema = z
  .object({
    description: z.string().default(""),
    type: z.enum(["remote", "local"]),
    transport: z.enum(["http", "sse", "stdio"]).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    executor: z
      .object({
        transport: z.enum(["auto", "streamable-http", "sse"]).optional(),
        authentication: z
          .array(
            z.union([
              z.object({ slug: z.literal("none"), kind: z.literal("none") }).strict(),
              z
                .object({
                  slug: z.string().min(1),
                  kind: z.literal("oauth2"),
                  discoveryUrl: z.string().url().optional(),
                  registrationScopes: z.array(z.string().min(1)).min(1).optional()
                })
                .strict()
                .superRefine((method, context) => {
                  const hasDiscoveryUrl = method.discoveryUrl !== undefined;
                  const hasRegistrationScopes = method.registrationScopes !== undefined;
                  if (hasDiscoveryUrl !== hasRegistrationScopes) {
                    context.addIssue({
                      code: "custom",
                      message: "assisted OAuth requires both discoveryUrl and registrationScopes"
                    });
                  }
                }),
              z
                .object({
                  slug: z.string().min(1),
                  kind: z.literal("apikey"),
                  placements: z
                    .array(
                      z
                        .object({
                          carrier: z.enum(["header", "query"]),
                          name: z.string().min(1),
                          variable: z.string().min(1),
                          prefix: z.string().optional()
                        })
                        .strict()
                    )
                    .min(1)
                })
                .strict()
            ])
          )
          .min(1)
          .superRefine((methods, context) => {
            const seen = new Set<string>();
            for (const [index, method] of methods.entries()) {
              if (seen.has(method.slug)) {
                context.addIssue({
                  code: "custom",
                  message: `authentication method slug ${method.slug} must be unique`,
                  path: [index, "slug"]
                });
              }
              seen.add(method.slug);
            }
          })
          .optional()
      })
      .strict()
      .optional()
  })
  .strict();

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

const delegateGeneralModelSchema = z.object({
  id: z.string().min(1),
  variants: z.array(z.string().min(1)).min(1),
  description: z.string().min(1).optional()
});

const delegateGeneralSchema = z.object({
  models: z.array(delegateGeneralModelSchema).default([])
});

export type DelegateGeneralConfig = z.infer<typeof delegateGeneralSchema>;

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
  path: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !path.isAbsolute(value) &&
        !value
          .split(/[\\/]+/)
          .some((segment) => segment === "" || segment === "." || segment === ".."),
      "must be a relative path without empty, . or .. segments"
    )
    .optional(),
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

const exactVersionSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be an exact semantic version"
  );

const opencodeConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  dependencies: z.record(z.string().min(1), exactVersionSchema).default({}),
  plugins: z.array(z.string()).default([]),
  tui: z.record(z.string(), z.unknown()).default({}),
  tui_plugins: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  delegate_general: delegateGeneralSchema.optional()
});

export const codexPluginSchema = z.object({
  enabled: z.boolean(),
  toggleable: z.boolean().optional()
});

const codexConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  plugins: z.record(z.string(), codexPluginSchema).default({})
});

const piConfigSchema = z.object({
  settings: z.record(z.string(), z.unknown()).default({}),
  subagent_config: z.record(z.string(), z.unknown()).default({})
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
    executor: z
      .object({
        elicitation: z.literal("browser").optional(),
        timeout_ms: z.number().int().positive().optional()
      })
      .strict()
      .optional(),
    opencode: opencodeConfigSchema.default({
      config: {},
      dependencies: {},
      plugins: [],
      tui: {},
      tui_plugins: [],
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
    pi: piConfigSchema.default({ settings: {}, subagent_config: {} }),
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
  home_path: z.string().optional(),
  references_dir: z.string().default("~/.mindframe-z/references"),
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
export type VendorLock = z.infer<typeof vendorLockSchema>;
export type VendorLockEntry = z.infer<typeof vendorLockEntrySchema>;
export type ToolTargetName = z.infer<typeof targetSchema>;
export type ProfileAgentDefaults = Partial<Record<ToolTargetName, boolean>>;
export type ProfileMcpConfig = z.infer<typeof profileMcpConfigSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type ExecutorAuthenticationMethod = NonNullable<
  NonNullable<NonNullable<McpServer["executor"]>["authentication"]>[number]
>;
export type ExecutorConnectionMap = z.infer<typeof executorConnectionMapSchema>;
export type ProfileManifest = z.infer<typeof profileSchema>;
export type MachineManifest = z.infer<typeof machineSchema>;
export type HomeManifest = z.infer<typeof homeManifestSchema>;
export type Archive = z.infer<typeof archiveSchema>;
export type SandboxCredentialMode = z.infer<typeof sandboxCredentialModeSchema>;
export type ThreadDestination = z.infer<typeof threadDestinationSchema>;
export type ThreadDefaults = z.infer<typeof threadDefaultsSchema>;
export type ThreadHarness = z.infer<typeof threadHarnessSchema>;

export interface LoadedManifests {
  homeManifest: HomeManifest;
  root: string;
  aliasPath: string[];
  upstream?: LoadedManifests;
  references: ReferenceEntry[];
  skills: SkillEntry[];
  mcpServers: Record<string, McpServer>;
  profiles: Map<string, ProfileManifest>;
  machine: MachineManifest;
}

export function eachUpstream(manifests: LoadedManifests): LoadedManifests[] {
  return manifests.upstream ? [manifests.upstream, ...eachUpstream(manifests.upstream)] : [];
}

export function homeDisplayName(home: LoadedManifests): string {
  return home.aliasPath.length > 0 ? home.aliasPath.join("/") : "local";
}

export interface ManifestValidationResult {
  file: string;
  ok: boolean;
  error?: string;
}

async function parseYaml<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(YAML.parse(await readFile(file, "utf8")));
}

export async function readYaml<T>(file: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  if (!(await pathExists(file))) return fallback;
  return parseYaml(file, schema);
}

function machineConfigPath(home: string): string {
  return path.join(home, ".mindframe-z", "config.yml");
}

function machineDefaults(): MachineManifest {
  return machineSchema.parse({});
}

// Every direct child of `<root>/profiles` that is a real directory. `lstat` keeps
// symlinked entries out, and a missing `profiles/` dir means "no profiles" rather
// than an error. Owning the tolerated-ENOENT here keeps it off the callers, whose
// own reads should surface their failures.
async function listProfileDirs(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(root, "profiles"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, "profiles", entry);
    try {
      if ((await lstat(fullPath)).isDirectory()) dirs.push(fullPath);
    } catch {
      continue;
    }
  }
  return dirs;
}

async function validateYamlFile<T>(
  file: string,
  schema: z.ZodType<T>
): Promise<ManifestValidationResult | null> {
  if (!(await pathExists(file))) return null;
  try {
    await parseYaml(file, schema);
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
    { file: path.join(root, "mfz_home.yml"), schema: homeManifestSchema },
    { file: path.join(root, "catalog", "references.yml"), schema: refsManifestSchema },
    { file: path.join(root, "catalog", "skills.yml"), schema: skillsManifestSchema },
    { file: path.join(root, "catalog", "mcp.yml"), schema: mcpManifestSchema },
    { file: path.join(root, "skills", "vendor.lock.yml"), schema: vendorLockSchema }
  ];

  const effectiveHome = home ?? process.env.HOME;
  if (effectiveHome) {
    files.push({ file: machineConfigPath(effectiveHome), schema: machineSchema });
  }

  for (const dir of await listProfileDirs(root)) {
    files.push({ file: path.join(dir, "profile.yml"), schema: profileSchema });
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
  if (!(await pathExists(path.join(root, "mfz_home.yml")))) {
    throw new Error(
      `Missing mfz_home.yml at ${root}. Run mfz init or point MFZ_ROOT/home_path at a mindframe-z home.`
    );
  }
  const homeManifest = await parseYaml(path.join(root, "mfz_home.yml"), homeManifestSchema);
  const effectiveHome = home ?? process.env.HOME ?? "";
  const upstream = homeManifest.extends
    ? await loadManifests(
        await resolveUpstreamHomeRoot({
          home: effectiveHome,
          alias: homeManifest.extends.name,
          repo: homeManifest.extends.repo
        }),
        home
      )
    : undefined;
  const refs = await readYaml(path.join(root, "catalog", "references.yml"), refsManifestSchema, {
    references: []
  });
  const skills = await readYaml(path.join(root, "catalog", "skills.yml"), skillsManifestSchema, {
    skills: []
  });
  const mcp = await readYaml(path.join(root, "catalog", "mcp.yml"), mcpManifestSchema, {
    servers: {}
  });
  const machine = effectiveHome
    ? await readYaml(machineConfigPath(effectiveHome), machineSchema, machineDefaults())
    : machineDefaults();
  const profileMap = new Map<string, ProfileManifest>();
  for (const profileDir of await listProfileDirs(root)) {
    const profileYaml = path.join(profileDir, "profile.yml");
    if (!(await pathExists(profileYaml))) continue;
    const profile = await parseYaml(profileYaml, profileSchema);

    const miseToml = path.join(profileDir, "mise.toml");
    if (await pathExists(miseToml)) {
      try {
        const toml = miseTomlSchema.parse(parse(await readFile(miseToml, "utf8")));
        profile.mise.tools = toml.tools;
        profile.mise.env = toml.env;
        profile.mise.tool_alias = toml.tool_alias;
        profile.mise.settings = toml.settings;
      } catch {
        // Malformed TOML — skip, keep YAML defaults
      }
    }

    for (const [rel, content] of await readDotfileEntries(profileDir)) {
      profile.dotfiles[rel] = content;
    }

    profileMap.set(profile.name, profile);
  }
  return {
    homeManifest,
    root,
    aliasPath: [],
    ...(upstream ? { upstream: withAliasPrefix(upstream, homeManifest.extends!.name) } : {}),
    references: refs.references,
    skills: skills.skills,
    mcpServers: mcp.servers,
    profiles: profileMap,
    machine
  };
}

function withAliasPrefix(manifests: LoadedManifests, alias: string): LoadedManifests {
  return {
    ...manifests,
    aliasPath: [alias, ...manifests.aliasPath],
    ...(manifests.upstream ? { upstream: withAliasPrefix(manifests.upstream, alias) } : {})
  };
}
