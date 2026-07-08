import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentList,
  archiveCacheRoot,
  createRuntimePaths,
  expandHome,
  globalSkillStatePath,
  infraTargetList,
  opencodeDataHome,
  opencodeDbPath,
  overrideStorePath,
  type RuntimePaths,
  threadCliLogPath,
  threadDestinationRoot,
  threadPath,
  threadRunPath,
  threadRunsRoot,
  threadStoreRoot,
  threadSweepRoot
} from "./paths.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    configsDir: path.join(home, ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
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
    "CODEX_HOME",
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
    expect(runtime.configsDir).toBe(path.join("/tmp/home", ".mindframe-z", "configs"));
    expect(runtime.opencodeConfigDir).toBe(path.join("/tmp/home", ".config", "opencode"));
    expect(runtime.claudeDir).toBe(path.join("/tmp/home", ".claude"));
    expect(runtime.codexDir).toBe(path.join("/tmp/home", ".codex"));
    expect(runtime.miseConfigDir).toBe(path.join("/tmp/home", ".config", "mise"));
  });

  it("reads tool config dirs from environment overrides", () => {
    process.env.OPENCODE_CONFIG_DIR = "/env/opencode";
    process.env.CLAUDE_CONFIG_DIR = "/env/claude";
    process.env.CODEX_HOME = "/env/codex";
    process.env.MISE_CONFIG_DIR = "/env/mise";
    const runtime = createRuntimePaths({ root: "/tmp/repo", home: "/tmp/home" });
    expect(runtime.opencodeConfigDir).toBe("/env/opencode");
    expect(runtime.claudeDir).toBe("/env/claude");
    expect(runtime.codexDir).toBe("/env/codex");
    expect(runtime.miseConfigDir).toBe("/env/mise");
  });

  it("prefers explicit options over environment overrides", () => {
    process.env.OPENCODE_CONFIG_DIR = "/env/opencode";
    process.env.CLAUDE_CONFIG_DIR = "/env/claude";
    const runtime = createRuntimePaths({
      root: "/tmp/repo",
      home: "/tmp/home",
      opencodeConfigDir: "/opt/opencode",
      claudeDir: "/opt/claude",
      codexDir: "/opt/codex"
    });
    expect(runtime.opencodeConfigDir).toBe("/opt/opencode");
    expect(runtime.claudeDir).toBe("/opt/claude");
    expect(runtime.codexDir).toBe("/opt/codex");
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
    expect(runtime.configsDir).toBe(path.join("/tmp/home", ".mindframe-z", "configs"));
  });
});

describe("expandHome", () => {
  it("returns the home directory for a bare tilde", () => {
    expect(expandHome("~", "/tmp/home")).toBe("/tmp/home");
  });

  it("joins tilde-slash paths onto home", () => {
    expect(expandHome("~/nested/dir", "/tmp/home")).toBe(path.join("/tmp/home", "nested", "dir"));
  });

  it("leaves non-tilde paths untouched", () => {
    expect(expandHome("/abs/path", "/tmp/home")).toBe("/abs/path");
    expect(expandHome("relative/path", "/tmp/home")).toBe("relative/path");
  });
});

describe(".mindframe-z store path contract", () => {
  const home = "/tmp/store-home";
  const runtime = paths(home);
  const mfz = path.join(home, ".mindframe-z");

  it("pins the per-agent skill override state path", () => {
    expect(globalSkillStatePath(runtime, "claude-code")).toBe(
      path.join(mfz, "skill-overrides", "claude-code.json")
    );
  });

  it("pins the override store path from a home directory", () => {
    expect(overrideStorePath(home)).toBe(path.join(mfz, "overrides.json"));
  });

  it("pins the thread store root and per-slug path", () => {
    expect(threadStoreRoot(runtime)).toBe(path.join(mfz, "threads"));
    expect(threadPath(runtime, "my-slug")).toBe(path.join(mfz, "threads", "my-slug"));
  });

  it("pins the archive cache root", () => {
    expect(archiveCacheRoot(runtime)).toBe(path.join(mfz, "archive-cache"));
  });

  it("pins the thread destination root", () => {
    expect(threadDestinationRoot(runtime, "dest")).toBe(
      path.join(mfz, "thread-destinations", "dest")
    );
  });

  it("pins the thread run roots, per-run path, and cli log", () => {
    expect(threadRunsRoot(runtime)).toBe(path.join(mfz, "thread-runs", "runs"));
    expect(threadRunPath(runtime, "run-1")).toBe(path.join(mfz, "thread-runs", "runs", "run-1"));
    expect(threadCliLogPath(runtime)).toBe(path.join(mfz, "thread-runs", "cli.log"));
  });

  it("pins the thread sweep root", () => {
    expect(threadSweepRoot(runtime)).toBe(path.join(mfz, "thread-sweep"));
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
