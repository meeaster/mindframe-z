import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, makeTempDir, parseJson } from "./support.js";

const ClaudePermissions = z.object({ permissions: z.object({ deny: z.array(z.string()) }) });

async function setupDotfilesFixture(): Promise<{ root: string; home: string }> {
  const root = await makeTempDir();
  const home = await makeTempDir();

  await mkdir(path.join(root, "catalog"), { recursive: true });
  await mkdir(path.join(root, "instructions"), { recursive: true });
  await mkdir(path.join(root, "profiles", "base"), { recursive: true });
  await mkdir(path.join(root, "profiles", "personal"), { recursive: true });
  await mkdir(path.join(home, ".mindframe-z"), { recursive: true });
  await writeFile(path.join(root, "mfz-home.yml"), "description: Dotfiles test home\n", "utf8");
  await writeFile(path.join(root, "catalog", "references.yml"), "references: []\n", "utf8");
  await writeFile(path.join(root, "catalog", "skills.yml"), "skills: []\n", "utf8");
  await writeFile(path.join(root, "catalog", "mcp.yml"), "servers: {}\n", "utf8");
  await writeFile(path.join(root, "instructions", "AGENTS.md"), "# Test Agents\n", "utf8");
  await writeFile(
    path.join(root, "profiles", "base", "profile.yml"),
    ["name: base", "instructions:", "  - instructions/AGENTS.md", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "base", ".npmrc"),
    "min-release-age=3\nminimum-release-age=4320\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "personal", "profile.yml"),
    ["name: personal", "extends: base", "agents: [opencode, claude-code]", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(home, ".mindframe-z", "config.yml"),
    ["profile: personal", "references_dir: ~/.mindframe-z/references", ""].join("\n"),
    "utf8"
  );

  return { root, home };
}

describe("dotfiles integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupDotfilesFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  it("writes git identity fragment and preserves existing global git config", async () => {
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/.mindframe-z/references",
        "git:",
        "  name: Test User",
        "  email: test@example.com",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(home, ".gitconfig"),
      ["[alias]", "\tco = checkout", ""].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const fragmentPath = path.join(home, ".mindframe-z", "gitconfig");
    const fragment = await readFile(fragmentPath, "utf8");
    expect(fragment).toContain("[user]");
    expect(fragment).toContain('name = "Test User"');
    expect(fragment).toContain('email = "test@example.com"');

    const gitconfig = await readFile(path.join(home, ".gitconfig"), "utf8");
    expect(gitconfig).toContain("[alias]");
    expect(gitconfig).toContain("\tco = checkout");
    expect(gitconfig.split(`path = ${fragmentPath}`).length - 1).toBe(1);

    const renderedProfile = await readFile(configsPath(home, "personal", "AGENTS.md"), "utf8");
    expect(renderedProfile).not.toContain("Test User");
    expect(renderedProfile).not.toContain("test@example.com");
  });

  it("writes extra_folders index to machine-local path", async () => {
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/.mindframe-z/references",
        "extra_folders:",
        `  - path: ~/code/work/proj`,
        `    description: Work project`,
        `  - path: ~/code/archived`,
        `    read: deny`,
        `    edit: deny`,
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    const index = await readFile(path.join(home, ".mindframe-z", "extra_folders.md"), "utf8");
    expect(index).toContain("# Extra Folders");
    expect(index).toContain(path.join(home, "code", "work", "proj"));
    expect(index).toContain("Work project");
    expect(index).toContain("read: allow, edit: allow");
    expect(index).toContain(path.join(home, "code", "archived"));
    expect(index).toContain("read: deny, edit: deny");
  });

  it("denies managed zsh secrets in Claude settings", async () => {
    await writeFile(
      path.join(root, "profiles", "base", ".zshrc"),
      "alias gs='git status'\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code", "--no-link"]);

    const settings = parseJson(
      ClaudePermissions,
      await readFile(configsPath(home, "personal", "claude", "settings.json"), "utf8")
    );

    const secretsPattern = `/${path.join(home, ".mindframe-z", "secrets")}/**`;
    expect(settings.permissions.deny).toContain(`Read(${secretsPattern})`);
    expect(settings.permissions.deny).toContain(`Edit(${secretsPattern})`);
  });

  it("renders and links merged profile dotfiles", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", ".npmrc"),
      "minimum-release-age-exclude[]=test-pkg\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    expect(result.stdout).toContain("created\tfile");

    const npmrc = await readFile(configsPath(home, "personal", "dotfiles", ".npmrc"), "utf8");
    expect(npmrc).toContain("min-release-age=3");
    expect(npmrc).toContain("minimum-release-age=4320");
    expect(npmrc).toContain("minimum-release-age-exclude[]=test-pkg");

    await expect(realpath(path.join(home, ".npmrc"))).resolves.toBe(
      configsPath(home, "personal", "dotfiles", ".npmrc")
    );
  });

  it("removes the retired opencode2 wrapper", async () => {
    const legacyPath = path.join(root, "profiles", "base", ".local", "bin", "opencode2");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "#!/bin/sh\n", "utf8");

    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    await unlink(legacyPath);
    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    await expect(
      readFile(path.join(home, ".local", "bin", "opencode2"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps managed zsh safe when local include files are absent", async () => {
    await writeFile(path.join(root, "profiles", "base", ".zshrc"), "export TEST_ZSH=1\n", "utf8");

    await cli("mfz", root, home, ["apply", "--target", "dotfiles", "--no-link"]);

    const zshrc = await readFile(configsPath(home, "personal", "dotfiles", ".zshrc"), "utf8");
    expect(zshrc).toContain("if [ -r ");
    expect(zshrc).toContain("source ");
    expect(zshrc).not.toContain("API_KEY=");
    expect(zshrc).not.toContain("TOKEN=");
  });

  it("creates an empty zsh secrets file only when missing", async () => {
    await writeFile(path.join(root, "profiles", "base", ".zshrc"), "export TEST_ZSH=1\n", "utf8");

    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    const secretsPath = path.join(home, ".mindframe-z", "secrets", "zsh.env");
    expect(await readFile(secretsPath, "utf8")).toBe("");

    await writeFile(secretsPath, "export TOKEN=kept\n", "utf8");
    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    expect(await readFile(secretsPath, "utf8")).toBe("export TOKEN=kept\n");
  });

  it("does not create a zsh secrets file with --no-link", async () => {
    await writeFile(path.join(root, "profiles", "base", ".zshrc"), "export TEST_ZSH=1\n", "utf8");

    await cli("mfz", root, home, ["apply", "--target", "dotfiles", "--no-link"]);

    await expect(
      readFile(path.join(home, ".mindframe-z", "secrets", "zsh.env"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
