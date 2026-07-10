import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { execa } from "execa";
import type { RuntimePaths } from "../../src/core/paths.js";

export const projectRoot = path.resolve(import.meta.dirname, "../..");

export async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mindframe-z-test-"));
}

export function testRuntimePaths(home: string, root = home): RuntimePaths {
  return {
    root,
    home,
    configsDir: path.join(home, ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

export function configsPath(home: string, ...segments: string[]): string {
  return path.join(home, ".mindframe-z", "configs", ...segments);
}

// Fresh, isolated root + home temp dirs populated with the standard fixture. One
// definition of "a fixture" so the integration suites don't drift apart.
export async function setupIntegrationFixture(): Promise<{ root: string; home: string }> {
  const root = await makeTempDir();
  const home = await makeTempDir();
  await writeFixture(root, home);
  return { root, home };
}

export async function writeFixture(root: string, home?: string): Promise<void> {
  await mkdir(path.join(root, "catalog"), { recursive: true });
  await mkdir(path.join(root, "instructions"), { recursive: true });
  await mkdir(path.join(root, "opencode", "plugins"), { recursive: true });
  await mkdir(path.join(root, "opencode", "commands"), { recursive: true });
  await mkdir(path.join(root, "profiles", "base"), { recursive: true });
  await mkdir(path.join(root, "profiles", "personal"), { recursive: true });
  await writeFile(path.join(root, "mfz_home.yml"), "description: Test home\n", "utf8");
  await writeFile(path.join(root, "instructions", "AGENTS.md"), "# Test Agents\n", "utf8");
  await writeFile(
    path.join(root, "opencode", "plugins", "config-marker.ts"),
    [
      "export default async () => {",
      "  return {",
      "    config: (cfg) => {",
      "      cfg.username = 'mindframe-z-plugin-loaded';",
      "    },",
      "  };",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "opencode", "commands", "test-cmd.md"),
    ["---", "description: Test command.", "---", "", "Run the test command.", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "catalog", "references.yml"),
    [
      "references:",
      "  - name: local-ref",
      "    url: https://example.invalid/local-ref.git",
      "    description: Local test reference.",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "catalog", "skills.yml"),
    [
      "skills:",
      "  - name: local-skill",
      "    source: local",
      "    description: Local test skill.",
      "    installer: skills",
      "  - name: claude-skill",
      "    source: local",
      "    description: Claude test skill.",
      "    installer: skills",
      "  - name: all-skill",
      "    source: local",
      "    description: All agents test skill.",
      "    installer: skills",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "catalog", "mcp.yml"),
    [
      "servers:",
      "  context7:",
      "    description: Docs.",
      "    type: remote",
      "    transport: http",
      "    url: https://mcp.context7.com/mcp",
      "  local-helper:",
      "    description: Local helper.",
      "    type: local",
      "    command: [tool-helper, --serve]",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "base", "profile.yml"),
    [
      "name: base",
      "mcp:",
      "  context7:",
      "    agents: { opencode: true, claude-code: true, codex: true }",
      "  local-helper:",
      "    agents: { claude-code: true }",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "base", "mise.toml"),
    '[tools]\njq = "latest"\n\n[settings]\nminimum_release_age = "3d"\n',
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "base", ".npmrc"),
    "min-release-age=3\nminimum-release-age=4320\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "personal", "profile.yml"),
    [
      "name: personal",
      "extends: base",
      "agents: [opencode, claude-code]",
      "instructions:",
      "  - instructions/AGENTS.md",
      "references:",
      "  - local-ref",
      "skills:",
      "  local-skill:",
      "    agents: { opencode: true, claude-code: true }",
      "  claude-skill:",
      "    agents: { claude-code: true }",
      "  all-skill:",
      "    agents: { opencode: true, claude-code: true }",
      "mcp:",
      "  context7:",
      "    agents: { opencode: true, claude-code: true }",
      "opencode:",
      "  config:",
      "    model: test/model",
      "  plugins:",
      "    - config-marker",
      "  commands:",
      "    - test-cmd",
      "claude:",
      "  model: sonnet",
      "  settings:",
      "    includeGitInstructions: true",
      ""
    ].join("\n"),
    "utf8"
  );
  if (home) {
    const cfgDir = path.join(home, ".mindframe-z");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      path.join(cfgDir, "config.yml"),
      ["profile: personal", "references_dir: ~/.mindframe-z/references", ""].join("\n"),
      "utf8"
    );
  }
}

export function cli(
  name: "mfz",
  root: string,
  home: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
  cwd = projectRoot
) {
  const options: Record<string, unknown> = {
    cwd,
    env: {
      ...process.env,
      MFZ_ROOT: root,
      MFZ_HOME: home,
      OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
      PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
      ...env
    }
  };
  if (input !== undefined) options.input = input;
  return execa(
    process.execPath,
    [
      "--import",
      path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      path.join(projectRoot, "src", "cli", `${name}.ts`),
      "--root",
      root,
      "--home",
      home,
      ...args
    ],
    options
  );
}

export function cliWithMachineHomePath(home: string, args: string[]) {
  return execa(
    process.execPath,
    ["--import", "tsx", path.join(projectRoot, "src", "cli", "mfz.ts"), "--home", home, ...args],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        MFZ_HOME: home,
        MFZ_ROOT: undefined,
        OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
        CODEX_HOME: path.join(home, ".codex"),
        PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent")
      }
    }
  );
}

export function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
}
