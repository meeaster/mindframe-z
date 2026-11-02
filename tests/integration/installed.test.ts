import { lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, setupIntegrationFixture } from "./support.js";

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false
  );
}

// Apply removes the links it installed once a render no longer wants them, whichever profile or
// harness installed them.
describe("installed link record", () => {
  let root: string;
  let home: string;

  const npmrc = () => path.join(home, ".npmrc");
  const claudeSkill = () => path.join(home, ".claude", "skills", "claude-skill");
  const claudeMd = () => path.join(home, ".claude", "CLAUDE.md");
  const commands = () => path.join(home, ".config", "opencode", "commands");

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
    // A thin profile: OpenCode only, no dotfiles, commands, or skills.
    await mkdir(path.join(root, "profiles", "thin"), { recursive: true });
    await writeFile(
      path.join(root, "profiles", "thin", "profile.yml"),
      "name: thin\nagents: [opencode]\n",
      "utf8"
    );

    const applied = await cli("mfz", root, home, ["apply"]);
    expect(applied.exitCode).toBe(0);

    for (const link of [npmrc(), claudeSkill(), claudeMd(), commands()]) {
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    }
  });

  it("removes the previous profile's links, including a harness the new profile drops", async () => {
    // A link the user repointed is theirs now.
    const userClaudeMd = path.join(home, "my-claude.md");
    await writeFile(userClaudeMd, "# mine\n", "utf8");
    await rm(claudeMd());
    await symlink(userClaudeMd, claudeMd());

    const switched = await cli("mfz", root, home, ["--profile", "thin", "apply"]);

    expect(switched.exitCode).toBe(0);

    for (const link of [npmrc(), claudeSkill(), commands()]) {
      expect(await exists(link)).toBe(false);
    }

    expect(await readlink(claudeMd())).toBe(userClaudeMd);
    expect(switched.stdout).toContain("changed since mfz linked it; left in place");
  });

  it("removes only the links of the targets a partial apply renders", async () => {
    const partial = await cli("mfz", root, home, [
      "--profile",
      "thin",
      "apply",
      "--target",
      "dotfiles"
    ]);

    expect(partial.exitCode).toBe(0);
    expect(await exists(npmrc())).toBe(false);
    expect((await lstat(claudeSkill())).isSymbolicLink()).toBe(true);

    const full = await cli("mfz", root, home, ["--profile", "thin", "apply"]);

    expect(full.exitCode).toBe(0);
    expect(await exists(claudeSkill())).toBe(false);
  });

  it("cleans backups beside installed links on request", async () => {
    const backup = `${npmrc()}.mindframe-z.bak-1`;
    await writeFile(backup, "registry=https://old.example\n", "utf8");

    const listed = await cli("mfz", root, home, ["clean", "--backups", "--dry-run"]);

    expect(listed.stdout).toContain(`would remove\tbackup\t${backup}`);
    expect(await exists(backup)).toBe(true);

    await cli("mfz", root, home, ["clean", "--backups"]);
    expect(await exists(backup)).toBe(false);
  });
});
