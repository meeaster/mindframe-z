import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentList,
  infraTargetList,
  opencodeDataHome,
  opencodeDbPath,
  type RuntimePaths
} from "./paths.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    configsDir: path.join(home, "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
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
