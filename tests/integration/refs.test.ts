import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { execa, ExecaError } from "execa";
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
import type {
  OperationLifecycleEvent,
  OperationOutcome,
  OperationStatus
} from "../../src/core/operations.js";
import {
  ReferenceReconciliationError,
  ReferenceInvariantError,
  type RunGit,
  type WriteReferenceState,
  syncReference,
  syncReferences
} from "../../src/ref-store/references.js";
import {
  ReferenceResourceBusyError,
  ReferenceSyncCancelledError,
  referenceLockPaths,
  withReferenceResourceLock
} from "../../src/ref-store/reference-lock.js";
import { createOperationReporter } from "../../src/cli/operation-report.js";
import {
  cli,
  configsPath,
  fixtureReferenceSource,
  makeTempDir,
  parseJson,
  projectRoot,
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
    enabledOpenCodeCommands: [],
    enabledOpenCodeAgents: [],
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await wait(5);
  }

  throw new Error("Timed out waiting for test condition");
}

async function waitForPath(target: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(target);

      return;
    } catch {
      await wait(10);
    }
  }

  throw new Error(`Timed out waiting for ${target}`);
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

function captureOutput() {
  let value = "";

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += String(chunk);
      callback();
    }
  });

  return { stream, text: () => value };
}

function startReferenceLockHolder(
  home: string,
  referencesDir: string,
  readyPath: string,
  releasePath: string
) {
  const lockModule = pathToFileURL(path.join(projectRoot, "src/ref-store/reference-lock.ts")).href;
  const pathsModule = pathToFileURL(path.join(projectRoot, "src/core/paths.ts")).href;

  const script = [
    'import { access, writeFile } from "node:fs/promises";',
    `import { createRuntimePaths } from ${JSON.stringify(pathsModule)};`,
    `import { withReferenceResourceLock } from ${JSON.stringify(lockModule)};`,
    "const [home, referencesDir, readyPath, releasePath] = process.argv.slice(1);",
    "await withReferenceResourceLock(createRuntimePaths({ home }), referencesDir, async () => {",
    '  await writeFile(readyPath, "ready\\n");',
    "  while (true) {",
    "    try { await access(releasePath); break; }",
    "    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }",
    "  }",
    "}, undefined);"
  ].join("\n");

  return execa(
    process.execPath,
    [
      "--import",
      path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      "--input-type=module",
      "--eval",
      script,
      home,
      referencesDir,
      readyPath,
      releasePath
    ],
    { cwd: projectRoot }
  );
}

interface FakeCloneGit {
  runGit: RunGit;
  active: () => number;
  peak: () => number;
  clones: () => string[];
}

function fakeCloneGit(
  options: { delay?: number; failNames?: readonly string[] } = {}
): FakeCloneGit {
  let active = 0;
  let peak = 0;
  const cloned: string[] = [];
  const failures = new Set(options.failNames ?? []);

  const fake = {
    active: () => active,
    peak: () => peak,
    clones: () => [...cloned],
    async runGit(_file, args) {
      active += 1;
      peak = Math.max(peak, active);

      try {
        await wait(options.delay ?? 5);

        if (args[0] === "clone") {
          const destination = args.at(-1)!;
          const name = path.basename(destination);

          if (failures.has(name)) {
            throw Object.assign(new ExecaError<{ stdio: "pipe" }>(), {
              message: `clone failed for ${name}`,
              stderr: `clone failed for ${name}`
            });
          }

          await mkdir(destination, { recursive: true });
          cloned.push(name);
        }

        return { stdout: "revision" };
      } finally {
        active -= 1;
      }
    }
  } satisfies FakeCloneGit;

  return fake;
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
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
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
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
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
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
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

  it("rejects physically aliased checkout destinations before invoking Git", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");
    const realDestination = path.join(referencesDir, "alpha");
    const aliasDestination = path.join(referencesDir, "alias");
    await mkdir(realDestination, { recursive: true });
    await symlink(realDestination, aliasDestination, "dir");

    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: "https://example.test/alpha.git", description: "Alpha" },
      { name: "alias", url: "https://example.test/alias.git", description: "Alias" }
    ]);

    let calls = 0;

    await expect(
      syncReferences(createRuntimePaths({ home }), profile, {
        runGit: async () => {
          calls += 1;

          return { stdout: "revision" };
        }
      })
    ).rejects.toBeInstanceOf(ReferenceInvariantError);
    expect(calls).toBe(0);
  });

  it("reports a retained ownership release persistence failure", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");
    const paths = createRuntimePaths({ home });
    await mkdir(path.dirname(referenceStatePath(paths)), { recursive: true });
    await writeFile(
      referenceStatePath(paths),
      JSON.stringify({ version: 1, profiles: { test: ["alpha"], other: ["alpha"] } }),
      "utf8"
    );

    const profile = makeReferenceProfile(referencesDir, []);

    const error = await syncReferences(paths, profile, {
      writeState: async () => {
        throw new Error("state store unavailable");
      }
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);

    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.outcomes).toContainEqual(
      expect.objectContaining({
        category: "bookkeeping",
        status: "failed",
        detail: expect.stringContaining("Could not release ownership for test/alpha")
      })
    );
  });

  it("shows the checkout effect and ownership failure once in the interactive row", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: "https://example.test/alpha.git", description: "Alpha" }
    ]);

    const output = captureOutput();
    const diagnostics = captureOutput();
    Object.assign(output.stream, { columns: 80, rows: 20 });

    const reporter = createOperationReporter({
      command: "mfz refs sync",
      scope: "test",
      interactive: true,
      output: output.stream,
      diagnostics: diagnostics.stream
    });

    const lifecycle: OperationLifecycleEvent[] = [];
    const failure = new Error("state store unavailable");
    const fake = fakeCloneGit();

    const options = {
      runGit: fake.runGit,
      writeState: async () => {
        throw failure;
      },
      onStart: reporter.start.bind(reporter),
      onComplete: reporter.complete.bind(reporter),
      onLifecycle: (event: OperationLifecycleEvent) => {
        lifecycle.push(event);
        reporter.lifecycle(event);
      }
    };

    const error = await syncReferences(createRuntimePaths({ home }), profile, options).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    reporter.fail(error instanceof Error ? error : new Error(String(error)));
    const text = output.text();

    expect(text).toContain("failed created: alpha; ownership failed:");
    expect(lifecycle.filter((event) => event.type === "complete")).toHaveLength(1);
    expect(lifecycle.at(-1)).toMatchObject({
      type: "complete",
      outcome: { status: "failed", detail: expect.stringContaining("created: alpha") }
    });
    expect(diagnostics.text()).toContain("Could not record ownership for alpha");
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

describe("parallel reference synchronization", () => {
  it("overlaps distinct checkouts, caps Git work, and serializes ownership writes", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const references = Array.from({ length: 6 }, (_, index) => ({
      name: `ref-${index + 1}`,
      url: `https://example.test/${index + 1}.git`,
      description: `Reference ${index + 1}`
    }));

    const profile = makeReferenceProfile(referencesDir, references);
    const fake = fakeCloneGit({ delay: 20 });
    let activeWrites = 0;
    let peakWrites = 0;
    const writtenProfiles: string[][] = [];

    const writeState: WriteReferenceState = async (_file, state) => {
      activeWrites += 1;
      peakWrites = Math.max(peakWrites, activeWrites);

      try {
        await wait(10);
        writtenProfiles.push(state.profiles.test ?? []);
      } finally {
        activeWrites -= 1;
      }
    };

    const lifecycle: string[] = [];

    const outcomes = await syncReferences(createRuntimePaths({ home }), profile, {
      runGit: fake.runGit,
      writeState,
      onLifecycle: (event) => lifecycle.push(`${event.type}:${event.key}`)
    });

    expect(fake.peak()).toBeGreaterThan(1);
    expect(fake.peak()).toBeLessThanOrEqual(4);
    expect(fake.clones()).toHaveLength(6);
    expect(peakWrites).toBe(1);
    expect(writtenProfiles.at(-1)).toEqual(references.map((reference) => reference.name));
    expect(lifecycle.slice(0, 4).every((event) => event.startsWith("start:reference:"))).toBe(true);
    expect(
      outcomes
        .filter((outcome) => outcome.category === "reference" && outcome.status === "created")
        .map((outcome) => outcome.detail)
    ).toEqual(references.map((reference) => reference.name));
  });

  it("collects expected checkout failures and keeps successful ownership", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const references = [
      { name: "alpha", url: "https://example.test/alpha.git", description: "Alpha" },
      { name: "blocked", url: "https://example.test/blocked.git", description: "Blocked" },
      { name: "charlie", url: "https://example.test/charlie.git", description: "Charlie" }
    ];

    const profile = makeReferenceProfile(referencesDir, references);
    const fake = fakeCloneGit({ failNames: ["blocked"] });
    let state: string[] = [];

    const writeState: WriteReferenceState = async (_file, next) => {
      state = next.profiles.test ?? [];
    };

    const error = await syncReferences(createRuntimePaths({ home }), profile, {
      runGit: fake.runGit,
      writeState
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);

    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(error.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "reference", status: "created", detail: "alpha" }),
        expect.objectContaining({
          category: "reference",
          status: "failed",
          detail: "clone failed for blocked"
        }),
        expect.objectContaining({ category: "reference", status: "created", detail: "charlie" })
      ])
    );
    expect(state).toEqual(["alpha", "charlie"]);
    expect(fake.clones()).toEqual(expect.arrayContaining(["alpha", "charlie"]));
  });

  it("keeps admitting references after an expected failure", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const references = Array.from({ length: 6 }, (_, index) => ({
      name: `ref-${index + 1}`,
      url: `https://example.test/${index + 1}.git`,
      description: `Reference ${index + 1}`
    }));

    const profile = makeReferenceProfile(referencesDir, references);
    const fake = fakeCloneGit({ failNames: ["ref-2"] });

    const error = await syncReferences(createRuntimePaths({ home }), profile, {
      runGit: fake.runGit
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    expect(fake.clones()).toHaveLength(5);
    expect(fake.clones()).toEqual(expect.arrayContaining(["ref-5", "ref-6"]));
  });

  it("stops admission and drains active work after a start observer failure", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const references = Array.from({ length: 6 }, (_, index) => ({
      name: `ref-${index + 1}`,
      url: `https://example.test/${index + 1}.git`,
      description: `Reference ${index + 1}`
    }));

    const profile = makeReferenceProfile(referencesDir, references);
    const gates = new Map(references.map((reference) => [reference.name, deferred()]));
    const started: string[] = [];
    const settled: string[] = [];
    let active = 0;
    let peak = 0;
    let starts = 0;
    const observerFailure = new Error("start observer failed");

    const runGit: RunGit = async (_file, args) => {
      if (args[0] !== "clone") return { stdout: "revision" };

      const destination = args.at(-1)!;
      const name = path.basename(destination);
      started.push(name);
      active += 1;
      peak = Math.max(peak, active);

      try {
        await gates.get(name)!.promise;
        await mkdir(destination, { recursive: true });

        return { stdout: "revision" };
      } finally {
        active -= 1;
        settled.push(name);
      }
    };

    const synchronization = syncReferences(createRuntimePaths({ home }), profile, {
      runGit,
      writeState: async () => undefined,
      onStart: () => {
        starts += 1;

        if (starts === 5) throw observerFailure;
      }
    });

    await waitFor(() => started.length === 4);
    expect(active).toBe(4);
    expect(peak).toBe(4);
    gates.get("ref-1")!.resolve();
    await waitFor(() => starts === 5);
    expect(started).toEqual(expect.arrayContaining(["ref-1", "ref-2", "ref-3", "ref-4"]));
    expect(active).toBe(3);

    await expect(
      withReferenceResourceLock(createRuntimePaths({ home }), referencesDir, async () => undefined)
    ).rejects.toBeInstanceOf(ReferenceResourceBusyError);

    for (const name of ["ref-2", "ref-3", "ref-4"]) gates.get(name)!.resolve();

    const error = await synchronization.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    expect(settled).toHaveLength(4);
    expect(started).not.toContain("ref-5");

    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(error.cause).toBe(observerFailure);
    expect(error.outcomes).toContainEqual(
      expect.objectContaining({
        category: "reference",
        status: "failed",
        detail: "lifecycle observer failed: start observer failed"
      })
    );
    expect(
      error.outcomes.some(
        (outcome) => outcome.category === "bookkeeping" && outcome.status === "failed"
      )
    ).toBe(false);

    await expect(
      withReferenceResourceLock(createRuntimePaths({ home }), referencesDir, async () => undefined)
    ).resolves.toBeUndefined();
  });

  it("contains a completion observer failure without retrying or misclassifying it", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const references = [
      { name: "alpha", url: "https://example.test/alpha.git", description: "Alpha" },
      { name: "bravo", url: "https://example.test/bravo.git", description: "Bravo" }
    ];

    const profile = makeReferenceProfile(referencesDir, references);
    const gates = new Map(references.map((reference) => [reference.name, deferred()]));
    const started: string[] = [];
    const settled: string[] = [];
    const completionKeys: string[] = [];
    const observerFailure = new Error("completion observer failed");
    let completionCalls = 0;

    const runGit: RunGit = async (_file, args) => {
      if (args[0] !== "clone") return { stdout: "revision" };

      const destination = args.at(-1)!;
      const name = path.basename(destination);
      started.push(name);

      try {
        await gates.get(name)!.promise;
        await mkdir(destination, { recursive: true });

        return { stdout: "revision" };
      } finally {
        settled.push(name);
      }
    };

    const synchronization = syncReferences(createRuntimePaths({ home }), profile, {
      runGit,
      writeState: async () => undefined,
      onLifecycle: (event) => {
        if (event.type !== "complete") return;

        completionCalls += 1;
        completionKeys.push(event.key);

        if (completionCalls === 1) throw observerFailure;
      }
    });

    await waitFor(() => started.length === 2);
    gates.get("alpha")!.resolve();
    await waitFor(() => completionCalls === 1);

    await expect(
      withReferenceResourceLock(createRuntimePaths({ home }), referencesDir, async () => undefined)
    ).rejects.toBeInstanceOf(ReferenceResourceBusyError);

    gates.get("bravo")!.resolve();
    const error = await synchronization.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    expect(completionCalls).toBe(2);
    expect(completionKeys).toEqual(["reference:0:alpha", "reference:1:bravo"]);
    expect(settled).toHaveLength(2);

    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(error.cause).toBe(observerFailure);
    expect(error.outcomes).toContainEqual(
      expect.objectContaining({
        category: "reference",
        status: "failed",
        detail: "lifecycle observer failed: completion observer failed"
      })
    );
    expect(
      error.outcomes.some(
        (outcome) => outcome.category === "bookkeeping" && outcome.status === "failed"
      )
    ).toBe(false);

    await expect(
      withReferenceResourceLock(createRuntimePaths({ home }), referencesDir, async () => undefined)
    ).resolves.toBeUndefined();
  });

  it("skips pending cleanup when a selected reference fails", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");
    const statePath = referenceStatePath(createRuntimePaths({ home }));
    const staleCheckout = path.join(referencesDir, "stale");

    const profile = makeReferenceProfile(referencesDir, [
      { name: "broken", url: "https://example.test/broken.git", description: "Broken" }
    ]);

    const failure = Object.assign(new ExecaError<{ stdio: "pipe" }>(), {
      message: "remote unavailable",
      stderr: "remote unavailable"
    });

    await mkdir(path.dirname(statePath), { recursive: true });
    await mkdir(referencesDir, { recursive: true });
    await mkdir(staleCheckout, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, profiles: { test: ["stale"] } }),
      "utf8"
    );

    const error = await syncReferences(createRuntimePaths({ home }), profile, {
      runGit: async () => {
        throw failure;
      }
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    await expect(access(staleCheckout)).resolves.toBeUndefined();
    expect(await readOwnership(home)).toEqual({ test: ["stale"] });
  });

  it("keeps lifecycle completion chronological and receipts in manifest order", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const references = Array.from({ length: 6 }, (_, index) => ({
      name: `ref-${index + 1}`,
      url: `https://example.test/${index + 1}.git`,
      description: `Reference ${index + 1}`
    }));

    const profile = makeReferenceProfile(referencesDir, references);
    const gates = new Map(references.map((reference) => [reference.name, deferred()]));
    const started: string[] = [];
    const completed: string[] = [];

    const runGit: RunGit = async (_file, args) => {
      if (args[0] === "clone") {
        const destination = args.at(-1)!;
        const name = path.basename(destination);
        started.push(name);
        await gates.get(name)!.promise;
        await mkdir(destination, { recursive: true });

        return { stdout: "revision" };
      }

      return { stdout: "revision" };
    };

    const synchronization = syncReferences(createRuntimePaths({ home }), profile, {
      runGit,
      onLifecycle: (event) => {
        if (event.type === "complete") completed.push(event.key);
      }
    });

    await waitFor(() => started.length === 4);
    gates.get("ref-3")!.resolve();
    await waitFor(() => completed.length === 1);
    gates.get("ref-1")!.resolve();
    await waitFor(() => completed.length === 2);
    gates.get("ref-2")!.resolve();
    await waitFor(() => completed.length === 3);
    gates.get("ref-4")!.resolve();
    await waitFor(() => started.includes("ref-5"));
    gates.get("ref-5")!.resolve();
    await waitFor(() => started.includes("ref-6"));
    gates.get("ref-6")!.resolve();

    const outcomes = await synchronization;

    expect(completed.slice(0, 4)).toEqual([
      "reference:2:ref-3",
      "reference:0:ref-1",
      "reference:1:ref-2",
      "reference:3:ref-4"
    ]);
    expect(
      outcomes
        .filter((outcome) => outcome.category === "reference" && outcome.status === "created")
        .map((outcome) => outcome.detail)
    ).toEqual(references.map((reference) => reference.name));
  });

  it("terminates the lifecycle row for an unexpected checkout error", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: "https://example.test/alpha.git", description: "Alpha" }
    ]);

    const lifecycle: OperationLifecycleEvent[] = [];

    const runGit: RunGit = async () => {
      throw new Error("unexpected checkout error");
    };

    await expect(
      syncReference(createRuntimePaths({ home }), profile, "alpha", {
        runGit,
        onLifecycle: (event) => lifecycle.push(event)
      })
    ).rejects.toThrow("unexpected checkout error");

    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]).toMatchObject({ type: "start", key: "reference:0:alpha" });
    expect(lifecycle[1]).toMatchObject({
      type: "complete",
      key: "reference:0:alpha",
      outcome: { status: "failed", detail: "unexpected checkout error" }
    });
  });

  it("stops deselection cleanup when cancellation is requested", async () => {
    const home = await makeTempDir();
    const repository = await createLocalRemote(home, "alpha");
    const referencesDir = path.join(home, "references");

    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: repository.remote, description: "Alpha" }
    ]);

    const paths = createRuntimePaths({ home });
    const checkout = path.join(referencesDir, "alpha");

    await syncReferences(paths, profile);
    profile.enabledReferences = [];

    const controller = new AbortController();
    controller.abort();
    await expect(
      syncReferences(paths, profile, { signal: controller.signal })
    ).rejects.toBeInstanceOf(ReferenceSyncCancelledError);

    await expect(access(checkout)).resolves.toBeUndefined();
    expect(await readOwnership(home)).toEqual({ test: ["alpha"] });
  });

  it("joins active work after caller cancellation through the public API", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const profile = makeReferenceProfile(referencesDir, [
      { name: "alpha", url: "https://example.test/alpha.git", description: "Alpha" }
    ]);

    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    let writes = 0;

    const runGit: RunGit = async (_file, args) => {
      if (args[0] === "clone") {
        const destination = args.at(-1)!;
        started.resolve();
        await release.promise;
        await mkdir(destination, { recursive: true });
      }

      return { stdout: "revision" };
    };

    const synchronization = syncReferences(createRuntimePaths({ home }), profile, {
      runGit,
      signal: controller.signal,
      writeState: async () => {
        writes += 1;
      }
    });

    await started.promise;
    controller.abort();
    release.resolve();

    await expect(synchronization).rejects.toBeInstanceOf(ReferenceSyncCancelledError);
    expect(writes).toBe(0);

    for (const lockPath of await referenceLockPaths(createRuntimePaths({ home }), referencesDir)) {
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("stops admitting work after a state failure and joins admitted checkouts", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const references = Array.from({ length: 6 }, (_, index) => ({
      name: `ref-${index + 1}`,
      url: `https://example.test/${index + 1}.git`,
      description: `Reference ${index + 1}`
    }));

    const profile = makeReferenceProfile(referencesDir, references);
    const fake = fakeCloneGit({ delay: 15 });
    let writes = 0;

    const writeState: WriteReferenceState = async () => {
      writes += 1;
      throw new Error("state store unavailable");
    };

    const error = await syncReferences(createRuntimePaths({ home }), profile, {
      runGit: fake.runGit,
      writeState
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReferenceReconciliationError);
    expect(writes).toBe(1);
    expect(fake.clones()).toHaveLength(4);
    expect(fake.active()).toBe(0);

    if (!(error instanceof ReferenceReconciliationError)) throw error;
    expect(error.outcomes.filter((outcome) => outcome.category === "reference")).toHaveLength(8);
    expect(error.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "bookkeeping", status: "failed" }),
        expect.objectContaining({ category: "reference", status: "failed" })
      ])
    );
  });

  it("rejects duplicate checkout destinations before invoking Git", async () => {
    const home = await makeTempDir();
    const referencesDir = path.join(home, "references");

    const references = [
      { name: "alpha", url: "https://example.test/alpha.git", description: "Alpha" },
      { name: "alpha/../alpha", url: "https://example.test/other.git", description: "Other" }
    ];

    const profile = makeReferenceProfile(
      referencesDir,
      references,
      references.map((ref) => ref.name)
    );

    let calls = 0;

    const runGit: RunGit = async () => {
      calls += 1;

      return { stdout: "revision" };
    };

    await expect(
      syncReferences(createRuntimePaths({ home }), profile, { runGit })
    ).rejects.toBeInstanceOf(ReferenceInvariantError);
    expect(calls).toBe(0);
  });

  it("excludes the shared checkout root across profiles", async () => {
    const root = await makeTempDir();
    const homeA = await makeTempDir();
    const homeB = await makeTempDir();
    const referencesDir = path.join(root, "references");
    const pathsA = createRuntimePaths({ home: homeA });
    const pathsB = createRuntimePaths({ home: homeB });
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const enteredFirst = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const first = withReferenceResourceLock(pathsA, referencesDir, async () => {
      entered?.();

      return held;
    });

    await enteredFirst;
    const second = withReferenceResourceLock(pathsB, referencesDir, async () => undefined);

    await expect(second).rejects.toBeInstanceOf(ReferenceResourceBusyError);
    release?.();
    await first;
    await expect(referenceLockPaths(pathsA, referencesDir)).resolves.toContain(
      `${path.resolve(referencesDir)}.mfz-references.lock`
    );
    await expect(referenceLockPaths(pathsB, referencesDir)).resolves.toContain(
      `${path.resolve(referencesDir)}.mfz-references.lock`
    );
  });

  it.each(["bulk", "named"] as const)(
    "excludes a real reference root from a symlink alias during %s synchronization",
    async (mode) => {
      const fixture = await setupIntegrationFixture();
      const aliasParent = await makeTempDir();
      const aliasHome = path.join(aliasParent, "home-alias");
      const referencesDir = path.join(fixture.home, "shared-references");
      const aliasReferencesDir = path.join(aliasHome, "shared-references");
      const readyPath = path.join(aliasParent, "holder-ready");
      const releasePath = path.join(aliasParent, "holder-release");

      await symlink(fixture.home, aliasHome, "dir");

      const holder = startReferenceLockHolder(fixture.home, referencesDir, readyPath, releasePath);

      try {
        await waitForPath(readyPath);

        const args = mode === "named" ? ["refs", "sync", "local-ref"] : ["refs", "sync"];

        const contender = cli("mfz", fixture.root, aliasHome, args, {
          MFZ_REFERENCES_DIR: aliasReferencesDir
        });

        await expect(contender).rejects.toMatchObject({
          stderr: expect.stringContaining("Reference synchronization is already active")
        });
      } finally {
        await writeFile(releasePath, "release\n", "utf8");
        await holder.catch(() => undefined);
      }

      await expect(holder).resolves.toMatchObject({ exitCode: 0 });
      await expect(
        cli(
          "mfz",
          fixture.root,
          aliasHome,
          mode === "named" ? ["refs", "sync", "local-ref"] : ["refs", "sync"],
          {
            MFZ_REFERENCES_DIR: aliasReferencesDir
          }
        )
      ).resolves.toMatchObject({ exitCode: 0 });

      await expect(
        referenceLockPaths(createRuntimePaths({ home: fixture.home }), referencesDir)
      ).resolves.toEqual(
        await referenceLockPaths(createRuntimePaths({ home: aliasHome }), aliasReferencesDir)
      );
    }
  );
});
