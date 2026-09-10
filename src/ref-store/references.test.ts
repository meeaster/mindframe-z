import { ExecaError } from "execa";
import { describe, expect, it } from "vitest";
import { isStaleRemoteRefError } from "./references.js";

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
