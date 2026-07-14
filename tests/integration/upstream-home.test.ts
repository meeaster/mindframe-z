import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { cli, configsPath, makeTempDir, writeFixture } from "./support.js";

async function git(root: string, args: string[]) {
  return execa("git", args, { cwd: root });
}

async function commitAll(root: string, message: string) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}

async function initRepo(root: string) {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
}

async function createUpstreamRemote(): Promise<{ source: string; remote: string; repo: string }> {
  const source = await makeTempDir();
  const remote = await makeTempDir();

  await writeFixture(source);
  await writeFile(
    path.join(source, "profiles", "base", "profile.yml"),
    ["name: base", "agents: [opencode]", "instructions:", "  - instructions/AGENTS.md", ""].join(
      "\n"
    ),
    "utf8"
  );
  await initRepo(source);
  await commitAll(source, "initial upstream");

  await execa("git", ["init", "--bare", remote]);
  await git(source, ["remote", "add", "origin", remote]);
  await git(source, ["push", "-u", "origin", "HEAD"]);

  return { source, remote, repo: `file://${remote}` };
}

async function createChildHome(home: string, upstreamRepo: string): Promise<string> {
  const child = await makeTempDir();
  await writeFixture(child, home);
  await writeFile(
    path.join(child, "mfz_home.yml"),
    ["extends:", "  name: personal", `  repo: ${upstreamRepo}`, ""].join("\n"),
    "utf8"
  );
  await mkdir(path.join(child, "profiles", "work"), { recursive: true });
  await writeFile(
    path.join(child, "profiles", "work", "profile.yml"),
    ["name: work", "extends: personal/base", "agents: [opencode]", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(home, ".mindframe-z", "config.yml"),
    ["profile: work", "references_dir: ~/.mindframe-z/references", ""].join("\n"),
    "utf8"
  );
  return child;
}

function managedClone(home: string): string {
  return path.join(home, ".mindframe-z", "homes", "personal");
}

describe("upstream home integration", () => {
  it("clones and fast-forwards a clean upstream home during apply", async () => {
    const home = await makeTempDir();
    const upstream = await createUpstreamRemote();
    const child = await createChildHome(home, upstream.repo);

    await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);
    await expect(
      readFile(path.join(managedClone(home), ".git", "config"), "utf8")
    ).resolves.toContain(upstream.remote);

    await writeFile(
      path.join(upstream.source, "instructions", "AGENTS.md"),
      "# Updated Agents\n",
      "utf8"
    );
    await commitAll(upstream.source, "update guidance");
    await git(upstream.source, ["push"]);

    await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(readFile(configsPath(home, "work", "AGENTS.md"), "utf8")).resolves.toContain(
      "# Updated Agents"
    );
  });

  it("skips pulling a dirty upstream home clone during apply", async () => {
    const home = await makeTempDir();
    const upstream = await createUpstreamRemote();
    const child = await createChildHome(home, upstream.repo);

    await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);
    await writeFile(path.join(managedClone(home), "dirty.txt"), "local edit\n", "utf8");
    await writeFile(
      path.join(upstream.source, "instructions", "AGENTS.md"),
      "# Remote Update\n",
      "utf8"
    );
    await commitAll(upstream.source, "remote update");
    await git(upstream.source, ["push"]);

    const result = await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);

    expect(result.stderr).toContain("upstream home personal is dirty; skipping git pull");
    await expect(readFile(configsPath(home, "work", "AGENTS.md"), "utf8")).resolves.not.toContain(
      "# Remote Update"
    );
  });

  it("skips pulling an upstream home clone with unpushed commits during apply", async () => {
    const home = await makeTempDir();
    const upstream = await createUpstreamRemote();
    const child = await createChildHome(home, upstream.repo);
    const clone = managedClone(home);

    await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);

    // Commit a local change so the clone is ahead of upstream but has a clean tree,
    // isolating the ahead branch from the dirty branch checked first.
    await git(clone, ["config", "user.email", "test@example.com"]);
    await git(clone, ["config", "user.name", "Test User"]);
    await writeFile(path.join(clone, "ahead.txt"), "local commit\n", "utf8");
    await commitAll(clone, "local ahead");

    await writeFile(
      path.join(upstream.source, "instructions", "AGENTS.md"),
      "# Remote Update\n",
      "utf8"
    );
    await commitAll(upstream.source, "remote update");
    await git(upstream.source, ["push"]);

    const result = await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);

    expect(result.stderr).toContain(
      "upstream home personal has unpushed commits; skipping git pull"
    );
    await expect(readFile(configsPath(home, "work", "AGENTS.md"), "utf8")).resolves.not.toContain(
      "# Remote Update"
    );
  });

  it("keeps using an existing upstream clone when pull fails", async () => {
    const home = await makeTempDir();
    const upstream = await createUpstreamRemote();
    const child = await createChildHome(home, upstream.repo);

    await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);
    await git(managedClone(home), [
      "remote",
      "set-url",
      "origin",
      "file:///missing/mfz-upstream-home"
    ]);

    const result = await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);

    expect(result.stderr).toContain(
      "upstream home personal could not update; using existing clone"
    );
    await expect(readFile(configsPath(home, "work", "AGENTS.md"), "utf8")).resolves.toContain(
      "# Test Agents"
    );
  });

  it("sync can assign unmanaged rendered keys to a pushable upstream profile", async () => {
    const home = await makeTempDir();
    const upstream = await createUpstreamRemote();
    const child = await createChildHome(home, upstream.repo);
    await rm(path.join(child, "opencode", "commands"), { recursive: true, force: true });

    await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);
    const opencodePath = configsPath(home, "work", "opencode", "opencode.jsonc");
    const opencode = JSON.parse(await readFile(opencodePath, "utf8")) as Record<string, unknown>;
    opencode.small_model = "test/upstream-small";
    await writeFile(opencodePath, JSON.stringify(opencode, null, 2) + "\n", "utf8");

    const result = await cli("mfz", child, home, ["sync"], {}, "personal/base\n");

    expect(result.stdout).toContain(
      "Updated personal/base/profile.yml: opencode.config.small_model"
    );
    expect(result.stdout).toContain("Written to upstream home personal/base — uncommitted");
    await expect(
      readFile(path.join(managedClone(home), "profiles", "base", "profile.yml"), "utf8")
    ).resolves.toContain("small_model: test/upstream-small");
  }, 15000);

  it("doctor reports dirty, ahead, and stale upstream home clones", async () => {
    const home = await makeTempDir();
    const upstream = await createUpstreamRemote();
    const child = await createChildHome(home, upstream.repo);
    const clone = managedClone(home);

    await cli("mfz", child, home, ["apply", "--agent", "opencode", "--no-link"]);
    await git(clone, ["config", "user.email", "test@example.com"]);
    await git(clone, ["config", "user.name", "Test User"]);
    await writeFile(path.join(clone, "ahead.txt"), "ahead\n", "utf8");
    await commitAll(clone, "local ahead");
    await writeFile(path.join(clone, "dirty.txt"), "dirty\n", "utf8");

    await writeFile(path.join(upstream.source, "remote.txt"), "remote\n", "utf8");
    await commitAll(upstream.source, "remote ahead");
    await git(upstream.source, ["push"]);

    const result = await cli("mfz", child, home, ["doctor"]);

    expect(result.stdout).toContain(`upstream:dirty\tpersonal\t${clone}`);
    expect(result.stdout).toContain("upstream:ahead\tpersonal\t1 commit(s) unpushed");
    expect(result.stdout).toContain("upstream:stale\tpersonal\t1 commit(s) behind");
  });
});
