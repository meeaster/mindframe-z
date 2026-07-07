import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MachineManifest } from "../core/manifests.js";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedMcpServer, ResolvedProfile } from "../core/profile.js";
import { resolveSandboxRuntimeInputs } from "./runtime.js";

function paths(home = "/tmp/mfz-home", root = "/tmp/mfz-root"): RuntimePaths {
  return {
    root,
    home,
    configsDir: path.join(root, "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

function profile(
  credentials: "bedrock" | "subscription",
  options: { readonly home?: string; readonly root?: string; readonly extraFolder?: string } = {}
): ResolvedProfile {
  const machine: MachineManifest = {
    references_dir: "~/references",
    extra_folders: options.extraFolder
      ? [
          {
            path: options.extraFolder,
            read: "allow" as const,
            edit: "deny" as const,
            description: "Test extra folder."
          }
        ]
      : [],
    git: {},
    sandbox: { credentials },
    thread: { destinations: [] },
    archives: [],
    opencode: {}
  };

  return {
    name: "personal",
    agents: ["opencode", "claude-code"],
    profile: {
      name: "personal",
      description: "Test profile",
      agents: ["opencode", "claude-code"],
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
        defaults: { session_sources: ["claude-code", "opencode"] },
        credentials: "subscription"
      },
      dotfiles: { ".zshrc": "zsh", ".p10k.zsh": "prompt" },
      extra_folders: []
    },
    manifests: { references: [], skills: [], mcpServers: {}, profiles: new Map(), machine },
    instructionFiles: options.root ? [path.join(options.root, "shared", "AGENTS.global.md")] : [],
    referencesDir: path.join(options.home ?? "/tmp", "references"),
    enabledReferences: [
      { name: "local-ref", url: "https://example.invalid/ref.git", description: "Local ref." }
    ],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    mcpServers: [],
    extraFolders: options.extraFolder
      ? [
          {
            path: options.extraFolder,
            read: "allow" as const,
            edit: "deny" as const,
            description: "Test extra folder."
          }
        ]
      : []
  };
}

function remoteMcp(
  name: string,
  url: string,
  options: {
    headers?: Record<string, string>;
    targets?: ["opencode" | "claude-code", ...("opencode" | "claude-code")[]];
  } = {}
): ResolvedMcpServer {
  return {
    name,
    enabled: true,
    targets: options.targets ?? ["opencode", "claude-code"],
    server: {
      type: "remote",
      transport: "http",
      description: `${name} MCP`,
      url,
      ...(options.headers ? { headers: options.headers } : {})
    }
  };
}

describe("sandbox runtime inputs", () => {
  it("generates Agent Vault plus Bedrock signer services in Bedrock mode", async () => {
    const runtime = await resolveSandboxRuntimeInputs(paths(), profile("bedrock"), {
      workspace: "/tmp/project"
    });

    expect(runtime.services.map((service) => service.name)).toEqual([
      "agent-vault",
      "bedrock-sigv4-proxy"
    ]);
    expect(runtime.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(runtime.env.ANTHROPIC_BEDROCK_BASE_URL).toBe("http://host.docker.internal:8080");
    expect(runtime.noProxy).toContain("bedrock-sigv4-proxy");
  });

  it("omits the Bedrock signer and Bedrock environment in subscription mode", async () => {
    const runtime = await resolveSandboxRuntimeInputs(paths(), profile("subscription"), {
      workspace: "/tmp/project"
    });

    expect(runtime.services.map((service) => service.name)).toEqual(["agent-vault"]);
    expect(runtime.env.CLAUDE_CODE_USE_BEDROCK).toBe("0");
    // No ANTHROPIC_AUTH_TOKEN: subscription mode relies on a placeholder
    // .credentials.json so Claude Code stays in OAuth mode for broker rewrite.
    expect(runtime.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(runtime.env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
    expect(runtime.noProxy).not.toContain("bedrock-sigv4-proxy");
  });

  it("maps rendered config read-only, writable state read-write, and workspace read-write", async () => {
    const runtime = await resolveSandboxRuntimeInputs(paths(), profile("subscription"), {
      workspace: "/tmp/project"
    });
    const byTarget = new Map(runtime.mounts.map((mount) => [mount.target, mount]));

    expect(byTarget.get("/workspace")).toMatchObject({ source: "/tmp/project", mode: "rw" });
    expect(byTarget.get("/home/sandbox/.claude/settings.json")).toMatchObject({ mode: "ro" });
    expect(byTarget.get("/home/sandbox/.claude/mcp.json")).toMatchObject({ mode: "ro" });
    expect(byTarget.get("/home/sandbox/.config/opencode/opencode.jsonc")).toMatchObject({
      mode: "ro"
    });
    expect(byTarget.get("/home/sandbox/.config/mise/config.toml")).toMatchObject({ mode: "ro" });
    expect(byTarget.get("/home/sandbox/.gitconfig")).toMatchObject({ mode: "ro" });
    expect(byTarget.get("/home/sandbox/.mindframe-z/references.md")).toMatchObject({ mode: "ro" });
    expect(byTarget.get("/references")).toMatchObject({ source: "/tmp/references", mode: "ro" });
    expect(byTarget.get("/home/sandbox/.local/share/opencode")).toMatchObject({ mode: "rw" });
    expect(byTarget.get("/home/sandbox/.local/state/opencode")).toMatchObject({ mode: "rw" });
  });

  it("renders sandbox-native instruction indexes and extra folder mounts", async () => {
    const home = "/tmp/mfz-sandbox-home";
    const root = "/tmp/mfz-sandbox-root";
    const runtimePaths = paths(home, root);
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "shared", "AGENTS.global.md"), "# Agents\n", "utf8");

    const runtime = await resolveSandboxRuntimeInputs(
      runtimePaths,
      profile("subscription", { home, root, extraFolder: path.join(home, "notes") }),
      { workspace: "/tmp/project" }
    );
    const byTarget = new Map(runtime.mounts.map((mount) => [mount.target, mount]));
    const referencesMount = byTarget.get("/home/sandbox/.mindframe-z/references.md");
    const extraMount = byTarget.get("/extra/notes");

    expect(extraMount).toMatchObject({ source: path.join(home, "notes"), mode: "ro" });
    expect(referencesMount?.source).toBeDefined();
    expect(await readFile(referencesMount?.source ?? "", "utf8")).toContain(
      "Path: `/references/local-ref`."
    );
    expect(
      await readFile(
        byTarget.get("/home/sandbox/.mindframe-z/extra_folders.md")?.source ?? "",
        "utf8"
      )
    ).toContain("`/extra/notes` - Test extra folder.");
    expect(
      await readFile(
        byTarget.get("/home/sandbox/.config/opencode/opencode.jsonc")?.source ?? "",
        "utf8"
      )
    ).toContain("/home/sandbox/.mindframe-z/references.md");
  });

  it("projects host mindframe-z config instead of mounting it as an extra folder", async () => {
    const home = "/tmp/mfz-sandbox-home";
    const root = "/tmp/mfz-sandbox-root";
    const runtimePaths = paths(home, root);
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "shared", "AGENTS.global.md"), "# Agents\n", "utf8");

    const runtime = await resolveSandboxRuntimeInputs(
      runtimePaths,
      profile("subscription", { home, root, extraFolder: path.join(home, ".mindframe-z") }),
      { workspace: "/tmp/project" }
    );
    const byTarget = new Map(runtime.mounts.map((mount) => [mount.target, mount]));

    expect(byTarget.get("/extra/.mindframe-z")).toBeUndefined();
    expect(byTarget.get("/home/sandbox/.mindframe-z/AGENTS.md")).toMatchObject({ mode: "ro" });
    expect(byTarget.get("/home/sandbox/.mindframe-z/references.md")).toMatchObject({ mode: "ro" });
    expect(
      await readFile(
        byTarget.get("/home/sandbox/.mindframe-z/extra_folders.md")?.source ?? "",
        "utf8"
      )
    ).not.toContain("/extra/.mindframe-z");
  });

  it("injects the resolved agent token into the proxy URL and broker env", async () => {
    const runtime = await resolveSandboxRuntimeInputs(paths(), profile("subscription"), {
      workspace: "/tmp/project",
      agentToken: "scoped-token"
    });

    expect(runtime.env.AGENT_VAULT_TOKEN).toBe("scoped-token");
    expect(runtime.env.HTTPS_PROXY).toBe(
      "http://scoped-token:local-ai-dev-sandbox@host.docker.internal:14322"
    );
    expect(runtime.env.HTTPS_PROXY).not.toContain("${");
  });

  it("generates ephemeral docker run args with forwarded agent arguments", async () => {
    const runtime = await resolveSandboxRuntimeInputs(paths(), profile("subscription"), {
      workspace: "/tmp/project",
      target: "oc",
      args: ["run", "ok"]
    });

    expect(runtime.dockerRunArgs).toContain("--rm");
    expect(runtime.dockerRunArgs).toContain("--mount");
    expect(runtime.dockerRunArgs).toContain("NO_PROXY=localhost,127.0.0.1,host.docker.internal");
    expect(runtime.dockerRunArgs.slice(-3)).toEqual(["opencode", "run", "ok"]);
    expect(runtime.dockerRunArgs.join("\n")).not.toContain("/home/mark");
  });

  it("allocates a TTY only when launching from an interactive terminal", async () => {
    const nonInteractive = await resolveSandboxRuntimeInputs(paths(), profile("subscription"), {
      workspace: "/tmp/project",
      target: "oc"
    });
    const interactive = await resolveSandboxRuntimeInputs(paths(), profile("subscription"), {
      workspace: "/tmp/project",
      target: "oc",
      tty: true
    });

    expect(nonInteractive.dockerRunArgs).toContain("-i");
    expect(nonInteractive.dockerRunArgs).not.toContain("-t");
    expect(interactive.dockerRunArgs).toContain("-i");
    expect(interactive.dockerRunArgs).toContain("-t");
  });

  it("generates shims for same-host multi-identity MCP servers only", async () => {
    const resolved = profile("subscription");
    resolved.mcpServers = [
      remoteMcp("jira", "https://mcp.atlassian.com/v1/mcp"),
      remoteMcp("confluence", "https://mcp.atlassian.com/v1/mcp"),
      remoteMcp("datadog", "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp"),
      remoteMcp("exa", "https://mcp.exa.ai/mcp", { headers: { "x-api-key": "{env:EXA_API_KEY}" } }),
      remoteMcp("exa-research", "https://mcp.exa.ai/mcp?tools=advanced", {
        headers: { "x-api-key": "{env:EXA_API_KEY}" }
      })
    ];

    const runtime = await resolveSandboxRuntimeInputs(paths(), resolved, {
      workspace: "/tmp/project"
    });

    expect(Object.keys(runtime.mcp.broker.shims)).toEqual(["jira", "confluence"]);
    expect(runtime.mcp.broker.shims.jira).toMatchObject({
      port: 17301,
      upstream: "https://mcp.atlassian.com/v1/mcp",
      vault: "local-ai-dev-sandbox-mcp-jira",
      oauth: { key: "JIRA_OAUTH" }
    });
    expect(runtime.mcp.broker.shims.confluence?.port).toBe(17302);
  });

  it("rewrites only sandbox runtime MCP config to local shim endpoints", async () => {
    const resolved = profile("subscription");
    resolved.mcpServers = [
      remoteMcp("jira", "https://mcp.atlassian.com/v1/mcp"),
      remoteMcp("confluence", "https://mcp.atlassian.com/v1/mcp"),
      remoteMcp("datadog", "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp")
    ];

    const runtime = await resolveSandboxRuntimeInputs(paths(), resolved, {
      workspace: "/tmp/project"
    });
    const opencode = runtime.mcp.opencode as Record<
      string,
      { url: string; headers?: Record<string, string> }
    >;
    const claude = runtime.mcp.claude as Record<
      string,
      { url: string; headers?: Record<string, string> }
    >;

    expect(opencode.jira?.url).toBe("http://127.0.0.1:17301/v1/mcp");
    expect(opencode.jira?.headers?.Authorization).toBe("PLACEHOLDER");
    expect(claude.confluence?.url).toBe("http://127.0.0.1:17302/v1/mcp");
    expect(opencode.datadog?.url).toBe("https://mcp.datadoghq.com/api/unstable/mcp-server/mcp");
    expect(
      resolved.mcpServers[0]?.server.type === "remote" ? resolved.mcpServers[0].server.url : ""
    ).toBe("https://mcp.atlassian.com/v1/mcp");
  });
});
