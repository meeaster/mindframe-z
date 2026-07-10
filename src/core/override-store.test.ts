import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimePaths } from "./paths.js";
import type { ResolvedProfile } from "./profile.js";
import {
  readOverrideStore,
  renderAllPayloads,
  writeProjectOverrideDelta
} from "./override-store.js";

async function tmpPaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-overrides-"));
  return {
    root,
    home: path.join(root, "home"),
    configsDir: path.join(root, "home", ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(root, "opencode"),
    claudeDir: path.join(root, "claude"),
    codexDir: path.join(root, "codex"),
    piDir: path.join(root, "pi", "agent"),
    miseConfigDir: path.join(root, "mise")
  };
}

function profile(codexDefault: boolean): ResolvedProfile {
  return {
    mcpServers: [
      {
        name: "jira",
        agents: { codex: codexDefault },
        server: { type: "remote", url: "https://jira.invalid", description: "" }
      }
    ],
    enabledSkills: []
  } as unknown as ResolvedProfile;
}

describe("override store", () => {
  it("aborts corrupt reads without truncating the file", async () => {
    const paths = await tmpPaths();
    const file = path.join(paths.home, ".mindframe-z", "overrides.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json", "utf8");

    await expect(readOverrideStore(paths.home)).rejects.toThrow(file);
    await expect(readFile(file, "utf8")).resolves.toBe("not json");
  });

  it("stores only deltas and prunes entries returned to default", async () => {
    const paths = await tmpPaths();
    const projectRoot = path.join(paths.root, "repo");

    await writeProjectOverrideDelta(paths, profile(false), projectRoot, "codex", "mcp", {
      jira: true
    });
    expect((await readOverrideStore(paths.home)).projects[projectRoot]?.codex?.mcp).toEqual({
      jira: true
    });

    await writeProjectOverrideDelta(paths, profile(false), projectRoot, "codex", "mcp", {
      jira: false
    });
    expect((await readOverrideStore(paths.home)).projects).toEqual({});
  });

  it("re-renders stored payloads after profile defaults change", async () => {
    const paths = await tmpPaths();
    const projectRoot = path.join(paths.root, "repo");

    await writeProjectOverrideDelta(paths, profile(false), projectRoot, "codex", "mcp", {
      jira: true
    });
    expect(
      (await readOverrideStore(paths.home)).projects[projectRoot]?.codex?.payload?.argv
    ).toEqual(["-c", "mcp_servers.jira.enabled=true"]);

    await renderAllPayloads(paths, profile(true));
    expect((await readOverrideStore(paths.home)).projects).toEqual({});
  });
});
