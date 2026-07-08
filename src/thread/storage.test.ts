import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import type { RuntimePaths } from "../core/paths.js";
import type { MachineManifest, ThreadDefaults } from "../core/manifests.js";
import type { ResolvedProfile } from "../core/profile.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  commitThreadChanges,
  deleteThreadFromDestination,
  prepareThreadDestination,
  readThreadManifest,
  readThreadRuns,
  recordSessions,
  resolveSessionSources,
  resolveSynthesisDefaults,
  resolveThreadDestinations,
  syncThreadDestination,
  writeThreadManifest,
  writeThreadRuns,
  type ResolvedThreadDestination,
  type ThreadManifest
} from "./storage.js";

function paths(home: string, root = home): RuntimePaths {
  return {
    root,
    home,
    configsDir: path.join(home, ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

function profile(machine: MachineManifest): ResolvedProfile {
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
        destinations: [
          { name: "personal", default: true, no_push: false },
          { name: "work", default: false, no_push: false }
        ],
        defaults: {
          synthesize: "claude-code:sonnet@high",
          gather: "claude-code:haiku@low",
          discover: "claude-code:sonnet@high",
          session_sources: ["claude-code", "opencode"]
        },
        credentials: "subscription"
      },
      dotfiles: {},
      extra_folders: []
    },
    manifests: {
      homeManifest: {},
      root: "/tmp/home",
      aliasPath: [],
      references: [],
      skills: [],
      mcpServers: {},
      profiles: new Map(),
      machine
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
    referencesDir: "/tmp/references",
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    mcpServers: [],
    extraFolders: []
  };
}

function profileWithDestinations(
  destinations: ResolvedProfile["profile"]["thread"]["destinations"],
  machineManifest: MachineManifest
): ResolvedProfile {
  const resolved = profile(machineManifest);
  resolved.profile.thread.destinations = destinations;
  return resolved;
}

function machine(destinations: MachineManifest["thread"]["destinations"]): MachineManifest {
  return {
    references_dir: "~/.mindframe-z/references",
    extra_folders: [],
    git: {},
    sandbox: {},
    thread: { destinations },
    archives: [],
    opencode: {},
    claude: {}
  };
}

describe("thread storage", () => {
  it("composes destinations from profile and machine config with machine precedence", async () => {
    const home = await makeTempDir();
    const destinations = resolveThreadDestinations(
      paths(home),
      profile(machine([{ name: "work", default: true, no_push: false }]))
    );

    expect(destinations.map((destination) => [destination.name, destination.default])).toEqual([
      ["personal", false],
      ["work", true],
      ["home", false]
    ]);
  });

  it("defaults to the active home threads folder without configured destinations", async () => {
    const home = await makeTempDir();
    const root = path.join(home, "mfz-home");
    const destinations = resolveThreadDestinations(
      paths(home, root),
      profileWithDestinations([], machine([]))
    );

    expect(
      destinations.map((destination) => [destination.name, destination.default, destination.path])
    ).toContainEqual(["home", true, path.join(root, "threads")]);
  });

  it("keeps home as the default when destinations only add non-default remotes", async () => {
    const home = await makeTempDir();
    const root = path.join(home, "mfz-home");
    const destinations = resolveThreadDestinations(
      paths(home, root),
      profileWithDestinations(
        [
          {
            name: "personal",
            remote: "git@example.com:me/threads.git",
            default: false,
            no_push: false
          }
        ],
        machine([])
      )
    );

    expect(destinations.map((destination) => [destination.name, destination.default])).toEqual([
      ["personal", false],
      ["home", true]
    ]);
  });

  it("resolves destination paths relative to the active home", async () => {
    const home = await makeTempDir();
    const root = path.join(home, "mfz-home");
    const [destination] = resolveThreadDestinations(
      paths(home, root),
      profileWithDestinations(
        [],
        machine([{ name: "work", path: "threads", default: true, no_push: false }])
      )
    );

    expect(destination?.path).toBe(path.join(root, "threads"));
  });

  it("round-trips manifest and runs files", async () => {
    const dir = path.join(await makeTempDir(), "thread-a");
    const manifest: ThreadManifest = {
      slug: "thread-a",
      charter: "Track the thread feature.",
      destination: "personal",
      created_at: "2026-06-27T00:00:00.000Z",
      sessions: [{ id: "session-1", source: "claude-code" }],
      synthesis: {}
    };

    await writeThreadManifest(dir, manifest);
    await writeThreadRuns(dir, { runs: [] });

    expect((await readThreadManifest(dir)).sessions[0]?.id).toBe("session-1");
    expect(await readThreadRuns(dir)).toEqual({ runs: [] });
    expect(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"))).toMatchObject({
      slug: "thread-a"
    });
  });

  it("persists watermark fields for an ingested session", async () => {
    const dir = path.join(await makeTempDir(), "thread-wm");
    await writeThreadManifest(dir, {
      slug: "thread-wm",
      charter: "Track watermarks.",
      destination: "personal",
      created_at: "2026-06-27T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    });

    await recordSessions(dir, [
      {
        id: "session-1",
        source: "claude-code",
        extracted_by: "claude-code:sonnet@high",
        message_count: 12,
        last_message_id: "a1",
        last_activity_at: "2026-06-27T01:00:00.000Z"
      }
    ]);

    expect((await readThreadManifest(dir)).sessions[0]).toMatchObject({
      id: "session-1",
      message_count: 12,
      last_message_id: "a1",
      last_activity_at: "2026-06-27T01:00:00.000Z"
    });
  });

  it("round-trips a session entry that has no watermark", async () => {
    const dir = path.join(await makeTempDir(), "thread-no-wm");
    await writeThreadManifest(dir, {
      slug: "thread-no-wm",
      charter: "Track watermarks.",
      destination: "personal",
      created_at: "2026-06-27T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    });

    await recordSessions(dir, [
      { id: "session-1", source: "opencode", extracted_by: "claude-code:sonnet@high" }
    ]);

    const session = (await readThreadManifest(dir)).sessions[0];
    expect(session).toMatchObject({ id: "session-1", source: "opencode" });
    expect(session?.message_count).toBeUndefined();
    expect(session?.last_message_id).toBeUndefined();
  });

  it("keys the upsert by source:id so same-id sessions from different sources coexist", async () => {
    const dir = path.join(await makeTempDir(), "thread-collide");
    await writeThreadManifest(dir, {
      slug: "thread-collide",
      charter: "Track watermarks.",
      destination: "personal",
      created_at: "2026-06-27T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    });

    await recordSessions(dir, [
      { id: "shared", source: "claude-code", extracted_by: "claude-code:sonnet@high" },
      { id: "shared", source: "opencode", extracted_by: "claude-code:sonnet@high" }
    ]);

    const sessions = (await readThreadManifest(dir)).sessions;
    expect(sessions.map((s) => `${s.source}:${s.id}`).sort()).toEqual([
      "claude-code:shared",
      "opencode:shared"
    ]);
  });

  it("resolves session sources: profile default, then validated flags", () => {
    const defaults: ThreadDefaults = {
      synthesize: "claude-code:sonnet@high",
      gather: "claude-code:haiku@low",
      discover: "claude-code:sonnet@high",
      session_sources: ["opencode"]
    };
    // No flags → the profile default is honored verbatim.
    expect(resolveSessionSources(defaults)).toEqual(["opencode"]);
    // Absent profile value → both harnesses (default at point of use).
    expect(resolveSessionSources({ ...defaults, session_sources: undefined })).toEqual([
      "claude-code",
      "opencode"
    ]);
    // Flags override and are validated against the harness enum.
    expect(resolveSessionSources(defaults, ["opencode"])).toEqual(["opencode"]);
    expect(() => resolveSessionSources(defaults, ["nope"])).toThrow();
    expect(() => resolveSessionSources(defaults, [])).toThrow(/at least one/);
  });

  it("initializes an absent destination as a git repository", async () => {
    const home = await makeTempDir();
    const [destination] = resolveThreadDestinations(
      paths(home),
      profile(machine([{ name: "local", default: true, no_push: false }]))
    );

    await prepareThreadDestination(paths(home), destination!);

    await expect(stat(path.join(destination!.path, ".git"))).resolves.toBeDefined();
  });

  it("resolves synthesis settings with flag, manifest, then profile precedence", () => {
    const manifest = { synthesis: { synthesize: "claude-code:opus@high" } };
    expect(
      resolveSynthesisDefaults(
        {
          synthesize: "claude-code:sonnet@high",
          gather: "claude-code:haiku@low",
          discover: "claude-code:sonnet@high",
          session_sources: ["claude-code", "opencode"]
        },
        manifest,
        { synthesize: "claude-code:sonnet@max" }
      )
    ).toEqual({
      discover: { harness: "claude-code", model: "sonnet", effort: "high" },
      gather: { harness: "claude-code", model: "haiku", effort: "low" },
      synthesize: { harness: "claude-code", model: "sonnet", effort: "max" },
      // digest unset everywhere → inherits the resolved synthesize id
      digest: { harness: "claude-code", model: "sonnet", effort: "max" },
      triage: { harness: "claude-code", model: "haiku", effort: "low" }
    });
  });

  it("resolves digest independently of synthesize when set", () => {
    const resolved = resolveSynthesisDefaults(
      {
        synthesize: "claude-code:claude-sonnet-5@low",
        digest: "claude-code:claude-sonnet-5@high"
      },
      { synthesis: {} }
    );
    expect(resolved.synthesize).toEqual({
      harness: "claude-code",
      model: "claude-sonnet-5",
      effort: "low"
    });
    expect(resolved.digest).toEqual({
      harness: "claude-code",
      model: "claude-sonnet-5",
      effort: "high"
    });
  });

  it("deletes a thread from a destination repo", async () => {
    const home = await makeTempDir();
    const [destination] = resolveThreadDestinations(
      paths(home),
      profile(machine([{ name: "local", default: true, no_push: true }]))
    ) as [ResolvedThreadDestination];

    await prepareThreadDestination(paths(home), destination);
    const threadDir = path.join(home, "threads", "thread-del");
    const manifest: ThreadManifest = {
      slug: "thread-del",
      charter: "Test delete",
      destination: "local",
      created_at: "2026-06-27T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    };
    await writeThreadManifest(threadDir, manifest);

    await commitThreadChanges(destination, "thread-del", threadDir, "add thread-del", false);

    await deleteThreadFromDestination(destination, "thread-del", false);

    await expect(access(path.join(destination.path, "thread-del"))).rejects.toThrow();
  });

  it("syncs a destination with a remote pulls changes back to the store", async () => {
    const home = await makeTempDir();
    const bareDir = await makeTempDir();
    const cloneDir = await makeTempDir();

    // Set up a bare repo as the remote
    await execa("git", ["init", "--bare", bareDir]);

    // Clone as the destination
    await execa("git", ["clone", bareDir, cloneDir]);
    await execa("git", ["config", "user.email", "test@test"], { cwd: cloneDir });
    await execa("git", ["config", "user.name", "Test"], { cwd: cloneDir });

    const destination: ResolvedThreadDestination = {
      name: "remote-dest",
      path: cloneDir,
      remote: bareDir,
      default: true,
      no_push: false
    };

    // Create a thread and commit/push to the remote
    const threadDir = path.join(home, "threads", "thread-sync");
    const manifest: ThreadManifest = {
      slug: "thread-sync",
      charter: "Test sync",
      destination: "remote-dest",
      created_at: "2026-06-27T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    };
    await writeThreadManifest(threadDir, manifest);
    await commitThreadChanges(destination, "thread-sync", threadDir, "add thread-sync", true);

    // Now modify the thread data on a "different machine" by cloning and pushing
    const otherClone = await makeTempDir();
    await execa("git", ["clone", bareDir, otherClone]);
    await execa("git", ["config", "user.email", "test@test"], { cwd: otherClone });
    await execa("git", ["config", "user.name", "Test"], { cwd: otherClone });
    const updatedManifest = { ...manifest, charter: "Updated charter" };
    await writeThreadManifest(path.join(otherClone, "thread-sync"), updatedManifest);
    await execa("git", ["add", "."], { cwd: otherClone });
    await execa("git", ["commit", "-m", "update charter"], { cwd: otherClone });
    await execa("git", ["push"], { cwd: otherClone });

    // Sync should pull the change back into the destination and then to the store
    const storeRoot = path.join(home, "threads");
    const updated = await syncThreadDestination(destination, storeRoot);

    expect(updated).toContain("thread-sync");
    const syncedManifest = await readThreadManifest(path.join(storeRoot, "thread-sync"));
    expect(syncedManifest.charter).toBe("Updated charter");
  });

  it("sync skips destinations without a remote", async () => {
    const home = await makeTempDir();
    const [destination] = resolveThreadDestinations(
      paths(home),
      profile(machine([{ name: "local", default: true, no_push: true }]))
    ) as [ResolvedThreadDestination];

    await prepareThreadDestination(paths(home), destination);

    const storeRoot = path.join(home, "threads");
    const result = await syncThreadDestination(destination, storeRoot);

    expect(result).toEqual([]);
  });
});
