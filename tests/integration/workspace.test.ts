import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, makeTempDir, setupIntegrationFixture } from "./support.js";

async function git(directory: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", ["-C", directory, ...args]);

  return result.stdout.trim();
}

interface Remote {
  url: string;
  advance: () => Promise<string>;
}

async function createRemote(parent: string, name: string): Promise<Remote> {
  const source = path.join(parent, `${name}-source`);
  const url = path.join(parent, `${name}.git`);
  await mkdir(source, { recursive: true });
  await execa("git", ["init", "--bare", "--initial-branch=main", url]);
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.email", "test@example.com"]);
  await git(source, ["config", "user.name", "Test User"]);
  await writeFile(path.join(source, "README.md"), "one\n", "utf8");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
  await git(source, ["push", url, "main"]);

  let sequence = 1;

  return {
    url,
    async advance() {
      sequence += 1;
      await writeFile(path.join(source, "README.md"), `${sequence}\n`, "utf8");
      await git(source, ["commit", "-am", `change ${sequence}`]);
      await git(source, ["push", url, "main"]);

      return git(source, ["rev-parse", "HEAD"]);
    }
  };
}

async function clone(url: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await execa("git", ["clone", url, destination]);
}

describe("mfz workspace", () => {
  let root: string;
  let home: string;
  let remotes: string;
  let workspace: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
    remotes = await makeTempDir();
    workspace = path.join(home, "workspace");
  });

  // Declares each repository in the home's catalog and selects it from machine config.
  async function writeMachineConfig(declared: Array<{ name: string; url: string }>): Promise<void> {
    await writeFile(
      path.join(root, "catalog", "repos.yml"),
      [
        declared.length === 0 ? "repos: []" : "repos:",
        ...declared.flatMap((repo) => [`  - name: ${repo.name}`, `    url: ${repo.url}`]),
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        `workspace_root: ${workspace}`,
        `repos: [${declared.map((repo) => repo.name).join(", ")}]`,
        ""
      ].join("\n"),
      "utf8"
    );
  }

  it("clones missing declared repositories and fast-forwards only default-branch checkouts outside scratch", async () => {
    const declared = await createRemote(remotes, "declared");
    const shared = await createRemote(remotes, "shared");
    const tracking = path.join(workspace, "repos", "tracking");
    const feature = path.join(workspace, "repos", "feature");
    const scratch = path.join(workspace, "scratch", "pinned");
    await clone(shared.url, tracking);
    await clone(shared.url, feature);
    await git(feature, ["switch", "-c", "topic"]);
    await clone(shared.url, scratch);
    const pinned = await git(scratch, ["rev-parse", "HEAD"]);
    const latest = await shared.advance();
    const declaredPath = path.join(workspace, "repos", "declared");
    await writeMachineConfig([{ name: "declared", url: declared.url }]);

    const result = await cli("mfz", root, home, ["workspace", "sync"]);

    expect(await git(declaredPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await git(tracking, ["rev-parse", "HEAD"])).toBe(latest);
    expect(await git(feature, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("topic");
    expect(await git(scratch, ["rev-parse", "HEAD"])).toBe(pinned);
    expect(result.stdout).toContain(`skipped\trepository\t${feature}\ton topic, not main`);
  });

  it("reports only checkouts with local changes or unpushed commits", async () => {
    const shared = await createRemote(remotes, "shared");
    const clean = path.join(workspace, "repos", "clean");
    const dirty = path.join(workspace, "repos", "dirty");
    await clone(shared.url, clean);
    await clone(shared.url, dirty);
    await writeFile(path.join(dirty, "notes.md"), "draft\n", "utf8");
    await writeMachineConfig([]);

    const result = await cli("mfz", root, home, ["workspace", "status"]);

    expect(result.stdout.split("\n").filter(Boolean)).toEqual(["repos/dirty\tmain\t1\t0\t0"]);
  });
});
