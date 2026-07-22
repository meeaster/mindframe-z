import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveProfile, type ResolvedProfile } from "../core/profile.js";
import type { RuntimePaths } from "../core/paths.js";
import { makeTempDir, testRuntimePaths, writeFixture } from "../../tests/integration/support.js";
import { syncClaude } from "./claude.js";
import { syncCodex } from "./codex.js";
import { syncOpencode } from "./opencode.js";

// The `personal` fixture profile manages `claude.settings.includeGitInstructions`
// and `opencode.config.model`, and declares no codex config or plugins. The sync
// detectors below turn *unmanaged* local keys into adoption candidates, so these
// tests assert that managed/derived keys stay silent while stray keys surface.
let paths: RuntimePaths;
let profile: ResolvedProfile;

beforeAll(async () => {
  const root = await makeTempDir();
  const home = await makeTempDir();
  await writeFixture(root, home);
  paths = testRuntimePaths(home, root);
  profile = await resolveProfile(paths, "personal");
});

async function writeJson(dir: string, name: string, value: unknown): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

describe("syncClaude", () => {
  it("surfaces only keys the profile does not manage", async () => {
    const dir = await makeTempDir();
    const settingsPath = await writeJson(dir, "settings.json", {
      includeGitInstructions: true,
      model: "sonnet",
      permissions: { allow: ["Read(/tmp/**)"] },
      theme: "dark",
      statusLine: { type: "command" }
    });

    const { candidates } = await syncClaude(settingsPath, profile);

    expect(candidates).toEqual([
      { target: "claude", yamlPrefix: "claude.settings", key: "theme", value: "dark" },
      {
        target: "claude",
        yamlPrefix: "claude.settings",
        key: "statusLine",
        value: { type: "command" }
      }
    ]);
  });

  it("returns no candidates when the settings file is missing", async () => {
    const dir = await makeTempDir();
    const { candidates } = await syncClaude(path.join(dir, "absent.json"), profile);
    expect(candidates).toEqual([]);
  });

  it("returns no candidates when the settings file is not a JSON object", async () => {
    const dir = await makeTempDir();
    const settingsPath = await writeJson(dir, "settings.json", ["theme", "dark"]);
    const { candidates } = await syncClaude(settingsPath, profile);
    expect(candidates).toEqual([]);
  });
});

describe("syncOpencode", () => {
  it("ignores derived and managed keys while tolerating jsonc comments", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "opencode.jsonc");
    await writeFile(
      file,
      [
        "{",
        "  // managed and derived keys must be skipped",
        '  "$schema": "https://opencode.ai/config.json",',
        '  "model": "test/model",',
        '  "theme": "dim",',
        '  "keybinds": { "leader": "ctrl+x" }',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const { candidates } = await syncOpencode(file, profile);

    expect(candidates).toEqual([
      { target: "opencode", yamlPrefix: "opencode.config", key: "theme", value: "dim" },
      {
        target: "opencode",
        yamlPrefix: "opencode.config",
        key: "keybinds",
        value: { leader: "ctrl+x" }
      }
    ]);
  });

  it("returns no candidates when the config file is missing", async () => {
    const dir = await makeTempDir();
    const { candidates } = await syncOpencode(path.join(dir, "absent.jsonc"), profile);
    expect(candidates).toEqual([]);
  });

  it("returns no candidates when the config file is not a JSON object", async () => {
    const dir = await makeTempDir();
    const file = await writeJson(dir, "opencode.jsonc", ["theme", "dim"]);
    const { candidates } = await syncOpencode(file, profile);
    expect(candidates).toEqual([]);
  });
});

describe("syncCodex", () => {
  async function writeToml(dir: string, name: string, value: Record<string, unknown>) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, stringifyToml(value), "utf8");
    return file;
  }

  it("adopts unmanaged config keys and enabled undeclared plugins", async () => {
    const dir = await makeTempDir();
    const snapshotPath = await writeToml(dir, "snapshot.toml", {
      model: "gpt-5-codex",
      theme: "dim",
      permissions: { default_permissions: "mfz" },
      plugins: { rendered: { enabled: true } }
    });
    const localPath = await writeToml(dir, "local.toml", {
      plugins: {
        "new-plugin": { enabled: true },
        "off-plugin": { enabled: false }
      }
    });

    const { candidates } = await syncCodex(snapshotPath, localPath, profile);

    expect(candidates).toEqual([
      {
        target: "codex",
        yamlPrefix: "codex.plugins",
        key: "new-plugin",
        value: { enabled: true }
      },
      { target: "codex", yamlPrefix: "codex.config", key: "model", value: "gpt-5-codex" },
      { target: "codex", yamlPrefix: "codex.config", key: "theme", value: "dim" }
    ]);
  });

  it("does not re-surface plugins the profile already declares", async () => {
    const declaring: ResolvedProfile = {
      ...profile,
      profile: {
        ...profile.profile,
        codex: {
          ...profile.profile.codex,
          plugins: { "declared-plugin": { enabled: true } }
        }
      }
    };
    const dir = await makeTempDir();
    const snapshotPath = await writeToml(dir, "snapshot.toml", {});
    const localPath = await writeToml(dir, "local.toml", {
      plugins: { "declared-plugin": { enabled: true } }
    });

    const { candidates } = await syncCodex(snapshotPath, localPath, declaring);

    expect(candidates).toEqual([]);
  });
});
