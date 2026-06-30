import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import type { ResolvedProfile } from "../core/profile.js";
import { isStaleRemoteRefError, syncReference } from "./references.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncReference", () => {
  it("prunes origin and retries once when git reports stale remote refs", async () => {
    const referencesDir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-refs-test-"));
    await mkdir(path.join(referencesDir, "datadog-agent"));
    const profile = makeProfile(referencesDir);
    const staleRefError = Object.assign(new Error("pull failed"), {
      stderr:
        "error: some local refs could not be updated; try running\n 'git remote prune origin' to remove any old, conflicting branches"
    });

    vi.mocked(execa)
      .mockRejectedValueOnce(staleRefError)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never);

    await expect(syncReference(profile, "datadog-agent")).resolves.toBe(
      `updated datadog-agent at ${path.join(referencesDir, "datadog-agent")}`
    );

    expect(execa).toHaveBeenNthCalledWith(
      1,
      "git",
      ["-C", path.join(referencesDir, "datadog-agent"), "pull", "--ff-only"],
      { stdio: "pipe" }
    );
    expect(execa).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-C", path.join(referencesDir, "datadog-agent"), "remote", "prune", "origin"],
      { stdio: "pipe" }
    );
    expect(execa).toHaveBeenNthCalledWith(
      3,
      "git",
      ["-C", path.join(referencesDir, "datadog-agent"), "pull", "--ff-only"],
      { stdio: "pipe" }
    );
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
    manifests: { references: [], skills: [], mcpServers: [] }
  } as unknown as ResolvedProfile;
}
