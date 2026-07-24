import { describe, expect, it } from "vitest";
import { unmanagedCandidates } from "./types.js";

describe("unmanagedCandidates", () => {
  it("emits a candidate for every key the profile does not manage", () => {
    const entries = { theme: "dark", statusLine: { type: "command" } };

    expect(unmanagedCandidates(entries, "claude", "claude.settings", new Set())).toEqual([
      { target: "claude", yamlPrefix: "claude.settings", key: "theme", value: "dark" },
      {
        target: "claude",
        yamlPrefix: "claude.settings",
        key: "statusLine",
        value: { type: "command" }
      }
    ]);
  });

  it("drops managed keys and preserves the order of the survivors", () => {
    const entries = { model: "sonnet", theme: "dim", permissions: {}, keybinds: { leader: "x" } };
    const managed = new Set(["model", "permissions"]);

    expect(unmanagedCandidates(entries, "opencode", "opencode.config", managed)).toEqual([
      { target: "opencode", yamlPrefix: "opencode.config", key: "theme", value: "dim" },
      { target: "opencode", yamlPrefix: "opencode.config", key: "keybinds", value: { leader: "x" } }
    ]);
  });

  it("returns no candidates for an empty object", () => {
    expect(unmanagedCandidates({}, "codex", "codex.config", new Set(["model"]))).toEqual([]);
  });
});
