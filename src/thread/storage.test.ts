import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { machineSchema, type MachineManifest } from "../core/manifests.js";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  defaultThreadStore,
  listThreads,
  readThreadManifest,
  recordSessions,
  resolveSynthesisDefaults,
  resolveThreadStores,
  writeThreadManifest,
  type ResolvedThreadStore,
  type ThreadManifest
} from "./storage.js";
import { execa } from "execa";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    workRoot: path.join(home, ".mindframe-z", "work", "v1"),
    workUnitsRoot: path.join(home, ".mindframe-z", "work", "v1", "units"),
    configsDir: path.join(home, ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

function machine(stores: MachineManifest["thread"]["stores"]): MachineManifest {
  return {
    references_dir: "~/.mindframe-z/references",
    extra_folders: [],
    git: {},
    sandbox: {},
    thread: { stores },
    work: {},
    archives: [],
    opencode: {},
    claude: {}
  };
}

function profile(manifest: MachineManifest, root: string): ResolvedProfile {
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
      opencode: {
        config: {},
        dependencies: {},
        plugins: [],
        tui: {},
        tui_plugins: [],
        commands: [],
        agents: []
      },
      claude: { settings: {} },
      codex: { config: {}, plugins: {} },
      pi: { settings: {}, subagent_config: {} },
      mise: { tools: {}, env: {}, tool_alias: {}, settings: {} },
      thread: {
        stores: [
          {
            name: "personal",
            root,
            path: "personal-threads",
            publication: "direct",
            default: true
          },
          { name: "work", root, path: "work-threads", publication: "direct", default: false }
        ],
        defaults: {},
        credentials: "subscription"
      },
      dotfiles: {},
      extra_folders: []
    },
    manifests: {
      homeManifest: {},
      root,
      aliasPath: [],
      references: [],
      skills: [],
      mcpServers: {},
      profiles: new Map(),
      machine: manifest
    },
    sources: {
      references: new Map(),
      skills: new Map(),
      mcp: new Map(),
      instructions: new Map(),
      plugins: new Map(),
      commands: new Map(),
      agents: new Map()
    },
    instructionFiles: [],
    referencesDir: path.join(root, "references"),
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    mcpServers: [],
    extraFolders: []
  };
}

function thread(slug: string, store: string): ThreadManifest {
  return {
    slug,
    charter: "Track the thread feature.",
    store,
    created_at: "2026-06-27T00:00:00.000Z",
    sessions: [],
    excluded: [],
    synthesis: {}
  };
}

describe("thread storage", () => {
  it("composes stores from profile and machine config with machine precedence", async () => {
    const home = await makeTempDir();
    const resolved = resolveThreadStores(
      paths(home),
      profile(
        machine([
          { name: "work", root: home, path: "work-threads", publication: "direct", default: true }
        ]),
        home
      )
    );
    expect(resolved.map((store) => [store.name, store.default])).toEqual([
      ["personal", false],
      ["work", true]
    ]);
    expect(defaultThreadStore(resolved)?.name).toBe("work");
  });

  it("requires configured stores and does not synthesize a home store", async () => {
    const home = await makeTempDir();
    const empty = profile(machine([]), home);
    empty.profile.thread.stores = [];
    expect(resolveThreadStores(paths(home), empty)).toEqual([]);
  });

  it("resolves paths beneath the configured repository root and rejects traversal", async () => {
    const home = await makeTempDir();
    const resolved = resolveThreadStores(
      paths(home),
      profile(
        machine([
          {
            name: "personal",
            root: path.join(home, "knowledge"),
            path: "threads",
            publication: "direct",
            default: true
          }
        ]),
        home
      )
    );
    expect(resolved[0]?.path).toBe(path.join(home, "knowledge", "threads"));
    expect(() =>
      machineSchema.parse({
        thread: { stores: [{ name: "bad", root: home, path: "../outside", publication: "direct" }] }
      })
    ).toThrow();
  });

  it("round-trips the strict canonical manifest", async () => {
    const dir = path.join(await makeTempDir(), "thread-a");
    await writeThreadManifest(dir, thread("thread-a", "personal"));
    expect(await readThreadManifest(dir)).toEqual(thread("thread-a", "personal"));
  });

  it("rejects misplaced manifests and duplicate slugs across active stores", async () => {
    const home = await makeTempDir();
    const resolved = profile(
      machine([
        { name: "one", root: home, path: "one-threads", publication: "direct", default: true },
        { name: "two", root: home, path: "two-threads", publication: "direct", default: false }
      ]),
      home
    );
    resolved.profile.thread.stores = [
      { name: "one", root: home, path: "one-threads", publication: "direct", default: true },
      { name: "two", root: home, path: "two-threads", publication: "direct", default: false }
    ];
    await mkdir(path.join(home, "personal-threads"), { recursive: true });
    await writeThreadManifest(
      path.join(home, "one-threads", "duplicate"),
      thread("duplicate", "one")
    );
    await writeThreadManifest(
      path.join(home, "two-threads", "duplicate"),
      thread("duplicate", "two")
    );
    await expect(listThreads(paths(home), resolved)).rejects.toThrow(/multiple stores/);
    await writeThreadManifest(
      path.join(home, "one-threads", "misplaced"),
      thread("misplaced", "two")
    );
    await expect(listThreads(paths(home), resolved)).rejects.toThrow(/store mismatch/);
  });

  it("preserves provenance and all watermark fields during session upsert", async () => {
    const dir = path.join(await makeTempDir(), "thread-wm");
    await writeThreadManifest(dir, thread("thread-wm", "personal"));
    await recordSessions(dir, [
      {
        id: "session-1",
        source: "claude-code",
        synthesizer: "claude-code:sonnet@high",
        project: "/tmp/project",
        time_range: "today",
        message_count: 12,
        last_message_id: "a1",
        last_activity_at: "2026-06-27T01:00:00.000Z"
      }
    ]);
    expect((await readThreadManifest(dir)).sessions[0]).toMatchObject({
      synthesizer: "claude-code:sonnet@high",
      message_count: 12
    });
  });

  it("rejects legacy destination configuration while accepting pull-request store configuration", () => {
    expect(() => machineSchema.parse({ thread: { destinations: [] } })).toThrow(/unrecognized/i);
    expect(
      machineSchema.parse({
        thread: {
          stores: [
            {
              name: "personal",
              root: "/tmp/personal",
              path: "threads",
              publication: { mode: "pull-request", base: "main", auto_merge: false }
            }
          ]
        }
      })
    ).toMatchObject({ thread: { stores: [{ name: "personal" }] } });
  });

  it("resolves synthesis settings in flag, manifest, profile order", () => {
    expect(
      resolveSynthesisDefaults(
        { synthesize: "claude-code:sonnet@high", gather: "claude-code:haiku@low" },
        { synthesis: { synthesize: "claude-code:opus@high" } },
        { synthesize: "claude-code:sonnet@max" }
      )
    ).toMatchObject({ synthesize: { model: "sonnet", effort: "max" } });
  });

  it("uses one atomic direct commit for a store mutation", async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, "threads"), { recursive: true });
    await execa("git", ["init", "--initial-branch=main"], { cwd: root });
    await execa("git", ["config", "user.email", "test@test"], { cwd: root });
    await execa("git", ["config", "user.name", "Test"], { cwd: root });
    await writeThreadManifest(path.join(root, "threads", "direct"), thread("direct", "local"));
    const store: ResolvedThreadStore = {
      name: "local",
      root,
      path: path.join(root, "threads"),
      publication: "direct",
      default: true
    };
    const { commitThreadChanges } = await import("./publication.js");
    await commitThreadChanges(store, "direct", path.join(root, "threads", "direct"), "seed", false);
    expect(await readFile(path.join(root, "threads", "index.md"), "utf8")).toContain("direct");
  });
});
