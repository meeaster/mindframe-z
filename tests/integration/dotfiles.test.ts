import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

describe("dotfiles integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
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

    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

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

  it("omits git identity fields when machine identity is absent", async () => {
    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    const fragment = await readFile(path.join(home, ".mindframe-z", "gitconfig"), "utf8");
    expect(fragment).not.toContain("[user]");
    expect(fragment).not.toContain("name =");
    expect(fragment).not.toContain("email =");
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
    expect(index).toContain("Additional directories");
    expect(index).toContain(path.join(home, "code", "work", "proj"));
    expect(index).toContain("Work project");
    expect(index).toContain("read: allow, edit: allow");
    expect(index).toContain(path.join(home, "code", "archived"));
    expect(index).toContain("read: deny, edit: deny");
  });

  it("denies managed zsh secrets in OpenCode config", async () => {
    await writeFile(
      path.join(root, "profiles", "base", ".zshrc"),
      "alias gs='git status'\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const config = JSON.parse(
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ) as {
      permission: { external_directory: Record<string, string>; edit: Record<string, string> };
    };
    const secretsPattern = path.join(home, ".mindframe-z", "secrets", "**");
    expect(config.permission.external_directory[secretsPattern]).toBe("deny");
    expect(config.permission.edit[secretsPattern]).toBe("deny");
    expect(config.permission.edit[path.join(home, ".zshrc")]).toBeUndefined();
  });

  it("denies managed zsh secrets in Claude settings", async () => {
    await writeFile(
      path.join(root, "profiles", "base", ".zshrc"),
      "alias gs='git status'\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code", "--no-link"]);

    const settings = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "settings.json"), "utf8")
    ) as { permissions: { deny?: string[] } };
    const secretsPattern = `/${path.join(home, ".mindframe-z", "secrets")}/**`;
    expect(settings.permissions.deny).toContain(`Read(${secretsPattern})`);
    expect(settings.permissions.deny).toContain(`Edit(${secretsPattern})`);
  });

  it("renders and links .npmrc dotfile from profile folder", async () => {
    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    expect(result.stdout).toContain("rendered");

    const npmrc = await readFile(configsPath(home, "personal", "dotfiles", ".npmrc"), "utf8");
    expect(npmrc).toContain("min-release-age=3");
    expect(npmrc).toContain("minimum-release-age=4320");

    await expect(realpath(path.join(home, ".npmrc"))).resolves.toBe(
      configsPath(home, "personal", "dotfiles", ".npmrc")
    );
  });

  it("renders and links managed .zshrc with guarded local includes", async () => {
    await writeFile(
      path.join(root, "profiles", "base", ".zshrc"),
      "alias gs='git status'\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    expect(result.stdout).toContain("rendered");

    const zshrc = await readFile(configsPath(home, "personal", "dotfiles", ".zshrc"), "utf8");
    expect(zshrc).toContain(path.join(home, ".mindframe-z", "secrets", "zsh.env"));
    expect(zshrc).toContain(path.join(home, ".mindframe-z", "bin"));
    expect(zshrc).toContain("alias gs='git status'");
    expect(zshrc).toContain(path.join(home, ".mindframe-z", ".zshrc"));

    await expect(realpath(path.join(home, ".zshrc"))).resolves.toBe(
      configsPath(home, "personal", "dotfiles", ".zshrc")
    );
  });

  it("keeps managed .zshrc safe when local include files are absent", async () => {
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

  it("concatenates dotfile content from parent and child profiles", async () => {
    // Add a .npmrc to the personal profile folder
    await writeFile(
      path.join(root, "profiles", "personal", ".npmrc"),
      "minimum-release-age-exclude[]=test-pkg\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    expect(result.stdout).toContain("rendered");

    const npmrc = await readFile(configsPath(home, "personal", "dotfiles", ".npmrc"), "utf8");
    expect(npmrc).toContain("min-release-age=3");
    expect(npmrc).toContain("minimum-release-age=4320");
    expect(npmrc).toContain("minimum-release-age-exclude[]=test-pkg");
  });

  it("renders per-project harness launchers that read the overrides store", async () => {
    await writeFile(path.join(root, "profiles", "base", ".zshrc"), "export TEST_ZSH=1\n", "utf8");

    await cli("mfz", root, home, ["apply", "--target", "dotfiles", "--no-link"]);

    const zshrc = await readFile(configsPath(home, "personal", "dotfiles", ".zshrc"), "utf8");
    const storePath = path.join(home, ".mindframe-z", "overrides.json");

    // Every launcher reads the same machine-local overrides store.
    expect(zshrc.split(`local store="${storePath}"`).length - 1).toBe(3);
    expect(zshrc).toContain("local project=$(_mfz_project_root)");

    // codex: injects the stored argv before user args.
    expect(zshrc).toContain(".projects[$project].codex.payload.argv[]");
    expect(zshrc).toContain('command codex "${mfz_argv[@]}" "$@"');

    // opencode: injects the stored config via OPENCODE_CONFIG_CONTENT.
    expect(zshrc).toContain(".projects[$project].opencode.payload.config");
    expect(zshrc).toContain('OPENCODE_CONFIG_CONTENT="$config" command opencode "$@"');

    // claude-code: injects the stored settings via --settings.
    expect(zshrc).toContain('.projects[$project]["claude-code"].payload.settings');
    expect(zshrc).toContain('command claude --settings "$settings" "$@"');

    // Each launcher falls back to the bare command when no override applies.
    expect(zshrc).toContain('command codex "$@"');
    expect(zshrc).toContain('command opencode "$@"');
    expect(zshrc).toContain('command claude "$@"');
  });

  it("renders and links nested dotfiles from profile subdirectories", async () => {
    await mkdir(path.join(root, "profiles", "personal", ".config", "ccstatusline"), {
      recursive: true
    });
    await writeFile(
      path.join(root, "profiles", "personal", ".config", "ccstatusline", "settings.json"),
      '{"version":3,"lines":[]}\n',
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    expect(result.stdout).toContain("rendered");

    const rendered = await readFile(
      configsPath(home, "personal", "dotfiles", ".config", "ccstatusline", "settings.json"),
      "utf8"
    );
    expect(rendered).toContain('"version":3');

    await expect(
      realpath(path.join(home, ".config", "ccstatusline", "settings.json"))
    ).resolves.toBe(
      configsPath(home, "personal", "dotfiles", ".config", "ccstatusline", "settings.json")
    );
  });
});
