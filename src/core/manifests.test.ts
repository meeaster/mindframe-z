import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  homeManifestSchema,
  loadManifests,
  mcpServerSchema,
  skillSchema,
  validateManifests,
  vendorLockSchema
} from "./manifests.js";
import { jsonSchemaNodeSchema } from "./generate-schemas.js";

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

async function readGeneratedSchema(filename: string) {
  return jsonSchemaNodeSchema.parse(
    JSON.parse(await readFile(path.join(process.cwd(), "schemas", filename), "utf8"))
  );
}

describe("home manifest schema", () => {
  it("requires an absolute or home-relative upstream path", () => {
    expect(
      homeManifestSchema.parse({
        extends: {
          name: "personal",
          repo: "git@github.com:example/personal.git",
          path: "/workspace/repos/personal"
        }
      }).extends?.path
    ).toBe("/workspace/repos/personal");
    expect(
      homeManifestSchema.parse({
        extends: {
          name: "personal",
          repo: "git@github.com:example/personal.git",
          path: "~/workspace/repos/personal"
        }
      }).extends?.path
    ).toBe("~/workspace/repos/personal");

    for (const value of ["personal", "./personal", "../personal", "~"]) {
      expect(() =>
        homeManifestSchema.parse({
          extends: {
            name: "personal",
            repo: "git@github.com:example/personal.git",
            path: value
          }
        })
      ).toThrow(/absolute or start with ~\//);
    }

    expect(() =>
      homeManifestSchema.parse({
        extends: { name: "personal", repo: "git@github.com:example/personal.git" }
      })
    ).toThrow();
  });

  it("rejects a relative upstream path before clone resolution side effects", async () => {
    const { root, home } = await tmpHome();
    await writeFile(
      path.join(root, "mfz_home.yml"),
      [
        "extends:",
        "  name: personal",
        "  repo: file:///tmp/never-cloned",
        "  path: ./relative-upstream",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(loadManifests(root, home)).rejects.toThrow(/absolute or start with ~\//);
    await expect(
      readFile(path.join(home, ".mindframe-z", "homes", "personal", "mfz_home.yml"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes the explicit upstream path contract", async () => {
    const schema = await readGeneratedSchema("mfz_home.schema.json");
    expect(schema.properties?.extends?.required).toContain("path");
    expect(schema.properties?.extends?.properties?.path?.pattern).toBe("^(?:/|~/)");
  });
});

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
    expect(manifests.machine.thread).toEqual({ stores: [] });
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
    await writeProfile(root, "base", "name: base\n");
    // Link to a profile whose name differs from every real profile dir, so following
    // the link would add a distinct key rather than overwrite an existing one.
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "profile.yml"), "name: linked-only\n", "utf8");
    await symlink(outside, path.join(root, "profiles", "linked"), "dir");

    const manifests = await loadManifests(root, home);
    expect([...manifests.profiles.keys()]).toEqual(["base"]);
  });

  it("surfaces a non-ENOENT failure reading the profiles dir", async () => {
    const { root, home } = await tmpHome();
    // `profiles` as a regular file makes readdir raise ENOTDIR: only a *missing*
    // profiles dir is tolerated, every other failure must reach the caller.
    await writeFile(path.join(root, "profiles"), "not a dir\n", "utf8");
    await expect(loadManifests(root, home)).rejects.toThrow(/ENOTDIR/);
  });

  it("surfaces a malformed profile.yml instead of dropping the profile", async () => {
    const { root, home } = await tmpHome();
    await writeProfile(root, "base", "name: base\nunknown_key: nope\n");
    await expect(loadManifests(root, home)).rejects.toThrow();
  });

  it("preserves arbitrary native mise.toml content", async () => {
    const { root, home } = await tmpHome();
    const dir = await writeProfile(root, "base", "name: base\n");
    const content = '[tools]\njq = "latest"\n\n[hooks]\npostinstall = { task = "check" }\n';
    await writeFile(path.join(dir, "mise.toml"), content, "utf8");

    const manifests = await loadManifests(root, home);
    expect(manifests.miseFiles.get("base")).toBe(content);
  });

  it("rejects a malformed mise.toml with path context", async () => {
    const { root, home } = await tmpHome();
    const dir = await writeProfile(root, "base", "name: base\n");
    const misePath = path.join(dir, "mise.toml");
    await writeFile(misePath, "[tools\njq = ", "utf8");

    await expect(loadManifests(root, home)).rejects.toThrow(misePath);
  });

  it("accepts native mise sections with path context for syntax errors", async () => {
    const { root, home } = await tmpHome();
    const dir = await writeProfile(root, "base", "name: base\n");
    const misePath = path.join(dir, "mise.toml");
    await writeFile(misePath, "[hooks\n", "utf8");
    await expect(loadManifests(root, home)).rejects.toThrow(misePath);
  });

  it("collects dotfiles recursively and excludes profile.yml, mise.toml, and .config/mise", async () => {
    const { root, home } = await tmpHome();
    const dir = await writeProfile(root, "base", "name: base\n");
    await writeFile(path.join(dir, "mise.toml"), '[tools]\njq = "latest"\n', "utf8");
    await writeFile(path.join(dir, ".npmrc"), "min-release-age=3\n", "utf8");
    await mkdir(path.join(dir, "config", "nested"), { recursive: true });
    await writeFile(path.join(dir, "config", "nested", "rc.toml"), "a = 1\n", "utf8");
    await mkdir(path.join(dir, ".config", "systemd", "user"), { recursive: true });
    await writeFile(
      path.join(dir, ".config", "systemd", "user", "example.service"),
      "[Unit]\n",
      "utf8"
    );
    await mkdir(path.join(dir, ".config", "mise"), { recursive: true });
    await writeFile(path.join(dir, ".config", "mise", "ignored.toml"), "ignored = true\n", "utf8");

    const dotfiles = (await loadManifests(root, home)).profiles.get("base")?.dotfiles;
    expect(dotfiles).toEqual({
      ".npmrc": "min-release-age=3\n",
      "config/nested/rc.toml": "a = 1\n",
      ".config/systemd/user/example.service": "[Unit]\n"
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

describe("generated skill schema", () => {
  it("retains transport and ref safety constraints", async () => {
    const schema = await readGeneratedSchema("skills.schema.json");
    const vendored = schema.properties?.skills?.items?.oneOf?.[1];
    expect(vendored?.properties?.repo?.pattern).toContain("@");
    expect(vendored?.properties?.ref?.pattern).toContain("\\s");
  });
});

describe("generated profile MCP schema", () => {
  it("describes concise and grouped direct authoring constraints", async () => {
    const schema = await readGeneratedSchema("profile.schema.json");
    const entryProperties = jsonSchemaNodeSchema.safeParse(
      schema.properties?.mcp?.additionalProperties
    ).data?.properties;
    const branches = entryProperties?.agents?.anyOf ?? [];

    expect(branches[0]!.uniqueItems).toBe(true);
    const grouped = branches[1]!;
    expect(grouped.not).toBeDefined();
    for (const variant of grouped.anyOf ?? []) {
      const disabledItems = variant.properties?.disabled?.items;
      expect(disabledItems?.enum).toEqual(["opencode", "opencode-v2", "codex"]);
    }

    const connections = entryProperties?.executor?.properties?.connections;
    expect(connections?.minProperties).toBe(1);
    expect(jsonSchemaNodeSchema.safeParse(connections?.additionalProperties).data?.minLength).toBe(
      1
    );
    expect(connections?.propertyNames?.pattern).toBe("^[a-z][a-z0-9_]*$");
  });
});

describe("Executor authentication declarations", () => {
  it("accepts no-auth, normal OAuth, assisted OAuth, and header/query API-key methods", async () => {
    expect(
      mcpServerSchema.parse({
        type: "remote",
        url: "https://example.test/mcp",
        executor: {
          authentication: [
            { slug: "none", kind: "none" },
            { slug: "oauth", kind: "oauth2" },
            {
              slug: "key",
              kind: "apikey",
              placements: [
                { carrier: "header", name: "X-API-Key", variable: "api_key" },
                { carrier: "query", name: "tenant", variable: "tenant_id" }
              ]
            }
          ]
        }
      })
    ).toMatchObject({ type: "remote" });

    expect(
      mcpServerSchema.parse({
        type: "remote",
        url: "https://example.test/mcp",
        executor: {
          authentication: [
            {
              slug: "oauth",
              kind: "oauth2",
              discoveryUrl: "https://example.test/oauth",
              registrationScopes: ["read", "write"]
            }
          ]
        }
      })
    ).toMatchObject({ type: "remote" });
  });

  it("rejects cross-kind assisted fields and every credential value", () => {
    for (const method of [
      { slug: "none", kind: "none", discoveryUrl: "https://example.test/oauth" },
      { slug: "key", kind: "apikey", registrationScopes: ["read"], placements: [] },
      {
        slug: "oauth",
        kind: "oauth2",
        discoveryUrl: "https://example.test/oauth"
      },
      {
        slug: "key",
        kind: "apikey",
        placements: [{ carrier: "header", name: "X-API-Key", variable: "key" }],
        value: "secret"
      }
    ]) {
      expect(() =>
        mcpServerSchema.parse({
          type: "remote",
          url: "https://example.test/mcp",
          executor: { authentication: [method] }
        })
      ).toThrow();
    }
    expect(() =>
      mcpServerSchema.parse({
        type: "remote",
        url: "https://example.test/mcp",
        token: "secret"
      })
    ).toThrow();
    expect(() =>
      mcpServerSchema.parse({
        type: "remote",
        url: "https://example.test/mcp",
        executor: { authentication: [{ slug: "public", kind: "none" }] }
      })
    ).toThrow();
  });

  it("rejects duplicate method slugs and generated schema exposes the auth list", async () => {
    expect(() =>
      mcpServerSchema.parse({
        type: "remote",
        url: "https://example.test/mcp",
        executor: {
          authentication: [
            { slug: "none", kind: "none" },
            { slug: "none", kind: "none" }
          ]
        }
      })
    ).toThrow(/must be unique/);

    const schema = await readGeneratedSchema("mcp.schema.json");
    const branches =
      jsonSchemaNodeSchema.safeParse(schema.properties?.servers?.additionalProperties).data
        ?.anyOf ?? [];
    const executor = branches[0]?.properties?.executor;
    expect(executor?.properties).toHaveProperty("authentication");
    const authBranches = executor?.properties?.authentication?.items?.anyOf ?? [];
    const oauth = authBranches.find((branch) => branch.properties?.kind?.const === "oauth2");
    expect(oauth?.allOf).toHaveLength(2);
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

describe("skill manifest schemas", () => {
  it("accepts local and pinned vendored declarations", () => {
    expect(skillSchema.parse({ name: "local", source: "local" })).toMatchObject({
      name: "local",
      source: "local"
    });
    expect(
      skillSchema.parse({
        name: "vendor",
        source: "vendored",
        repo: "https://example.invalid/skills.git",
        ref: "main",
        subtree: "skills/vendor"
      })
    ).toMatchObject({ source: "vendored", subtree: "skills/vendor" });
  });

  it("rejects legacy installer declarations and unsafe transports", () => {
    expect(() =>
      skillSchema.parse({ name: "old", source: "git", repo: "https://example.invalid" })
    ).toThrow();
    expect(() =>
      skillSchema.parse({
        name: "old",
        source: "vendored",
        repo: "ssh://example.invalid/skills",
        ref: "main",
        subtree: "skills/old"
      })
    ).toThrow();
    expect(() =>
      skillSchema.parse({
        name: "old",
        source: "vendored",
        repo: "https://example.invalid/skills",
        ref: "main",
        subtree: "skills/.git"
      })
    ).toThrow();
  });

  it("requires complete strict vendor lock entries", () => {
    expect(() => vendorLockSchema.parse({ skills: { old: { commit: "a".repeat(40) } } })).toThrow();
    expect(() =>
      vendorLockSchema.parse({
        skills: { old: { commit: "a".repeat(40), digest: "b".repeat(64), extra: true } }
      })
    ).toThrow();
  });
});
