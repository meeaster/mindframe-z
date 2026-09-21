import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { fetchCommit, readGitSkillFiles } from "./git.js";
import { createRuntimePaths } from "../core/paths.js";

describe("Git skill extraction", () => {
  it("reads exact commits with executable and binary content", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "mfz-git-skill-"));
    await execa("git", ["init", "-q"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    await execa("git", ["config", "user.name", "Mindframe Test"], { cwd: repo });
    const source = path.join(repo, "skills", "test-skill");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: test-skill\ndescription: test\n---\n",
      "utf8"
    );
    await writeFile(path.join(source, "helper.sh"), "#!/bin/sh\n", "utf8");
    await chmod(path.join(source, "helper.sh"), 0o755);
    await writeFile(path.join(source, "payload.bin"), Buffer.from([0, 1, 2, 3]));
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-qm", "initial"], { cwd: repo });
    const { stdout: commit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });

    const files = await readGitSkillFiles(path.join(repo, ".git"), commit, "skills/test-skill");

    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "helper.sh", "payload.bin"]);
    expect(files.find((file) => file.path === "helper.sh")?.mode).toBe("100755");
    expect(files.find((file) => file.path === "payload.bin")?.bytes).toEqual(
      await readFile(path.join(source, "payload.bin"))
    );

    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: test-skill\ndescription: moved\n---\n",
      "utf8"
    );
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-qm", "moved"], { cwd: repo });
    const { stdout: movedCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });
    expect(
      (await readGitSkillFiles(path.join(repo, ".git"), commit, "skills/test-skill"))
        .find((file) => file.path === "SKILL.md")
        ?.bytes.toString()
    ).toContain("description: test");
    expect(
      (await readGitSkillFiles(path.join(repo, ".git"), movedCommit, "skills/test-skill"))
        .find((file) => file.path === "SKILL.md")
        ?.bytes.toString()
    ).toContain("description: moved");
  });

  it("reports unavailable HTTPS remotes without using ambient Git configuration", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-git-remote-"));
    await expect(
      fetchCommit(
        createRuntimePaths({ root: home, home }),
        "https://127.0.0.1:1/unavailable.git",
        "main"
      )
    ).rejects.toThrow();
  });

  it("extracts a single repository-root skill file", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "mfz-git-root-skill-"));
    await execa("git", ["init", "-q"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    await execa("git", ["config", "user.name", "Mindframe Test"], { cwd: repo });
    await writeFile(
      path.join(repo, "SKILL.md"),
      "---\nname: root-skill\ndescription: test\n---\n",
      "utf8"
    );
    await writeFile(path.join(repo, "README.md"), "not part of the skill\n", "utf8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-qm", "initial"], { cwd: repo });
    const { stdout: commit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });

    const files = await readGitSkillFiles(path.join(repo, ".git"), commit, "SKILL.md");

    expect(files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("rejects symlink and gitlink entries from a selected tree", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "mfz-git-special-"));
    await execa("git", ["init", "-q"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    await execa("git", ["config", "user.name", "Mindframe Test"], { cwd: repo });
    const source = path.join(repo, "skills", "test-skill");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: test-skill\ndescription: test\n---\n",
      "utf8"
    );
    await symlink("SKILL.md", path.join(source, "linked.md"));
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-qm", "symlink"], { cwd: repo });
    const { stdout: symlinkCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });
    await expect(
      readGitSkillFiles(path.join(repo, ".git"), symlinkCommit, "skills/test-skill")
    ).rejects.toThrow(/unsupported Git entry/);

    const nested = path.join(repo, "nested");
    await mkdir(nested, { recursive: true });
    await execa("git", ["init", "-q"], { cwd: nested });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: nested });
    await execa("git", ["config", "user.name", "Mindframe Test"], { cwd: nested });
    await writeFile(path.join(nested, "README.md"), "nested\n", "utf8");
    await execa("git", ["add", "."], { cwd: nested });
    await execa("git", ["commit", "-qm", "nested"], { cwd: nested });
    await execa("git", ["add", "nested"], { cwd: repo });
    await execa("git", ["commit", "-qm", "gitlink"], { cwd: repo });
    const { stdout: gitlinkCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });
    await expect(
      readGitSkillFiles(path.join(repo, ".git"), gitlinkCommit, "nested")
    ).rejects.toThrow(/unsupported Git entry/);
  });
});
