import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  machineSchema,
  profileSchema,
  type LoadedManifests,
  type ReferenceEntry
} from "../../src/core/manifests.js";
import { createRuntimePaths, referenceStatePath } from "../../src/core/paths.js";
import type { ResolvedProfile } from "../../src/core/profile.js";
import type { OperationOutcome, OperationStatus } from "../../src/core/operations.js";
import {
  ReferenceReconciliationError,
  syncReference,
  syncReferences
} from "../../src/ref-store/references.js";
import {
  cli,
  configsPath,
  fixtureReferenceSource,
  makeTempDir,
  parseJson,
  setupIntegrationFixture
} from "./support.js";

const ClaudePermissions = z.object({
  permissions: z.object({ allow: z.array(z.string()), deny: z.array(z.string()) })
});

interface LocalRemote {
  remote: string;
  source: string;
  revision: () => Promise<string>;
  advance: (content?: string) => Promise<string>;
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", ["-C", directory, ...args]);
  return result.stdout.trim();
}

async function createLocalRemote(parent: string, name: string): Promise<LocalRemote> {
  const source = path.join(parent, `${name}-source`);
  const remote = path.join(parent, `${name}.git`);
  await mkdir(source, { recursive: true });
  await execa("git", ["init", "--bare", remote]);
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.email", "test@example.com"]);
  await git(source, ["config", "user.name", "Test User"]);
  await writeFile(path.join(source, "README.md"), `${name} one\n`, "utf8");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
  await git(source, ["remote", "add", "origin", remote]);
  await git(source, ["push", "-u", "origin", "main"]);
  await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  let sequence = 1;
  return {
    remote,
    source,
    revision: () => git(source, ["rev-parse", "HEAD"]),
    async advance(content) {
      sequence += 1;
      await writeFile(path.join(source, "README.md"), content ?? `${name} ${sequence}\n`, "utf8");
      await git(source, ["add", "."]);
      await git(source, ["commit", "-m", `advance ${sequence}`]);
      await git(source, ["push", "origin", "main"]);
      return git(source, ["rev-parse", "HEAD"]);
    }
  };
}

function makeReferenceProfile(
  referencesDir: string,
  references: ReferenceEntry[],
  enabledNames: readonly string[] = references.map((reference) => reference.name)
): ResolvedProfile {
  const enabled = new Set(enabledNames);
  const manifests = {
    homeManifest: {},
    root: referencesDir,
    aliasPath: [],
    references,
    skills: [],
    mcpServers: {},
    profiles: new Map(),
    miseFiles: new Map(),
    machine: machineSchema.parse({})
  } satisfies LoadedManifests;
  return {
    name: "test",
    agents: [],
    profile: profileSchema.parse({ name: "test", references: enabledNames }),
    sources: {
      references: new Map(),
      skills: new Map(),
      mcp: new Map(),
      instructions: new Map(),
      plugins: new Map(),
      commands: new Map(),
      agents: new Map()
    },
    instructionFiles: [],
    instructionReferences: [],
    referencesDir,
    enabledReferences: references.filter((reference) => enabled.has(reference.name)),
    enabledSkills: [],
    enabledOpenCodeV2Commands: [],
    enabledOpenCodeV2Agents: [],
    mcpServers: [],
    extraFolders: [],
    miseLayers: [],
    manifests
  };
}

function findOutcome(
  outcomes: readonly OperationOutcome[],
  status: OperationStatus
): OperationOutcome {
  const outcome = outcomes.find(
    (candidate) => candidate.category === "reference" && candidate.status === status
  );
  if (!outcome) throw new Error(`Missing reference outcome with status ${status}`);
  return outcome;
}

async function readOwnership(home: string): Promise<Record<string, string[]>> {
  const source = await readFile(referenceStatePath(createRuntimePaths({ home })), "utf8");
  return z
    .object({ version: z.literal(1), profiles: z.record(z.string(), z.array(z.string())) })
    .parse(JSON.parse(source)).profiles;
}

async function deselectFixtureReference(root: string): Promise<void> {
  const profilePath = path.join(root, "profiles", "personal", "profile.yml");
  const profile = await readFile(profilePath, "utf8");
  await writeFile(
    profilePath,
    profile.replace("references:\n  - local-ref\n", "references: []\n"),
    "utf8"
  );
}

describe("refs integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  it("auto-adds references_dir permissions without extra_folders", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);

    const refsAbs = path.join(home, ".mindframe-z", "references");

    const opencode = await readFile(
      configsPath(home, "personal", "opencode-v2", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain(`${refsAbs}/*`);

    const perms = parseJson(
      ClaudePermissions,
      await readFile(configsPath(home, "personal", "claude", "settings.json"), "utf8")
    ).permissions;
    expect(perms.allow).toContain(`Read(/${refsAbs}/**)`);
    expect(perms.deny).toContain(`Edit(/${refsAbs}/**)`);
  });

  it("does not write extra_folders.md or reference it when extra_folders is empty", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);

    const indexPath = path.join(home, ".mindframe-z", "extra_folders.md");
    await expect(readFile(indexPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const opencode = await readFile(
      configsPath(home, "personal", "opencode-v2", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).not.toContain("extra_folders.md");

    const claudeMd = await readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).not.toContain("extra_folders.md");
  });

  it("writes an extra folders index from machine config", async () => {
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/.mindframe-z/references",
        "extra_folders:",
        "  - path: ~/code/work",
        "    description: Work code",
        "  - path: ~/code/restricted",
        "    read: deny",
        "    edit: deny",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    const index = await readFile(path.join(home, ".mindframe-z", "extra_folders.md"), "utf8");
    expect(index).toContain("# Extra Folders");
    expect(index).toContain(
      "Use this as the capability map for cross-repository work or when a named repository's role is unclear."
    );
    expect(index).toContain(
      `- \`${path.join(home, "code", "work")}\` - Work code (read: allow, edit: allow)`
    );
    expect(index).toContain(
      `- \`${path.join(home, "code", "restricted")}\` (read: deny, edit: deny)`
    );

    const opencode = await readFile(
      configsPath(home, "personal", "opencode-v2", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("extra_folders.md");

    const claudeMd = await readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("extra_folders.md");
  });

  it("writes a reference index automatically after named synchronization", async () => {
    await cli("mfz", root, home, ["refs", "sync", "local-ref"]);
    const index = await readFile(path.join(home, ".mindframe-z", "references.md"), "utf8");
    expect(index).toContain("local-ref");
    expect(index).toContain("Local test reference");
    expect(index).toContain("read-only");
    expect(index).toContain("do not edit");
  });

  it("builds named-sync indexes from the full resolved profile", async () => {
    const referencesPath = path.join(root, "catalog", "references.yml");
    await writeFile(
      referencesPath,
      `${await readFile(referencesPath, "utf8")}  - name: disabled-ref\n    url: ${fixtureReferenceSource(root)}\n    description: Named-only reference.\n`,
      "utf8"
    );

    await cli("mfz", root, home, ["refs", "sync", "disabled-ref"]);

    const index = await readFile(path.join(home, ".mindframe-z", "references.md"), "utf8");
    expect(index).toContain("local-ref");
    expect(index).not.toContain("disabled-ref");
    await expect(
      access(path.join(home, ".mindframe-z", "references", "disabled-ref"))
    ).resolves.toBeUndefined();
  });

  it("updates local indexes after bulk sync without activating embedded agent content", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);
    const embeddedPath = configsPath(home, "personal", "codex", "AGENTS.md");
    const before = await readFile(embeddedPath, "utf8");
    const referencesPath = path.join(root, "catalog", "references.yml");
    await writeFile(
      referencesPath,
      (await readFile(referencesPath, "utf8")).replace(
        "Local test reference.",
        "Locally refreshed reference description."
      ),
      "utf8"
    );

    await cli("mfz", root, home, ["refs", "sync"]);

    await expect(
      readFile(path.join(home, ".mindframe-z", "references.md"), "utf8")
    ).resolves.toContain("Locally refreshed reference description.");
    expect(await readFile(embeddedPath, "utf8")).toBe(before);

    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);
    await expect(readFile(embeddedPath, "utf8")).resolves.toContain(
      "Locally refreshed reference description."
    );
  });

  it("does not register the removed refs index command", async () => {
    const result = await cli("mfz", root, home, ["refs", "--help"]);

    expect(result.stdout).not.toContain("index");
    await expect(cli("mfz", root, home, ["refs", "index"])).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown command 'index'")
    });
  });

  it("uses MFZ_REFERENCES_DIR as the reference clone directory", async () => {
    const referencesDir = path.join(home, "custom-reference-cache");
    const result = await cli("mfz", root, home, ["refs", "list"], {
      MFZ_REFERENCES_DIR: referencesDir
    });

    expect(result.stdout).toContain(`${referencesDir}/local-ref`);
    expect(result.stdout).not.toContain(`${home}/.mindframe-z/references/local-ref`);
  });

  it("prints change-first, no-change, and verbose plain sync receipts", async () => {
    const created = await cli("mfz", root, home, ["refs", "sync", "local-ref"]);
    expect(created.stdout).toContain("Changes\ncreated\treference");
    expect(created.stdout).toContain("Result\tmfz refs sync complete");

    const unchanged = await cli("mfz", root, home, ["refs", "sync", "local-ref"]);
    expect(unchanged.stdout).not.toContain("Changes\n");
    expect(unchanged.stdout).toContain("Result\tmfz refs sync complete — no changes");

    const verbose = await cli("mfz", root, home, ["refs", "sync", "local-ref", "--verbose"]);
    expect(verbose.stdout).toContain("working\treference\treconcile");
    expect(verbose.stdout).toContain("unchanged\treference");
    expect(verbose.stdout).toContain("unchanged\tbookkeeping");
    expect(verbose.stdout).toContain("unchanged\tindex");
    expect(verbose.stdout).not.toContain(String.fromCharCode(27));
    expect(verbose.stdout).not.toContain(String.fromCharCode(155));
  });

  it("reports a blocked sync on stdout and diagnostics on stderr", async () => {
    await cli("mfz", root, home, ["refs", "sync", "local-ref"]);
    const checkout = path.join(home, ".mindframe-z", "references", "local-ref");
    await writeFile(path.join(checkout, "untracked.txt"), "local work\n", "utf8");

    await expect(cli("mfz", root, home, ["refs", "sync", "local-ref"])).rejects.toMatchObject({
      stdout: expect.stringContaining("Attention\nblocked\treference"),
      stderr: expect.stringContaining("checkout has local edits or untracked files")
    });
    await expect(cli("mfz", root, home, ["refs", "sync", "local-ref"])).rejects.toMatchObject({
      stdout: expect.stringContaining("earlier changes were not rolled back")
    });
  });

  it("blocks destructive cleanup for commits on another local branch", async () => {
    await cli("mfz", root, home, ["refs", "sync"]);
    const checkout = path.join(home, ".mindframe-z", "references", "local-ref");
    await git(checkout, ["config", "user.email", "test@example.com"]);
    await git(checkout, ["config", "user.name", "Test User"]);
    await git(checkout, ["switch", "-c", "local-work"]);
    await writeFile(path.join(checkout, "LOCAL.md"), "unpublished branch work\n", "utf8");
    await git(checkout, ["add", "LOCAL.md"]);
    await git(checkout, ["commit", "-m", "local branch work"]);
    await git(checkout, ["switch", "main"]);
    await deselectFixtureReference(root);

    await expect(cli("mfz", root, home, ["refs", "sync"])).rejects.toMatchObject({
      stdout: expect.stringContaining("Attention\nblocked\treference"),
      stderr: expect.stringContaining("checkout has unpublished local branch commits")
    });
    await expect(access(checkout)).resolves.toBeUndefined();
    expect(await readOwnership(home)).toEqual({ personal: ["local-ref"] });
  });

  it("blocks destructive cleanup for untracked files hidden by local Git config", async () => {
    await cli("mfz", root, home, ["refs", "sync"]);
    const checkout = path.join(home, ".mindframe-z", "references", "local-ref");
    await git(checkout, ["config", "status.showUntrackedFiles", "no"]);
    await writeFile(path.join(checkout, "LOCAL.md"), "hidden untracked work\n", "utf8");
    await deselectFixtureReference(root);

    await expect(cli("mfz", root, home, ["refs", "sync"])).rejects.toMatchObject({
      stdout: expect.stringContaining("Attention\nblocked\treference"),
      stderr: expect.stringContaining("checkout has local edits or untracked files")
    });
    await expect(readFile(path.join(checkout, "LOCAL.md"), "utf8")).resolves.toBe(
      "hidden untracked work\n"
    );
    expect(await readOwnership(home)).toEqual({ personal: ["local-ref"] });
  });
});

describe("reference checkout lifecycle", () => {
  it("reports clone, upstream advancement, and unchanged refresh with exact revisions", async () => {
    const home = await makeTempDir();
    const repository = await createLocalRemote(home, "alpha");
    const referencesDir = path.join(home, "references");
    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: repository.remote, description: "Alpha" }
    ]);
    const paths = createRuntimePaths({ home });

    const cloned = findOutcome(await syncReference(paths, profile, "alpha"), "created");
    const initialRevision = await repository.revision();
    expect(cloned.before).toBeUndefined();
    expect(cloned.after).toBe(initialRevision);

    const advancedRevision = await repository.advance();
    const updated = findOutcome(await syncReference(paths, profile, "alpha"), "updated");
    expect(updated.before).toBe(initialRevision);
    expect(updated.after).toBe(advancedRevision);

    const unchanged = findOutcome(await syncReference(paths, profile, "alpha"), "unchanged");
    expect(unchanged.before).toBe(advancedRevision);
    expect(unchanged.after).toBe(advancedRevision);
  });

  it("removes deselected managed checkouts and leaves unmanaged directories untouched", async () => {
    const home = await makeTempDir();
    const repository = await createLocalRemote(home, "alpha");
    const referencesDir = path.join(home, "references");
    const reference = { name: "alpha", url: repository.remote, description: "Alpha" };
    const profile = makeReferenceProfile(referencesDir, [reference]);
    const paths = createRuntimePaths({ home });
    await syncReferences(paths, profile);
    await mkdir(path.join(referencesDir, "manual"));

    profile.enabledReferences = [];
    const outcomes = await syncReferences(paths, profile);

    expect(findOutcome(outcomes, "removed").target).toBe(path.join(referencesDir, "alpha"));
    await expect(access(path.join(referencesDir, "alpha"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(path.join(referencesDir, "manual"))).resolves.toBeUndefined();
    expect(await readOwnership(home)).toEqual({});
  });

  it("removes a clean checkout when every local branch is published", async () => {
    const home = await makeTempDir();
    const repository = await createLocalRemote(home, "alpha");
    const referencesDir = path.join(home, "references");
    const checkout = path.join(referencesDir, "alpha");
    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: repository.remote, description: "Alpha" }
    ]);
    const paths = createRuntimePaths({ home });
    await syncReferences(paths, profile);
    await git(checkout, ["config", "user.email", "test@example.com"]);
    await git(checkout, ["config", "user.name", "Test User"]);
    await git(checkout, ["switch", "-c", "published-work"]);
    await writeFile(path.join(checkout, "PUBLISHED.md"), "published branch work\n", "utf8");
    await git(checkout, ["add", "PUBLISHED.md"]);
    await git(checkout, ["commit", "-m", "published branch work"]);
    await git(checkout, ["push", "-u", "origin", "published-work"]);
    await git(checkout, ["switch", "main"]);
    profile.enabledReferences = [];

    const outcomes = await syncReferences(paths, profile);

    expect(findOutcome(outcomes, "removed").target).toBe(checkout);
    await expect(access(checkout)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readOwnership(home)).toEqual({});
  });

  it("keeps named synchronization isolated and cleans its acquisition on a later bulk run", async () => {
    const home = await makeTempDir();
    const alpha = await createLocalRemote(home, "alpha");
    const beta = await createLocalRemote(home, "beta");
    const referencesDir = path.join(home, "references");
    const references = [
      { name: "alpha", url: alpha.remote, description: "Alpha" },
      { name: "beta", url: beta.remote, description: "Beta" }
    ];
    const profile = makeReferenceProfile(referencesDir, references, ["alpha"]);
    const paths = createRuntimePaths({ home });
    await syncReferences(paths, profile);
    const alphaBefore = await git(path.join(referencesDir, "alpha"), ["rev-parse", "HEAD"]);
    await alpha.advance();

    await syncReference(paths, profile, "beta");

    expect(await git(path.join(referencesDir, "alpha"), ["rev-parse", "HEAD"])).toBe(alphaBefore);
    expect(await readOwnership(home)).toEqual({ test: ["alpha", "beta"] });

    const outcomes = await syncReferences(paths, profile);
    expect(findOutcome(outcomes, "removed").target).toBe(path.join(referencesDir, "beta"));
    await expect(access(path.join(referencesDir, "beta"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readOwnership(home)).toEqual({ test: ["alpha"] });
  });

  it("blocks cleanup when the managed checkout origin no longer matches", async () => {
    const home = await makeTempDir();
    const repository = await createLocalRemote(home, "alpha");
    const other = await createLocalRemote(home, "other");
    const referencesDir = path.join(home, "references");
    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: repository.remote, description: "Alpha" }
    ]);
    const paths = createRuntimePaths({ home });
    await syncReferences(paths, profile);
    await git(path.join(referencesDir, "alpha"), ["remote", "set-url", "origin", other.remote]);
    profile.enabledReferences = [];

    const error = await syncReferences(paths, profile).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(findOutcome(error.outcomes, "blocked").detail).toContain("Origin mismatch");
    await expect(access(path.join(referencesDir, "alpha"))).resolves.toBeUndefined();
    expect(await readOwnership(home)).toEqual({ test: ["alpha"] });
  });

  it.each(["local edits", "untracked files", "unpushed commits", "divergent commits"])(
    "preserves cleanup targets with %s",
    async (condition) => {
      const home = await makeTempDir();
      const repository = await createLocalRemote(home, "alpha");
      const referencesDir = path.join(home, "references");
      const checkout = path.join(referencesDir, "alpha");
      const profile = makeReferenceProfile(referencesDir, [
        { name: "alpha", url: repository.remote, description: "Alpha" }
      ]);
      const paths = createRuntimePaths({ home });
      await syncReferences(paths, profile);

      if (condition === "local edits") {
        await writeFile(path.join(checkout, "README.md"), "edited locally\n", "utf8");
      } else if (condition === "untracked files") {
        await writeFile(path.join(checkout, "LOCAL.md"), "untracked\n", "utf8");
      } else {
        await git(checkout, ["config", "user.email", "test@example.com"]);
        await git(checkout, ["config", "user.name", "Test User"]);
        await writeFile(path.join(checkout, "LOCAL.md"), "local commit\n", "utf8");
        await git(checkout, ["add", "."]);
        await git(checkout, ["commit", "-m", "local"]);
        if (condition === "divergent commits") await repository.advance("remote divergence\n");
      }
      profile.enabledReferences = [];

      const error = await syncReferences(paths, profile).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ReferenceReconciliationError);
      if (!(error instanceof ReferenceReconciliationError)) throw error;
      expect(findOutcome(error.outcomes, "blocked").detail).toContain(condition);
      await expect(access(checkout)).resolves.toBeUndefined();
      expect(await readOwnership(home)).toEqual({ test: ["alpha"] });
    }
  );

  it("preserves cleanup targets with stashed work", async () => {
    const home = await makeTempDir();
    const repository = await createLocalRemote(home, "alpha");
    const referencesDir = path.join(home, "references");
    const checkout = path.join(referencesDir, "alpha");
    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: repository.remote, description: "Alpha" }
    ]);
    const paths = createRuntimePaths({ home });
    await syncReferences(paths, profile);
    await writeFile(path.join(checkout, "README.md"), "stashed local work\n", "utf8");
    await git(checkout, ["stash", "push", "-m", "preserve me"]);
    profile.enabledReferences = [];

    const error = await syncReferences(paths, profile).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(findOutcome(error.outcomes, "blocked").detail).toContain("stashed work");
    await expect(access(checkout)).resolves.toBeUndefined();
    expect(await git(checkout, ["stash", "list"])).toContain("preserve me");
    expect(await readOwnership(home)).toEqual({ test: ["alpha"] });
  });

  it("blocks an unmanaged same-name directory without recording ownership", async () => {
    const home = await makeTempDir();
    const repository = await createLocalRemote(home, "alpha");
    const referencesDir = path.join(home, "references");
    await mkdir(path.join(referencesDir, "alpha"), { recursive: true });
    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: repository.remote, description: "Alpha" }
    ]);
    const paths = createRuntimePaths({ home });

    const error = await syncReference(paths, profile, "alpha").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(findOutcome(error.outcomes, "blocked").detail).toContain("not an owned Git checkout");
    await expect(readFile(referenceStatePath(paths), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("checkpoints earlier acquisitions when a later remote fails", async () => {
    const home = await makeTempDir();
    const repository = await createLocalRemote(home, "alpha");
    const referencesDir = path.join(home, "references");
    const missingRemote = path.join(home, "missing.git");
    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: repository.remote, description: "Alpha" },
      { name: "broken", url: missingRemote, description: "Broken" }
    ]);
    const completed: OperationOutcome[] = [];

    const error = await syncReferences(createRuntimePaths({ home }), profile, {
      onComplete: (outcome) => completed.push(outcome)
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(findOutcome(error.outcomes, "created").target).toBe(path.join(referencesDir, "alpha"));
    expect(findOutcome(error.outcomes, "failed").target).toBe(path.join(referencesDir, "broken"));
    expect(completed).toEqual(error.outcomes);
    await expect(access(path.join(referencesDir, "alpha"))).resolves.toBeUndefined();
    expect(await readOwnership(home)).toEqual({ test: ["alpha"] });
  });
});
