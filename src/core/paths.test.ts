import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeDataHome, opencodeDbPath, type RuntimePaths } from "./paths.js";

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
