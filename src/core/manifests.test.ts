import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifests, validateManifests } from "./manifests.js";

// Every case builds its own root + home under os.tmpdir() and passes `home`
// explicitly, so nothing here reads the operator's real ~/.mindframe-z.
async function tmpHome(): Promise<{ root: string; home: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-manifests-"));
  const root = path.join(base, "root");
  const home = path.join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(root, "mfz_home.yml"), "description: Test home\n", "utf8");
  return { root, home };
}

async function writeProfile(root: string, dir: string, yaml: string): Promise<string> {
  const full = path.join(root, "profiles", dir);
  await mkdir(full, { recursive: true });
  await writeFile(path.join(full, "profile.yml"), yaml, "utf8");
  return full;
}

describe("loadManifests", () => {
  it("refuses a root without mfz_home.yml", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-manifests-"));
    await expect(loadManifests(base, base)).rejects.toThrow(/Missing mfz_home\.yml/);
  });

  it("treats a missing profiles dir as no profiles and fills machine defaults", async () => {
    const { root, home } = await tmpHome();
    const manifests = await loadManifests(root, home);
    expect([...manifests.profiles.keys()]).toEqual([]);
    expect(manifests.references).toEqual([]);
    expect(manifests.skills).toEqual([]);
    expect(manifests.mcpServers).toEqual({});
    expect(manifests.machine.references_dir).toBe("~/.mindframe-z/references");
    expect(manifests.machine.thread).toEqual({ destinations: [] });
    expect(manifests.machine.archives).toEqual([]);
  });

  it("hands each call its own machine defaults object", async () => {
    const { root, home } = await tmpHome();
    const first = await loadManifests(root, home);
    first.machine.extra_folders.push({
      path: "/tmp/leak",
      description: "",
      read: "allow",
      edit: "allow"
    });
    const second = await loadManifests(root, home);
    expect(second.machine.extra_folders).toEqual([]);
  });

  it("keys profiles by manifest name and ignores dirs without a profile.yml", async () => {
    const { root, home } = await tmpHome();
    await writeProfile(root, "base", "name: base\n");
    // Directory name and manifest name deliberately disagree.
    await writeProfile(root, "personal-dir", "name: personal\nextends: base\n");
    await mkdir(path.join(root, "profiles", "empty"), { recursive: true });
    await writeFile(path.join(root, "profiles", "README.md"), "not a profile\n", "utf8");

    const manifests = await loadManifests(root, home);
    expect([...manifests.profiles.keys()].sort()).toEqual(["base", "personal"]);
    expect(manifests.profiles.get("personal")?.extends).toBe("base");
  });

  it("skips a symlinked profile dir", async () => {
    const { root, home } = await tmpHome();
    const baseDir = await writeProfile(root, "base", "name: base\n");
    await symlink(baseDir, path.join(root, "profiles", "linked"), "dir");

    const manifests = await loadManifests(root, home);
    expect([...manifests.profiles.keys()]).toEqual(["base"]);
  });

  it("surfaces a malformed profile.yml instead of dropping the profile", async () => {
    const { root, home } = await tmpHome();
    await writeProfile(root, "base", "name: base\nunknown_key: nope\n");
    await expect(loadManifests(root, home)).rejects.toThrow();
  });

  it("lets mise.toml override the profile.yml mise block", async () => {
    const { root, home } = await tmpHome();
    const dir = await writeProfile(root, "base", 'name: base\nmise:\n  tools:\n    jq: "1.0"\n');
    await writeFile(
      path.join(dir, "mise.toml"),
      '[tools]\njq = "latest"\n\n[env]\nFOO = "bar"\n\n[settings]\nminimum_release_age = "3d"\n',
      "utf8"
    );

    const mise = (await loadManifests(root, home)).profiles.get("base")?.mise;
    expect(mise?.tools).toEqual({ jq: "latest" });
    expect(mise?.env).toEqual({ FOO: "bar" });
    expect(mise?.settings).toEqual({ minimum_release_age: "3d" });
  });

  it("keeps the profile.yml mise block when mise.toml is malformed", async () => {
    const { root, home } = await tmpHome();
    const dir = await writeProfile(root, "base", 'name: base\nmise:\n  tools:\n    jq: "1.0"\n');
    await writeFile(path.join(dir, "mise.toml"), "[tools\njq = ", "utf8");

    const mise = (await loadManifests(root, home)).profiles.get("base")?.mise;
    expect(mise?.tools).toEqual({ jq: "1.0" });
  });

  it("collects dotfiles recursively and excludes profile.yml and mise.toml", async () => {
    const { root, home } = await tmpHome();
    const dir = await writeProfile(root, "base", "name: base\n");
    await writeFile(path.join(dir, "mise.toml"), '[tools]\njq = "latest"\n', "utf8");
    await writeFile(path.join(dir, ".npmrc"), "min-release-age=3\n", "utf8");
    await mkdir(path.join(dir, "config", "nested"), { recursive: true });
    await writeFile(path.join(dir, "config", "nested", "rc.toml"), "a = 1\n", "utf8");

    const dotfiles = (await loadManifests(root, home)).profiles.get("base")?.dotfiles;
    expect(dotfiles).toEqual({
      ".npmrc": "min-release-age=3\n",
      "config/nested/rc.toml": "a = 1\n"
    });
  });

  it("reads the machine config from the given home", async () => {
    const { root, home } = await tmpHome();
    await mkdir(path.join(home, ".mindframe-z"), { recursive: true });
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      "profile: personal\nreferences_dir: /tmp/refs\n",
      "utf8"
    );

    const manifests = await loadManifests(root, home);
    expect(manifests.machine.profile).toBe("personal");
    expect(manifests.machine.references_dir).toBe("/tmp/refs");
  });
});

describe("validateManifests", () => {
  it("reports only the files that exist, one entry per profile dir", async () => {
    const { root, home } = await tmpHome();
    await writeProfile(root, "base", "name: base\n");
    await mkdir(path.join(root, "profiles", "empty"), { recursive: true });

    const results = await validateManifests(root, home);
    expect(results.map((r) => path.relative(root, r.file)).sort()).toEqual([
      "mfz_home.yml",
      path.join("profiles", "base", "profile.yml")
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("flags a malformed profile without throwing", async () => {
    const { root, home } = await tmpHome();
    await writeProfile(root, "base", "name: base\nunknown_key: nope\n");

    const results = await validateManifests(root, home);
    const profile = results.find((r) => r.file.endsWith(path.join("base", "profile.yml")));
    expect(profile?.ok).toBe(false);
    expect(profile?.error).toBeTruthy();
  });

  it("validates the machine config under the given home", async () => {
    const { root, home } = await tmpHome();
    await mkdir(path.join(home, ".mindframe-z"), { recursive: true });
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      "archives: not-a-list\n",
      "utf8"
    );

    const results = await validateManifests(root, home);
    const machine = results.find((r) => r.file.startsWith(home));
    expect(machine?.ok).toBe(false);
  });

  it("tolerates a root with no profiles dir", async () => {
    const { root, home } = await tmpHome();
    const results = await validateManifests(root, home);
    expect(results.map((r) => path.basename(r.file))).toEqual(["mfz_home.yml"]);
  });
});
