import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentList,
  createRuntimePaths,
  infraTargetList,
  opencodeDataHome,
  opencodeDbPath,
  type RuntimePaths
} from "./paths.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    configsDir: path.join(home, "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

describe("opencodeDataHome / opencodeDbPath", () => {
  const original = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    delete process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = original;
  });

  it("falls back to <home>/.local/share when XDG_DATA_HOME is unset", () => {
    expect(opencodeDataHome(paths("/tmp/fake-home"))).toBe("/tmp/fake-home/.local/share");
    expect(opencodeDbPath(paths("/tmp/fake-home"))).toBe(
      "/tmp/fake-home/.local/share/opencode/opencode.db"
    );
  });

  it("prefers XDG_DATA_HOME over the home-relative default", () => {
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";
    expect(opencodeDataHome(paths("/tmp/fake-home"))).toBe("/tmp/xdg-data");
    expect(opencodeDbPath(paths("/tmp/fake-home"))).toBe("/tmp/xdg-data/opencode/opencode.db");
  });
});

describe("createRuntimePaths", () => {
  const envKeys = [
    "MFZ_ROOT",
    "MFZ_HOME",
    "OPENCODE_CONFIG_DIR",
    "CLAUDE_CONFIG_DIR",
    "MISE_CONFIG_DIR"
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("derives tool config dirs from home and root by default", () => {
    const runtime = createRuntimePaths({ root: "/tmp/repo", home: "/tmp/home" });
    expect(runtime.root).toBe("/tmp/repo");
    expect(runtime.home).toBe("/tmp/home");
    expect(runtime.configsDir).toBe(path.join("/tmp/repo", "configs"));
    expect(runtime.opencodeConfigDir).toBe(path.join("/tmp/home", ".config", "opencode"));
    expect(runtime.claudeDir).toBe(path.join("/tmp/home", ".claude"));
    expect(runtime.miseConfigDir).toBe(path.join("/tmp/home", ".config", "mise"));
  });

  it("reads tool config dirs from environment overrides", () => {
    process.env.OPENCODE_CONFIG_DIR = "/env/opencode";
    process.env.CLAUDE_CONFIG_DIR = "/env/claude";
    process.env.MISE_CONFIG_DIR = "/env/mise";
    const runtime = createRuntimePaths({ root: "/tmp/repo", home: "/tmp/home" });
    expect(runtime.opencodeConfigDir).toBe("/env/opencode");
    expect(runtime.claudeDir).toBe("/env/claude");
    expect(runtime.miseConfigDir).toBe("/env/mise");
  });

  it("prefers explicit options over environment overrides", () => {
    process.env.OPENCODE_CONFIG_DIR = "/env/opencode";
    process.env.CLAUDE_CONFIG_DIR = "/env/claude";
    const runtime = createRuntimePaths({
      root: "/tmp/repo",
      home: "/tmp/home",
      opencodeConfigDir: "/opt/opencode",
      claudeDir: "/opt/claude"
    });
    expect(runtime.opencodeConfigDir).toBe("/opt/opencode");
    expect(runtime.claudeDir).toBe("/opt/claude");
  });

  it("expands a ~-relative override against the resolved home", () => {
    process.env.OPENCODE_CONFIG_DIR = "~/nested/opencode";
    const runtime = createRuntimePaths({ root: "/tmp/repo", home: "/tmp/home" });
    expect(runtime.opencodeConfigDir).toBe(path.join("/tmp/home", "nested", "opencode"));
  });

  it("resolves root from MFZ_ROOT when no root option is given", () => {
    process.env.MFZ_ROOT = "/env/repo";
    const runtime = createRuntimePaths({ home: "/tmp/home" });
    expect(runtime.root).toBe("/env/repo");
    expect(runtime.configsDir).toBe(path.join("/env/repo", "configs"));
  });
});

describe("target list helpers", () => {
  it("expands the all infra target to every non-agent target", () => {
    expect(infraTargetList("all")).toEqual(["mise", "dotfiles"]);
  });

  it("preserves a specific infra target", () => {
    expect(infraTargetList("mise")).toEqual(["mise"]);
  });

  it("expands the all agent target to the profile agent order", () => {
    expect(agentList("all", ["claude-code", "opencode"])).toEqual(["claude-code", "opencode"]);
  });

  it("preserves a specific agent target", () => {
    expect(agentList("opencode", ["claude-code", "opencode"])).toEqual(["opencode"]);
  });
});
