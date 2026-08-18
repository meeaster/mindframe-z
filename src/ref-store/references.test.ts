import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecaError } from "execa";
import { describe, expect, it } from "vitest";
import { createRuntimePaths, referenceStatePath } from "../core/paths.js";
import { machineSchema, profileSchema, type LoadedManifests } from "../core/manifests.js";
import type { ResolvedProfile } from "../core/profile.js";
import { isStaleRemoteRefError, syncReference, syncReferences } from "./references.js";

describe("syncReference", () => {
  it("prunes origin and retries once when git reports stale remote refs", async () => {
    const referencesDir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-refs-test-"));
    await mkdir(path.join(referencesDir, "datadog-agent"));
    const profile = makeProfile(referencesDir);
    const staleRefError = Object.assign(new ExecaError<{ stdio: "pipe" }>(), {
      stderr:
        "error: some local refs could not be updated; try running\n 'git remote prune origin' to remove any old, conflicting branches"
    });

    const calls: Array<[string, readonly string[], { stdio: "pipe" }]> = [];
    const outcomes: Array<ExecaError<{ stdio: "pipe" }> | undefined> = [
      staleRefError,
      undefined,
      undefined
    ];
    const runGit = async (
      file: string,
      args: readonly string[],
      options: { stdio: "pipe" }
    ): Promise<void> => {
      calls.push([file, args, options]);
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
    };

    await expect(syncReference(profile, "datadog-agent", runGit)).resolves.toBe(
      `updated datadog-agent at ${path.join(referencesDir, "datadog-agent")}`
    );

    expect(calls).toEqual([
      [
        "git",
        ["-C", path.join(referencesDir, "datadog-agent"), "pull", "--ff-only"],
        { stdio: "pipe" }
      ],
      [
        "git",
        ["-C", path.join(referencesDir, "datadog-agent"), "remote", "prune", "origin"],
        { stdio: "pipe" }
      ],
      [
        "git",
        ["-C", path.join(referencesDir, "datadog-agent"), "pull", "--ff-only"],
        { stdio: "pipe" }
      ]
    ]);
  });
});

describe("syncReferences", () => {
  it("starts all references concurrently and returns messages in manifest order", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-refs-state-test-"));
    const profile = makeProfile(path.join(home, "references"));
    profile.enabledReferences = [
      { name: "first", url: "https://example.invalid/first.git", description: "First" },
      { name: "second", url: "https://example.invalid/second.git", description: "Second" }
    ];
    const paths = createRuntimePaths({ home });
    const started: string[] = [];
    const deferred = new Map<
      string,
      { resolve: (message: string) => void; promise: Promise<string> }
    >();
    for (const name of ["first", "second"]) {
      let resolve!: (message: string) => void;
      const promise = new Promise<string>((res) => {
        resolve = res;
      });
      deferred.set(name, { resolve, promise });
    }

    const syncing = syncReferences(paths, profile, async (_profile, name) => {
      started.push(name);
      return deferred.get(name)!.promise;
    });

    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    deferred.get("second")!.resolve("synced second");
    deferred.get("first")!.resolve("synced first");

    await expect(syncing).resolves.toEqual(["synced first", "synced second"]);
  });

  it("waits for all failures, without cleanup or state mutation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-refs-state-test-"));
    const referencesDir = path.join(home, "references");
    const paths = createRuntimePaths({ home });
    await mkdir(path.dirname(referenceStatePath(paths)), { recursive: true });
    await writeFile(
      referenceStatePath(paths),
      JSON.stringify({ version: 1, profiles: { test: ["old-ref"] } }),
      "utf8"
    );
    await mkdir(path.join(referencesDir, "old-ref"), { recursive: true });
    const profile = makeProfile(referencesDir);
    profile.enabledReferences = [
      { name: "first", url: "https://example.invalid/first.git", description: "First" },
      { name: "second", url: "https://example.invalid/second.git", description: "Second" }
    ];
    const started: string[] = [];
    let finishSecond!: () => void;
    const secondFinished = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });

    const syncing = syncReferences(paths, profile, async (_profile, name) => {
      started.push(name);
      if (name === "first") throw new Error("first failed");
      await secondFinished;
      return "synced second";
    });

    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    let settled = false;
    void syncing.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishSecond();

    await expect(syncing).rejects.toThrow("first failed");
    await expect(access(path.join(referencesDir, "old-ref"))).resolves.toBeUndefined();
    await expect(readFile(referenceStatePath(paths), "utf8")).resolves.toBe(
      JSON.stringify({ version: 1, profiles: { test: ["old-ref"] } })
    );
  });

  it("removes only references owned by the previous snapshot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-refs-state-test-"));
    const referencesDir = path.join(home, "references");
    await mkdir(path.join(referencesDir, "old-ref"), { recursive: true });
    await mkdir(path.join(referencesDir, "shared-ref"), { recursive: true });
    await mkdir(path.join(referencesDir, "manual-ref"), { recursive: true });
    await mkdir(path.dirname(referenceStatePath(createRuntimePaths({ home }))), {
      recursive: true
    });
    await writeFile(
      referenceStatePath(createRuntimePaths({ home })),
      JSON.stringify({ version: 1, profiles: { test: ["old-ref"], other: ["shared-ref"] } }),
      "utf8"
    );

    const profile = makeProfile(referencesDir);
    profile.enabledReferences = [
      { name: "new-ref", url: "https://example.invalid/new-ref.git", description: "New" },
      { name: "shared-ref", url: "https://example.invalid/shared-ref.git", description: "Shared" }
    ];
    const paths = createRuntimePaths({ home });

    await expect(
      syncReferences(paths, profile, async (_profile, name) => `synced ${name}`)
    ).resolves.toEqual([
      "synced new-ref",
      "synced shared-ref",
      `removed old-ref at ${path.join(referencesDir, "old-ref")}`
    ]);

    await expect(readFile(path.join(referencesDir, "old-ref"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(path.join(referencesDir, "shared-ref"))).resolves.toBeUndefined();
    await expect(access(path.join(referencesDir, "manual-ref"))).resolves.toBeUndefined();
    await expect(
      readFile(referenceStatePath(paths), "utf8").then((content) => JSON.parse(content))
    ).resolves.toEqual({
      version: 1,
      profiles: { test: ["new-ref", "shared-ref"], other: ["shared-ref"] }
    });
  });
});

describe("isStaleRemoteRefError", () => {
  it("matches git's stale remote-ref diagnostic", () => {
    expect(
      isStaleRemoteRefError(
        Object.assign(new ExecaError<{ stdio: "pipe" }>(), {
          stderr:
            "error: some local refs could not be updated; try running\n 'git remote prune origin' to remove any old, conflicting branches"
        })
      )
    ).toBe(true);
  });

  it("does not match unrelated git failures", () => {
    expect(
      isStaleRemoteRefError(
        Object.assign(new ExecaError<{ stdio: "pipe" }>(), {
          stderr: "fatal: Not possible to fast-forward, aborting."
        })
      )
    ).toBe(false);
  });
});

function makeProfile(referencesDir: string): ResolvedProfile {
  return {
    name: "test",
    agents: [],
    profile: profileSchema.parse({ name: "test" }),
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
    referencesDir,
    enabledReferences: [
      {
        name: "datadog-agent",
        url: "https://github.com/datadog/datadog-agent",
        description: "Datadog Agent reference."
      }
    ],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    enabledOpenCodeV2Commands: [],
    enabledOpenCodeV2Agents: [],
    mcpServers: [],
    extraFolders: [],
    miseLayers: [],
    manifests: {
      homeManifest: {},
      root: referencesDir,
      aliasPath: [],
      references: [],
      skills: [],
      mcpServers: {},
      profiles: new Map(),
      miseFiles: new Map(),
      machine: machineSchema.parse({})
    } satisfies LoadedManifests
  };
}
