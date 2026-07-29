import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import type { ResolvedThreadStore } from "./storage.js";
import { commitThreadChanges, ThreadPublicationError } from "./publication.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

interface PublicationFixture {
  bareDir: string;
  canonicalDir: string;
  destination: ResolvedThreadStore;
  gh: string;
  headBefore: string;
  statusBefore: string;
  threadDir: string;
}

async function publicationFixture(): Promise<PublicationFixture> {
  const home = await makeTempDir();
  const bareDir = path.join(home, "remote.git");
  const seedDir = path.join(home, "seed");
  const canonicalDir = path.join(home, "personal-knowledge");
  await execa("git", ["init", "--bare", "--initial-branch=main", bareDir]);
  await execa("git", ["clone", bareDir, seedDir]);
  await execa("git", ["config", "user.email", "test@test"], { cwd: seedDir });
  await execa("git", ["config", "user.name", "Test"], { cwd: seedDir });
  await mkdir(path.join(seedDir, "threads", "thread-pr"), { recursive: true });
  await writeFile(
    path.join(seedDir, "threads", "thread-pr", "manifest.json"),
    JSON.stringify({
      slug: "thread-pr",
      charter: "Old charter.",
      store: "personal-knowledge",
      created_at: "2026-07-01T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    }) + "\n"
  );
  await writeFile(path.join(seedDir, "unrelated.txt"), "untouched\n");
  await execa("git", ["add", "."], { cwd: seedDir });
  await execa("git", ["commit", "-m", "seed"], { cwd: seedDir });
  await execa("git", ["push", "origin", "main"], { cwd: seedDir });

  await execa("git", ["clone", bareDir, canonicalDir]);
  await execa("git", ["config", "user.email", "test@test"], { cwd: canonicalDir });
  await execa("git", ["config", "user.name", "Test"], { cwd: canonicalDir });
  await execa("git", ["switch", "-c", "local-work"], { cwd: canonicalDir });
  await writeFile(path.join(canonicalDir, "unrelated.txt"), "staged local change\n");
  await execa("git", ["add", "unrelated.txt"], { cwd: canonicalDir });
  await writeFile(path.join(canonicalDir, "untracked.txt"), "untracked local change\n");

  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin);
  const gh = path.join(fakeBin, "gh");
  await writeFile(gh, "#!/bin/sh\nexit 99\n");
  await chmod(gh, 0o755);
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

  const threadDir = path.join(home, "thread-source");
  await mkdir(threadDir);
  await writeFile(
    path.join(threadDir, "manifest.json"),
    JSON.stringify({
      slug: "thread-pr",
      title: "Publication thread",
      charter: "New charter.",
      store: "personal-knowledge",
      created_at: "2026-07-01T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    }) + "\n"
  );
  const { stdout: statusBefore } = await execa("git", ["status", "--porcelain"], {
    cwd: canonicalDir
  });
  const { stdout: headBefore } = await execa("git", ["rev-parse", "HEAD"], {
    cwd: canonicalDir
  });

  return {
    bareDir,
    canonicalDir,
    destination: {
      name: "personal-knowledge",
      root: canonicalDir,
      path: path.join(canonicalDir, "threads"),
      default: true,
      publication: { mode: "pull-request", base: "main" }
    },
    gh,
    headBefore: headBefore.trim(),
    statusBefore,
    threadDir
  };
}

async function expectCanonicalUnchanged(fixture: PublicationFixture): Promise<void> {
  const { stdout: branch } = await execa("git", ["branch", "--show-current"], {
    cwd: fixture.canonicalDir
  });
  const { stdout: head } = await execa("git", ["rev-parse", "HEAD"], {
    cwd: fixture.canonicalDir
  });
  const { stdout: status } = await execa("git", ["status", "--porcelain"], {
    cwd: fixture.canonicalDir
  });
  const { stdout: worktrees } = await execa("git", ["worktree", "list", "--porcelain"], {
    cwd: fixture.canonicalDir
  });
  expect(branch.trim()).toBe("local-work");
  expect(head.trim()).toBe(fixture.headBefore);
  expect(status).toBe(fixture.statusBefore);
  expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
  expect(
    JSON.parse(
      await readFile(
        path.join(fixture.canonicalDir, "threads", "thread-pr", "manifest.json"),
        "utf8"
      )
    ).charter
  ).toBe("Old charter.");
}

describe("thread publication", () => {
  it("opens a pull request without changing the canonical checkout", async () => {
    const fixture = await publicationFixture();
    await writeFile(fixture.gh, "#!/bin/sh\nprintf '%s\\n' 'https://example.test/pull/1'\n");
    await chmod(fixture.gh, 0o755);

    const result = await commitThreadChanges(
      fixture.destination,
      "thread-pr",
      fixture.threadDir,
      "chore(thread): refresh thread-pr",
      true
    );

    expect(result).toMatchObject({ kind: "pull-request", url: "https://example.test/pull/1" });
    if (result.kind !== "pull-request") throw new Error("expected pull request");
    await expectCanonicalUnchanged(fixture);
    const reviewDir = path.join(path.dirname(fixture.bareDir), "review");
    await execa("git", ["clone", "--branch", result.branch, fixture.bareDir, reviewDir]);
    expect(
      JSON.parse(
        await readFile(path.join(reviewDir, "threads", "thread-pr", "manifest.json"), "utf8")
      ).charter
    ).toBe("New charter.");
    expect(await readFile(path.join(reviewDir, "threads", "index.md"), "utf8")).toContain(
      "[`thread-pr`](thread-pr/digest.md)"
    );
    expect(await readFile(path.join(reviewDir, "unrelated.txt"), "utf8")).toBe("untouched\n");
  });

  it("retains a local recovery branch when push is disabled", async () => {
    const fixture = await publicationFixture();
    await writeFile(fixture.gh, "#!/bin/sh\nexit 99\n");
    await chmod(fixture.gh, 0o755);

    const result = await commitThreadChanges(
      fixture.destination,
      "thread-pr",
      fixture.threadDir,
      "chore(thread): refresh thread-pr locally",
      false
    );

    expect(result.kind).toBe("local-branch");
    if (result.kind !== "local-branch") throw new Error("expected local branch");
    const { stdout } = await execa("git", ["rev-parse", result.branch], {
      cwd: fixture.canonicalDir
    });
    expect(stdout.trim()).toBe(result.commit);
    await expectCanonicalUnchanged(fixture);
  });

  it("retains local and remote recovery branches when PR creation fails", async () => {
    const fixture = await publicationFixture();
    await writeFile(fixture.gh, "#!/bin/sh\nexit 1\n");
    await chmod(fixture.gh, 0o755);

    let publicationError: unknown;
    try {
      await commitThreadChanges(
        fixture.destination,
        "thread-pr",
        fixture.threadDir,
        "chore(thread): fail thread-pr publication",
        true
      );
    } catch (error) {
      publicationError = error;
    }

    expect(publicationError).toBeInstanceOf(ThreadPublicationError);
    const recovery = publicationError as ThreadPublicationError;
    expect(recovery.pushed).toBe(true);
    const { stdout: localCommit } = await execa("git", ["rev-parse", recovery.branch], {
      cwd: fixture.canonicalDir
    });
    const { stdout: remoteCommit } = await execa(
      "git",
      ["ls-remote", "origin", `refs/heads/${recovery.branch}`],
      { cwd: fixture.canonicalDir }
    );
    expect(localCommit.trim()).toBe(recovery.commit);
    expect(remoteCommit).toContain(recovery.commit);
    await expectCanonicalUnchanged(fixture);
  });
});
