import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../core/profile.js";
import { isStaleRemoteRefError, syncReference } from "./references.js";

describe("syncReference", () => {
  it("prunes origin and retries once when git reports stale remote refs", async () => {
    const referencesDir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-refs-test-"));
    await mkdir(path.join(referencesDir, "datadog-agent"));
    const profile = makeProfile(referencesDir);
    const staleRefError = Object.assign(new Error("pull failed"), {
      stderr:
        "error: some local refs could not be updated; try running\n 'git remote prune origin' to remove any old, conflicting branches"
    });

    const calls: Array<[string, readonly string[], { stdio: "pipe" }]> = [];
    const outcomes: Array<Error | undefined> = [staleRefError, undefined, undefined];
    const runGit = async (
      file: string,
      args: readonly string[],
      options: { stdio: "pipe" }
    ): Promise<void> => {
      calls.push([file, args, options]);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
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

describe("isStaleRemoteRefError", () => {
  it("matches git's stale remote-ref diagnostic", () => {
    expect(
      isStaleRemoteRefError({
        stderr:
          "error: some local refs could not be updated; try running\n 'git remote prune origin' to remove any old, conflicting branches"
      })
    ).toBe(true);
  });

  it("does not match unrelated git failures", () => {
    expect(
      isStaleRemoteRefError({ stderr: "fatal: Not possible to fast-forward, aborting." })
    ).toBe(false);
  });
});

function makeProfile(referencesDir: string): ResolvedProfile {
  return {
    referencesDir,
    enabledReferences: [
      {
        name: "datadog-agent",
        url: "https://github.com/datadog/datadog-agent",
        description: "Datadog Agent reference."
      }
    ],
    manifests: { homeManifest: {}, references: [], skills: [], mcpServers: {} }
  } as unknown as ResolvedProfile;
}
