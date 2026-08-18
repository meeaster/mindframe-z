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
