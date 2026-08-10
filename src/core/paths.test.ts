import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentList,
  archiveCacheRoot,
  createRuntimePaths,
  executorConfigPath,
  executorDataDir,
  executorDesiredPath,
  executorManagedPath,
  extraFoldersIndexPath,
  globalSkillStatePath,
  infraTargetList,
  machineConfigPath,
  mindframeZDir,
  opencodeDataHome,
  opencodeDbPath,
  overrideStorePath,
  referenceIndexPath,
  type RuntimePaths,
  threadCliLogPath,
  threadRunPath,
  threadRunsRoot,
  threadSweepRoot,
  upstreamHomeRoot,
  workBindingsPath,
  workStoreRoot,
  workUnitPath
} from "./paths.js";
import { loadManifests } from "./manifests.js";
import { makeTempDir } from "../../tests/integration/support.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    workRoot: path.join(home, ".mindframe-z", "work", "v1"),
    workUnitsRoot: path.join(home, ".mindframe-z", "work", "v1", "units"),
    configsDir: path.join(home, ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    opencodeV2ConfigDir: path.join(home, ".config", "opencode-v2"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
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
    "OPENCODE_V2_CONFIG_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "PI_CODING_AGENT_DIR",
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
    expect(runtime.workRoot).toBe(path.join("/tmp/home", ".mindframe-z", "work", "v1"));
    expect(runtime.workUnitsRoot).toBe(
      path.join("/tmp/home", ".mindframe-z", "work", "v1", "units")
    );
    expect(runtime.configsDir).toBe(path.join("/tmp/home", ".mindframe-z", "configs"));
    expect(runtime.opencodeConfigDir).toBe(path.join("/tmp/home", ".config", "opencode"));
    expect(runtime.opencodeV2ConfigDir).toBe(path.join("/tmp/home", ".config", "opencode-v2"));
    expect(runtime.claudeDir).toBe(path.join("/tmp/home", ".claude"));
    expect(runtime.codexDir).toBe(path.join("/tmp/home", ".codex"));
    expect(runtime.piDir).toBe(path.join("/tmp/home", ".pi", "agent"));
    expect(runtime.miseConfigDir).toBe(path.join("/tmp/home", ".config", "mise"));
  });

  it("reads tool config dirs from environment overrides", () => {
    process.env.OPENCODE_CONFIG_DIR = "/env/opencode";
    process.env.OPENCODE_V2_CONFIG_DIR = "/env/opencode-v2";
    process.env.CLAUDE_CONFIG_DIR = "/env/claude";
    process.env.CODEX_HOME = "/env/codex";
    process.env.PI_CODING_AGENT_DIR = "/env/pi-agent";
    process.env.MISE_CONFIG_DIR = "/env/mise";
    const runtime = createRuntimePaths({ root: "/tmp/repo", home: "/tmp/home" });
    expect(runtime.opencodeConfigDir).toBe("/env/opencode");
    expect(runtime.opencodeV2ConfigDir).toBe("/env/opencode-v2");
    expect(runtime.claudeDir).toBe("/env/claude");
    expect(runtime.codexDir).toBe("/env/codex");
    expect(runtime.piDir).toBe("/env/pi-agent");
    expect(runtime.miseConfigDir).toBe("/env/mise");
  });

  it("prefers explicit options over environment overrides", () => {
    process.env.OPENCODE_CONFIG_DIR = "/env/opencode";
    process.env.OPENCODE_V2_CONFIG_DIR = "/env/opencode-v2";
    process.env.CLAUDE_CONFIG_DIR = "/env/claude";
    const runtime = createRuntimePaths({
      root: "/tmp/repo",
      home: "/tmp/home",
      opencodeConfigDir: "/opt/opencode",
      opencodeV2ConfigDir: "/opt/opencode-v2",
      claudeDir: "/opt/claude",
      codexDir: "/opt/codex",
      piDir: "/opt/pi-agent"
    });
    expect(runtime.opencodeConfigDir).toBe("/opt/opencode");
    expect(runtime.opencodeV2ConfigDir).toBe("/opt/opencode-v2");
    expect(runtime.claudeDir).toBe("/opt/claude");
    expect(runtime.codexDir).toBe("/opt/codex");
    expect(runtime.piDir).toBe("/opt/pi-agent");
  });

  it("expands a ~-relative override against the resolved home", () => {
    process.env.OPENCODE_CONFIG_DIR = "~/nested/opencode";
    process.env.OPENCODE_V2_CONFIG_DIR = "~/nested/opencode-v2";
    const runtime = createRuntimePaths({ root: "/tmp/repo", home: "/tmp/home" });
    expect(runtime.opencodeConfigDir).toBe(path.join("/tmp/home", "nested", "opencode"));
    expect(runtime.opencodeV2ConfigDir).toBe(path.join("/tmp/home", "nested", "opencode-v2"));
  });

  it("resolves root from MFZ_ROOT when no root option is given", () => {
    process.env.MFZ_ROOT = "/env/repo";
    const runtime = createRuntimePaths({ home: "/tmp/home" });
    expect(runtime.root).toBe("/env/repo");
    expect(runtime.configsDir).toBe(path.join("/tmp/home", ".mindframe-z", "configs"));
  });

  it("reads a durable work-unit root from machine config", async () => {
    const home = await makeTempDir();
    await mkdir(path.join(home, ".mindframe-z"), { recursive: true });
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      "work:\n  units_root: ~/knowledge/work-units\n",
      "utf8"
    );

    const runtime = createRuntimePaths({ root: "/tmp/repo", home });

    expect(runtime.workUnitsRoot).toBe(path.join(home, "knowledge", "work-units"));
    expect(runtime.workRoot).toBe(path.join(home, ".mindframe-z", "work", "v1"));
  });

  // Written at the literal path rather than through machineConfigPath, so this
  // fails if the helper moves as well as if either reader stops using it.
  it("resolves the root and loads the machine manifest from one machine config file", async () => {
    const home = await makeTempDir();
    const root = await makeTempDir();
    await mkdir(path.join(home, ".mindframe-z"), { recursive: true });
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      `home_path: ${JSON.stringify(root)}\nprofile: personal\n`,
      "utf8"
    );
    await writeFile(path.join(root, "mfz_home.yml"), "description: fixture\n", "utf8");

    const runtime = createRuntimePaths({ home });
    const manifests = await loadManifests(root, home);

    expect(runtime.root).toBe(root);
    expect(manifests.machine.home_path).toBe(root);
    expect(manifests.machine.profile).toBe("personal");
  });
});

describe(".mindframe-z store path contract", () => {
  const home = "/tmp/store-home";
  const runtime = paths(home);
  const mfz = path.join(home, ".mindframe-z");

  it("pins the canonical .mindframe-z directory the rest of the layout hangs off", () => {
    expect(mindframeZDir(home)).toBe(mfz);
  });

  it("pins the machine config path shared by root resolution and manifest loading", () => {
    expect(machineConfigPath(home)).toBe(path.join(mfz, "config.yml"));
  });

  it("pins the per-agent skill override state path", () => {
    expect(globalSkillStatePath(runtime, "claude-code")).toBe(
      path.join(mfz, "skill-overrides", "claude-code.json")
    );
  });

  it("pins the override store path from a home directory", () => {
    expect(overrideStorePath(home)).toBe(path.join(mfz, "overrides.json"));
  });

  it("pins the generated reference and extra-folder index paths", () => {
    expect(referenceIndexPath(runtime)).toBe(path.join(mfz, "references.md"));
    expect(extraFoldersIndexPath(runtime)).toBe(path.join(mfz, "extra_folders.md"));
  });

  it("pins the versioned work store paths", () => {
    expect(workStoreRoot(runtime)).toBe(path.join(mfz, "work", "v1"));
    expect(workUnitPath(runtime, "my-work")).toBe(path.join(mfz, "work", "v1", "units", "my-work"));
    expect(workBindingsPath(runtime)).toBe(path.join(mfz, "work", "v1", "bindings.json"));
  });

  it("pins the upstream home clone root that init, apply, and vendoring share", () => {
    expect(upstreamHomeRoot(home, "personal")).toBe(path.join(mfz, "homes", "personal"));
  });

  it("pins the archive cache root", () => {
    expect(archiveCacheRoot(runtime)).toBe(path.join(mfz, "archive-cache"));
  });

  it("pins the thread run roots, per-run path, and cli log", () => {
    expect(threadRunsRoot(runtime)).toBe(path.join(mfz, "threads", "runs"));
    expect(threadRunPath(runtime, "run-1")).toBe(path.join(mfz, "threads", "runs", "run-1"));
    expect(threadCliLogPath(runtime)).toBe(path.join(mfz, "threads", "cli.log"));
  });

  it("pins the thread sweep root", () => {
    expect(threadSweepRoot(runtime)).toBe(path.join(mfz, "threads", "sweep"));
  });

  it("pins the native Executor data path and profile snapshot paths", () => {
    const original = process.env.EXECUTOR_DATA_DIR;
    process.env.EXECUTOR_DATA_DIR = path.join(mfz, "executor-default");
    expect(executorDataDir()).toBe(path.join(mfz, "executor-default"));
    expect(executorConfigPath(runtime, "personal")).toBe(
      path.join(mfz, "configs", "personal", "executor", "executor.jsonc")
    );
    expect(executorDesiredPath(runtime, "personal")).toBe(
      path.join(mfz, "configs", "personal", "executor", "desired.json")
    );
    expect(executorManagedPath(runtime, "personal")).toBe(
      path.join(mfz, "configs", "personal", "executor", "managed.json")
    );
    if (original === undefined) delete process.env.EXECUTOR_DATA_DIR;
    else process.env.EXECUTOR_DATA_DIR = original;
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
