import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { execa } from "execa";

export const projectRoot = path.resolve(import.meta.dirname, "../..");

export async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mindframe-z-test-"));
}

export async function writeFixture(root: string, home?: string): Promise<void> {
  await mkdir(path.join(root, "shared"), { recursive: true });
  await mkdir(path.join(root, "opencode", "plugins"), { recursive: true });
  await mkdir(path.join(root, "opencode", "commands"), { recursive: true });
  await mkdir(path.join(root, "profiles", "base"), { recursive: true });
  await mkdir(path.join(root, "profiles", "personal"), { recursive: true });
  await writeFile(path.join(root, "shared", "AGENTS.global.md"), "# Test Agents\n", "utf8");
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
    path.join(root, "shared", "refs.yml"),
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
    path.join(root, "shared", "skills.yml"),
    [
      "skills:",
      "  - name: local-skill",
      "    source: local",
      "    description: Local test skill.",
      "    installer: npx-skills",
      "  - name: claude-skill",
      "    source: local",
      "    description: Claude test skill.",
      "    installer: npx-skills",
      "  - name: all-skill",
      "    source: local",
      "    description: All agents test skill.",
      "    installer: npx-skills",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "shared", "mcp.yml"),
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
      "    enabled: true",
      "  local-helper:",
      "    targets: [claude-code]",
      "    enabled: false",
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
      "  - shared/AGENTS.global.md",
      "references:",
      "  - local-ref",
      "skills:",
      "  local-skill:",
      "  claude-skill: [claude-code]",
      "  all-skill: [all]",
      "mcp:",
      "  context7:",
      "    enabled: true",
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
      ["profile: personal", "references_dir: ~/references", ""].join("\n"),
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

export function cliWithMachineRepoPath(home: string, args: string[]) {
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
        CLAUDE_CONFIG_DIR: path.join(home, ".claude")
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
