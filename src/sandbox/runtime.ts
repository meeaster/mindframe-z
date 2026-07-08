import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gitIdentityFragmentPath } from "../core/git-config.js";
import { expandHome, profileConfigsDir, type RuntimePaths } from "../core/paths.js";
import {
  filterMcpForTarget,
  type ResolvedMcpServer,
  type ResolvedProfile
} from "../core/profile.js";
import { resolveSandboxCredentialMode, sandboxCaFile, sandboxVaultName } from "./config.js";

export type SandboxLaunchTarget = "shell" | "cc" | "oc";
export type SandboxMountMode = "ro" | "rw";

export interface SandboxMount {
  readonly source: string;
  readonly target: string;
  readonly mode: SandboxMountMode;
}

export interface SandboxServiceDefinition {
  readonly name: string;
  readonly image: string;
  readonly command: string[];
  readonly environment: Record<string, string>;
  readonly ports: string[];
  readonly volumes: string[];
}

export interface SandboxRuntimeInputs {
  readonly credentialMode: "bedrock" | "subscription" | undefined;
  readonly services: SandboxServiceDefinition[];
  readonly mounts: SandboxMount[];
  readonly env: Record<string, string>;
  readonly noProxy: string[];
  readonly mcp: SandboxMcpRuntimeConfig;
  readonly dockerRunArgs: string[];
}

export interface SandboxMcpShimDefinition {
  readonly port: number;
  readonly upstream: string;
  readonly vault: string;
  readonly oauth: { readonly key: string };
}

export interface SandboxMcpRuntimeConfig {
  readonly broker: {
    readonly basePort: number;
    readonly shims: Record<string, SandboxMcpShimDefinition>;
  };
  readonly opencode: Record<string, unknown>;
  readonly claude: Record<string, unknown>;
}

const containerHome = "/home/sandbox";
const containerMindframeDir = path.posix.join(containerHome, ".mindframe-z");
const containerReferencesDir = "/references";
const containerExtraDir = "/extra";
const agentVaultApiPort = "14321";
const agentVaultMitmPort = "14322";
const bedrockProxyPort = "8080";
const bedrockRegion = "us-west-2";
const caPath = "/etc/agent-vault/mitm-ca.pem";
const mcpShimBasePort = 17301;

function sandboxStateDir(paths: RuntimePaths, profile: ResolvedProfile): string {
  return path.join(paths.home, ".mindframe-z", "sandbox", profile.name);
}

function sandboxRuntimeDir(paths: RuntimePaths, profile: ResolvedProfile): string {
  return path.join(sandboxStateDir(paths, profile), "runtime");
}

function slugPath(value: string): string {
  return (
    path
      .basename(value)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "folder"
  );
}

function extraFolderMounts(paths: RuntimePaths, profile: ResolvedProfile): SandboxMount[] {
  const used = new Map<string, number>();
  const hostMindframeDir = path.join(paths.home, ".mindframe-z");
  return profile.extraFolders.flatMap((folder) => {
    if (folder.read !== "allow") return [];
    const source = expandHome(folder.path, paths.home);
    if (source === hostMindframeDir) return [];
    const baseSlug = slugPath(source);
    const count = used.get(baseSlug) ?? 0;
    used.set(baseSlug, count + 1);
    const slug = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
    return [
      {
        source,
        target: path.posix.join(containerExtraDir, slug),
        mode: folder.edit === "allow" ? ("rw" as const) : ("ro" as const)
      }
    ];
  });
}

function pathReplacements(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  extraMounts: readonly SandboxMount[]
): [string, string][] {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const replacements: [string, string][] = [
    [path.join(configsProfile, "AGENTS.md"), path.posix.join(containerMindframeDir, "AGENTS.md")],
    [path.join(paths.home, ".mindframe-z"), containerMindframeDir],
    [profile.referencesDir, containerReferencesDir]
  ];
  for (const mount of extraMounts) replacements.push([mount.source, mount.target]);
  return replacements.sort((a, b) => b[0].length - a[0].length);
}

function rewriteSandboxPaths(content: string, replacements: readonly [string, string][]): string {
  let next = content;
  for (const [hostPath, containerPath] of replacements) {
    next = next.split(hostPath).join(containerPath);
  }
  return next;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function renderSandboxReferencesIndex(
  runtimeDir: string,
  profile: ResolvedProfile
): Promise<void> {
  const lines = [
    "# Enabled References",
    "",
    "Reference repositories are cloned git repos providing documentation, code, and context for AI agents. They are read-only snapshots — do not edit, modify, reorganize, or write to any file within a reference path. If you need to change reference content, ask the user to update the upstream repo.",
    ""
  ];
  for (const ref of profile.enabledReferences) {
    lines.push(
      `- \`${ref.name}\`: ${ref.description} Path: \`${path.posix.join(containerReferencesDir, ref.name)}\`.`
    );
  }
  lines.push("");
  await writeFile(path.join(runtimeDir, "mindframe-z", "references.md"), lines.join("\n"), "utf8");
}

async function renderSandboxExtraFoldersIndex(
  paths: RuntimePaths,
  runtimeDir: string,
  profile: ResolvedProfile,
  extraMounts: readonly SandboxMount[]
): Promise<void> {
  const indexPath = path.join(runtimeDir, "mindframe-z", "extra_folders.md");
  if (extraMounts.length === 0) {
    await writeFile(
      indexPath,
      "# Extra Folders\n\nNo extra folders are mounted in this sandbox.\n",
      "utf8"
    );
    return;
  }

  const bySource = new Map(extraMounts.map((mount) => [mount.source, mount]));
  const lines = [
    "# Extra Folders",
    "",
    "Additional directories outside the workspace that agents are permitted to access. Each entry lists the effective permissions granted. When in doubt about whether a path is accessible, check this file.",
    ""
  ];
  for (const folder of profile.extraFolders) {
    const mount = bySource.get(expandHome(folder.path, paths.home));
    if (!mount) continue;
    const suffix = folder.description ? ` - ${folder.description}` : "";
    lines.push(`- \`${mount.target}\`${suffix} (read: ${folder.read}, edit: ${folder.edit})`);
  }
  lines.push("");
  await writeFile(indexPath, lines.join("\n"), "utf8");
}

async function writeSandboxRuntimeConfig(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  mcp: SandboxMcpRuntimeConfig,
  extraMounts: readonly SandboxMount[]
): Promise<string> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const runtimeDir = sandboxRuntimeDir(paths, profile);
  const replacements = pathReplacements(paths, profile, extraMounts);
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(path.join(runtimeDir, "mindframe-z"), { recursive: true });
  await mkdir(path.join(runtimeDir, "opencode"), { recursive: true });
  await mkdir(path.join(runtimeDir, "claude"), { recursive: true });

  const agents = await Promise.all(profile.instructionFiles.map((file) => readFile(file, "utf8")));
  await writeFile(path.join(runtimeDir, "mindframe-z", "AGENTS.md"), agents.join("\n"), "utf8");
  await renderSandboxReferencesIndex(runtimeDir, profile);
  await renderSandboxExtraFoldersIndex(paths, runtimeDir, profile, extraMounts);

  const opencodeSource = await readOptional(
    path.join(configsProfile, "opencode", "opencode.jsonc")
  );
  const opencodeConfig = opencodeSource
    ? (JSON.parse(rewriteSandboxPaths(opencodeSource, replacements)) as Record<string, unknown>)
    : {
        instructions: [
          path.posix.join(containerMindframeDir, "AGENTS.md"),
          path.posix.join(containerMindframeDir, "references.md")
        ]
      };
  opencodeConfig.mcp = mcp.opencode;
  await writeFile(
    path.join(runtimeDir, "opencode", "opencode.jsonc"),
    `${JSON.stringify(opencodeConfig, null, 2)}\n`,
    "utf8"
  );

  const claudeMd = rewriteSandboxPaths(
    (await readOptional(path.join(configsProfile, "claude", "CLAUDE.md"))) ??
      [
        "# CLAUDE.md",
        "",
        `@${path.posix.join(containerMindframeDir, "AGENTS.md")}`,
        `@${path.posix.join(containerMindframeDir, "references.md")}`,
        ""
      ].join("\n"),
    replacements
  );
  await writeFile(path.join(runtimeDir, "claude", "CLAUDE.md"), claudeMd, "utf8");

  const claudeSettingsSource = await readOptional(
    path.join(configsProfile, "claude", "settings.json")
  );
  const claudeSettings = claudeSettingsSource
    ? (JSON.parse(rewriteSandboxPaths(claudeSettingsSource, replacements)) as Record<
        string,
        unknown
      >)
    : {};
  await writeFile(
    path.join(runtimeDir, "claude", "settings.json"),
    `${JSON.stringify(claudeSettings, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runtimeDir, "claude", "mcp.json"),
    `${JSON.stringify({ mcpServers: mcp.claude }, null, 2)}\n`,
    "utf8"
  );

  return runtimeDir;
}

function renderedMounts(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  runtimeDir: string,
  extraMounts: readonly SandboxMount[]
): SandboxMount[] {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const dotfiles = profile.profile.dotfiles;
  const mounts: SandboxMount[] = [
    {
      source: path.join(runtimeDir, "claude", "CLAUDE.md"),
      target: path.join(containerHome, ".claude", "CLAUDE.md"),
      mode: "ro"
    },
    {
      source: path.join(runtimeDir, "claude", "settings.json"),
      target: path.join(containerHome, ".claude", "settings.json"),
      mode: "ro"
    },
    {
      source: path.join(runtimeDir, "claude", "mcp.json"),
      target: path.join(containerHome, ".claude", "mcp.json"),
      mode: "ro"
    },
    {
      source: path.join(runtimeDir, "opencode", "opencode.jsonc"),
      target: path.join(containerHome, ".config", "opencode", "opencode.jsonc"),
      mode: "ro"
    },
    {
      source: path.join(configsProfile, "opencode", "commands"),
      target: path.join(containerHome, ".config", "opencode", "commands"),
      mode: "ro"
    },
    {
      source: path.join(configsProfile, "opencode", "plugins"),
      target: path.join(containerHome, ".config", "opencode", "plugins"),
      mode: "ro"
    },
    {
      source: path.join(configsProfile, "mise", "config.toml"),
      target: path.join(containerHome, ".config", "mise", "config.toml"),
      mode: "ro"
    },
    {
      source: gitIdentityFragmentPath(paths),
      target: path.join(containerHome, ".gitconfig"),
      mode: "ro"
    },
    {
      source: path.join(paths.home, ".config", "git", "ignore"),
      target: path.join(containerHome, ".config", "git", "ignore"),
      mode: "ro"
    },
    {
      source: path.join(runtimeDir, "mindframe-z", "AGENTS.md"),
      target: path.posix.join(containerMindframeDir, "AGENTS.md"),
      mode: "ro"
    },
    {
      source: path.join(runtimeDir, "mindframe-z", "references.md"),
      target: path.posix.join(containerMindframeDir, "references.md"),
      mode: "ro"
    },
    {
      source: path.join(runtimeDir, "mindframe-z", "extra_folders.md"),
      target: path.posix.join(containerMindframeDir, "extra_folders.md"),
      mode: "ro"
    },
    { source: profile.referencesDir, target: containerReferencesDir, mode: "ro" },
    ...extraMounts
  ];

  for (const name of [".zshrc", ".p10k.zsh"] as const) {
    if (Object.hasOwn(dotfiles, name)) {
      mounts.push({
        source: path.join(configsProfile, "dotfiles", name),
        target: path.join(containerHome, name),
        mode: "ro"
      });
    }
  }

  return mounts;
}

/**
 * Seed the writable agent state on the host before launch. The bind mounts are
 * `type=bind`, so Docker would otherwise auto-create missing sources as
 * root-owned directories — which breaks `.claude.json` (a file) and leaves the
 * state dirs unwritable by the container's non-root sandbox user.
 */
export async function ensureSandboxState(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  credentialMode?: SandboxRuntimeInputs["credentialMode"]
): Promise<void> {
  const stateDir = sandboxStateDir(paths, profile);
  for (const dir of ["claude", "opencode-data", "opencode-state"]) {
    await mkdir(path.join(stateDir, dir), { recursive: true });
  }
  await writeFile(path.join(stateDir, "claude.json"), "{}\n", { flag: "wx" }).catch(() => {});

  // Placeholder opencode ChatGPT-OAuth auth so opencode follows its Codex
  // request path; Agent Vault swaps the Bearer token and account header. The
  // far-future expiry stops opencode from attempting a (placeholder) refresh.
  const opencodeAuth = {
    openai: {
      type: "oauth",
      refresh: "dummy-refresh-token",
      access: "dummy-access-token",
      expires: 9999999999999,
      accountId: "00000000-0000-0000-0000-000000000000"
    }
  };
  await writeFile(
    path.join(stateDir, "opencode-data", "auth.json"),
    `${JSON.stringify(opencodeAuth, null, 2)}\n`,
    { flag: "wx" }
  ).catch(() => {});

  if (credentialMode === "subscription") {
    // Placeholder subscription credential: keeps Claude Code in OAuth mode so it
    // sends a real Bearer request the broker rewrites. The token value is never
    // used upstream (the broker swaps it); the far-future expiry stops refresh.
    const credentials = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-PLACEHOLDER",
        refreshToken: "sk-ant-ort01-PLACEHOLDER",
        expiresAt: 4102444800000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "pro"
      }
    };
    await writeFile(
      path.join(stateDir, "claude", ".credentials.json"),
      `${JSON.stringify(credentials, null, 2)}\n`,
      { flag: "wx" }
    ).catch(() => {});
  }
}

function stateMounts(paths: RuntimePaths, profile: ResolvedProfile): SandboxMount[] {
  const stateDir = sandboxStateDir(paths, profile);
  return [
    {
      source: path.join(stateDir, "claude"),
      target: path.join(containerHome, ".claude"),
      mode: "rw"
    },
    {
      source: path.join(stateDir, "claude.json"),
      target: path.join(containerHome, ".claude.json"),
      mode: "rw"
    },
    {
      source: path.join(stateDir, "opencode-data"),
      target: path.join(containerHome, ".local", "share", "opencode"),
      mode: "rw"
    },
    {
      source: path.join(stateDir, "opencode-state"),
      target: path.join(containerHome, ".local", "state", "opencode"),
      mode: "rw"
    }
  ];
}

function serviceDefinitions(
  credentialMode: SandboxRuntimeInputs["credentialMode"]
): SandboxServiceDefinition[] {
  const services: SandboxServiceDefinition[] = [
    {
      name: "agent-vault",
      image: "local-ai-dev-sandbox-agent-vault:latest",
      command: [
        "server",
        "--host",
        "0.0.0.0",
        "--port",
        agentVaultApiPort,
        "--mitm-port",
        agentVaultMitmPort
      ],
      environment: {
        AGENT_VAULT_ADDR: `http://127.0.0.1:${agentVaultApiPort}`,
        AGENT_VAULT_MASTER_PASSWORD: "${AGENT_VAULT_MASTER_PASSWORD}"
      },
      ports: [
        `127.0.0.1:${agentVaultApiPort}:${agentVaultApiPort}`,
        `127.0.0.1:${agentVaultMitmPort}:${agentVaultMitmPort}`
      ],
      volumes: ["agent-vault-data:/data"]
    }
  ];

  if (credentialMode === "bedrock") {
    services.push({
      name: "bedrock-sigv4-proxy",
      image: "local-ai-dev-sandbox-bedrock-sigv4-proxy:latest",
      command: ["--name", "bedrock", "--host", `bedrock-runtime.${bedrockRegion}.amazonaws.com`],
      environment: {
        AWS_REGION: bedrockRegion,
        AWS_SDK_LOAD_CONFIG: "1"
      },
      ports: [`127.0.0.1:${bedrockProxyPort}:8080`],
      volumes: ["bedrock-proxy-aws:/home/sandbox/.aws"]
    });
  }

  return services;
}

function launchCommand(target: SandboxLaunchTarget, args: readonly string[]): string[] {
  const command = target === "cc" ? ["claude"] : target === "oc" ? ["opencode"] : ["zsh"];
  return [...command, ...args];
}

function remoteEnabledMcpServers(profile: ResolvedProfile): ResolvedMcpServer[] {
  return profile.mcpServers.filter(
    (entry) => Object.values(entry.agents).some(Boolean) && entry.server.type === "remote"
  );
}

function headersSignature(headers: Record<string, string> | undefined, serverName: string): string {
  if (!headers) return `server:${serverName}`;
  return JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)));
}

function mcpOrigin(server: ResolvedMcpServer): string {
  const url = new URL(server.server.type === "remote" ? server.server.url : "http://local.invalid");
  return url.origin;
}

function shimmedServerNames(profile: ResolvedProfile): Set<string> {
  const byOrigin = new Map<string, ResolvedMcpServer[]>();
  for (const server of remoteEnabledMcpServers(profile)) {
    const servers = byOrigin.get(mcpOrigin(server)) ?? [];
    servers.push(server);
    byOrigin.set(mcpOrigin(server), servers);
  }

  const shimmed = new Set<string>();
  for (const servers of byOrigin.values()) {
    const identityCount = new Set(
      servers.map((server) => headersSignature(server.server.headers, server.name))
    ).size;
    if (servers.length > 1 && identityCount > 1) {
      for (const server of servers) shimmed.add(server.name);
    }
  }
  return shimmed;
}

function localMcpShimUrl(port: number, upstream: string): string {
  const pathname = new URL(upstream).pathname || "/mcp";
  return `http://127.0.0.1:${port}${pathname}`;
}

function oauthKey(serverName: string): string {
  return `${serverName.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_OAUTH`;
}

function sandboxMcpRuntimeConfig(
  paths: RuntimePaths,
  profile: ResolvedProfile
): SandboxMcpRuntimeConfig {
  const shimmedNames = shimmedServerNames(profile);
  const shims: Record<string, SandboxMcpShimDefinition> = {};
  let port = mcpShimBasePort;
  for (const server of remoteEnabledMcpServers(profile)) {
    if (!shimmedNames.has(server.name) || server.server.type !== "remote") continue;
    shims[server.name] = {
      port,
      upstream: server.server.url,
      vault: `${sandboxVaultName}-mcp-${server.name}`,
      oauth: { key: oauthKey(server.name) }
    };
    port += 1;
  }

  return {
    broker: { basePort: mcpShimBasePort, shims },
    opencode: sandboxMcpForTarget(paths, profile, "opencode", shims),
    claude: sandboxMcpForTarget(paths, profile, "claude-code", shims)
  };
}

function sandboxMcpForTarget(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: "opencode" | "claude-code",
  shims: Record<string, SandboxMcpShimDefinition>
): Record<string, unknown> {
  return Object.fromEntries(
    filterMcpForTarget(profile, target).map((entry) => {
      const shim = shims[entry.name];
      const headers = sandboxMcpHeaders(entry.server.headers, Boolean(shim));
      if (entry.server.type === "remote") {
        const url = shim ? localMcpShimUrl(shim.port, entry.server.url) : entry.server.url;
        if (target === "opencode") {
          return [
            entry.name,
            {
              type: "remote",
              url,
              enabled: entry.enabled,
              ...(headers ? { headers } : {})
            }
          ];
        }
        return [
          entry.name,
          {
            type: entry.server.transport === "sse" ? "sse" : "http",
            url,
            ...(headers ? { headers } : {})
          }
        ];
      }

      if (target === "opencode") {
        return [
          entry.name,
          {
            type: "local",
            command: entry.server.command.map((part) => expandHome(part, paths.home)),
            enabled: entry.enabled,
            ...(entry.server.env ? { env: entry.server.env } : {})
          }
        ];
      }
      const [command, ...args] = entry.server.command;
      return [
        entry.name,
        {
          type: "stdio",
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(entry.server.env ? { env: entry.server.env } : {})
        }
      ];
    })
  );
}

function sandboxMcpHeaders(
  headers: Record<string, string> | undefined,
  shimmed: boolean
): Record<string, string> | undefined {
  if (!headers && !shimmed) return undefined;
  return { ...headers, ...(shimmed ? { Authorization: "PLACEHOLDER" } : {}) };
}

function dockerRunArgs(
  mounts: readonly SandboxMount[],
  env: Record<string, string>,
  target: SandboxLaunchTarget,
  args: readonly string[],
  tty: boolean
): string[] {
  return [
    "run",
    "--rm",
    "-i",
    ...(tty ? ["-t"] : []),
    "--add-host",
    "host.docker.internal:host-gateway",
    "-w",
    "/workspace",
    ...mounts.flatMap((mount) => [
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target},readonly=${mount.mode === "ro"}`
    ]),
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    "local-ai-dev-sandbox-agent:latest",
    ...launchCommand(target, args)
  ];
}

export async function resolveSandboxRuntimeInputs(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: {
    readonly workspace?: string;
    readonly target?: SandboxLaunchTarget;
    readonly args?: readonly string[];
    readonly agentToken?: string | undefined;
    readonly tty?: boolean | undefined;
  } = {}
): Promise<SandboxRuntimeInputs> {
  const credentialMode = await resolveSandboxCredentialMode(paths, profile.manifests.machine);
  const workspace = path.resolve(expandHome(options.workspace ?? process.cwd(), paths.home));
  const noProxy = ["localhost", "127.0.0.1", "host.docker.internal"];
  if (credentialMode === "bedrock") noProxy.push("bedrock-sigv4-proxy");

  // The scoped Agent Vault token authenticates the container to the MITM proxy
  // (as basic-auth userinfo) and the MCP broker. Tests resolve without a token.
  const agentToken = options.agentToken ?? "PLACEHOLDER";
  const proxyUrl = `http://${agentToken}:${sandboxVaultName}@host.docker.internal:${agentVaultMitmPort}`;
  const env: Record<string, string> = {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: noProxy.join(","),
    NODE_USE_ENV_PROXY: "1",
    OPENCLAW_PROXY_URL: proxyUrl,
    SSL_CERT_FILE: caPath,
    NODE_EXTRA_CA_CERTS: caPath,
    REQUESTS_CA_BUNDLE: caPath,
    CURL_CA_BUNDLE: caPath,
    GIT_SSL_CAINFO: caPath,
    DENO_CERT: caPath,
    AGENT_VAULT_ADDR: `http://host.docker.internal:${agentVaultApiPort}`,
    AGENT_VAULT_TOKEN: agentToken,
    AGENT_VAULT_VAULT: sandboxVaultName,
    WORKSPACE_DIR: "/workspace",
    GH_TOKEN: "PLACEHOLDER"
  };

  if (credentialMode === "bedrock") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    env.ANTHROPIC_BEDROCK_BASE_URL = `http://host.docker.internal:${bedrockProxyPort}`;
    env.AWS_REGION = bedrockRegion;
    env.AWS_EC2_METADATA_DISABLED = "true";
  } else if (credentialMode === "subscription") {
    // No ANTHROPIC_AUTH_TOKEN: that would put Claude Code in gateway-token mode.
    // Instead a placeholder `.credentials.json` (seeded into state) keeps it in
    // real subscription-OAuth mode so it sends its own `anthropic-beta` set and
    // a Bearer token the broker swaps for the real one.
    env.CLAUDE_CODE_USE_BEDROCK = "0";
  }

  const mcp = sandboxMcpRuntimeConfig(paths, profile);
  const extraMounts = extraFolderMounts(paths, profile);
  const runtimeDir = await writeSandboxRuntimeConfig(paths, profile, mcp, extraMounts);
  const mounts = [
    { source: workspace, target: "/workspace", mode: "rw" as const },
    { source: sandboxCaFile(paths), target: caPath, mode: "ro" as const },
    ...stateMounts(paths, profile),
    ...renderedMounts(paths, profile, runtimeDir, extraMounts)
  ];

  return {
    credentialMode,
    services: serviceDefinitions(credentialMode),
    mounts,
    env,
    noProxy,
    mcp,
    dockerRunArgs: dockerRunArgs(
      mounts,
      env,
      options.target ?? "shell",
      options.args ?? [],
      options.tty ?? false
    )
  };
}
