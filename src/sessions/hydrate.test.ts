import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import type { Archive } from "../core/manifests.js";
import { archiveCacheRoot, type RuntimePaths } from "../core/paths.js";
import { hydrateSession, isHydrated } from "./hydrate.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    configsDir: path.join(home, "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

function archive(name: string, prefix = ""): Archive {
  return {
    name,
    bucket: `bucket-${name}`,
    region: "us-east-1",
    prefix,
    default: name === "default"
  };
}

// A fake per-archive S3 client holding a fixed set of objects, keyed by full S3 key.
// Covers exactly the two commands hydrateSession sends. `failGetKeys` simulates a
// GetObject that throws partway through a multi-key session download.
class FakeArchiveS3 {
  public gotten: string[] = [];
  constructor(
    private objects: Map<string, Buffer> | "unreachable",
    private failGetKeys: Set<string> = new Set()
  ) {}

  async send(command: unknown): Promise<unknown> {
    if (this.objects === "unreachable") throw new Error("network unreachable");
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      const contents = [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ Key: key }));
      return { Contents: contents, IsTruncated: false };
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key as string;
      this.gotten.push(key);
      if (this.failGetKeys.has(key)) throw new Error(`simulated failure fetching key: ${key}`);
      const body = this.objects.get(key);
      if (body === undefined) throw new Error(`no such key: ${key}`);
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    throw new Error(`FakeArchiveS3: unsupported command ${command?.constructor?.name}`);
  }
}

describe("hydrateSession", () => {
  it("pulls a session by prefix, preserving the subtree including subagents", async () => {
    const home = await makeTempDir();
    const objects = new Map<string, Buffer>([
      ["claude-code/sess-1.jsonl", Buffer.from("main transcript")],
      ["claude-code/sess-1/subagents/agent-1.jsonl", Buffer.from("subagent transcript")]
    ]);
    const fake = new FakeArchiveS3(objects);

    const ok = await hydrateSession(
      paths(home),
      [archive("default")],
      "claude-code",
      "sess-1",
      () => fake as unknown as S3Client
    );

    expect(ok).toBe(true);
    const root = archiveCacheRoot(paths(home));
    await expect(readFile(path.join(root, "claude-code", "sess-1.jsonl"), "utf8")).resolves.toBe(
      "main transcript"
    );
    await expect(
      readFile(path.join(root, "claude-code", "sess-1", "subagents", "agent-1.jsonl"), "utf8")
    ).resolves.toBe("subagent transcript");
  });

  it("is write-once: a cache hit performs no archive read", async () => {
    const home = await makeTempDir();
    const root = archiveCacheRoot(paths(home));
    await mkdir(path.join(root, "claude-code"), { recursive: true });
    await writeFile(path.join(root, "claude-code", "cached.jsonl"), "already here", "utf8");

    let called = false;
    const ok = await hydrateSession(
      paths(home),
      [archive("default")],
      "claude-code",
      "cached",
      () => {
        called = true;
        throw new Error("must not construct a client on a cache hit");
      }
    );

    expect(ok).toBe(true);
    expect(called).toBe(false);
  });

  it("reports the session as hydrated once cached", async () => {
    const home = await makeTempDir();
    expect(await isHydrated(paths(home), "opencode", "ses_1")).toBe(false);
    const root = archiveCacheRoot(paths(home));
    await mkdir(path.join(root, "opencode"), { recursive: true });
    await writeFile(path.join(root, "opencode", "ses_1.json"), "{}", "utf8");
    expect(await isHydrated(paths(home), "opencode", "ses_1")).toBe(true);
  });

  it("returns false and leaves the session vanished when no archive holds it", async () => {
    const home = await makeTempDir();
    const fake = new FakeArchiveS3(new Map());

    const ok = await hydrateSession(
      paths(home),
      [archive("default")],
      "claude-code",
      "missing",
      () => fake as unknown as S3Client
    );

    expect(ok).toBe(false);
    expect(await isHydrated(paths(home), "claude-code", "missing")).toBe(false);
  });

  it("falls through to the next archive when the first is unreachable", async () => {
    const home = await makeTempDir();
    const unreachable = new FakeArchiveS3("unreachable");
    const reachable = new FakeArchiveS3(
      new Map([["claude-code/sess-2.jsonl", Buffer.from("content")]])
    );

    const ok = await hydrateSession(
      paths(home),
      [archive("primary"), archive("secondary")],
      "claude-code",
      "sess-2",
      (a) =>
        a.name === "primary"
          ? (unreachable as unknown as S3Client)
          : (reachable as unknown as S3Client)
    );

    expect(ok).toBe(true);
    await expect(
      readFile(path.join(archiveCacheRoot(paths(home)), "claude-code", "sess-2.jsonl"), "utf8")
    ).resolves.toBe("content");
  });

  it("leaves no partial cache when a download fails partway through a multi-key session", async () => {
    // The primary transcript sorts before /subagents/ keys, so without atomic staging
    // this would otherwise leave a primary-only cache that isHydrated reports complete.
    const home = await makeTempDir();
    const objects = new Map<string, Buffer>([
      ["claude-code/sess-3.jsonl", Buffer.from("main transcript")],
      ["claude-code/sess-3/subagents/agent-1.jsonl", Buffer.from("subagent transcript")]
    ]);
    const fake = new FakeArchiveS3(
      objects,
      new Set(["claude-code/sess-3/subagents/agent-1.jsonl"])
    );

    const ok = await hydrateSession(
      paths(home),
      [archive("default")],
      "claude-code",
      "sess-3",
      () => fake as unknown as S3Client
    );

    expect(ok).toBe(false);
    expect(await isHydrated(paths(home), "claude-code", "sess-3")).toBe(false);
    await expect(
      readFile(path.join(archiveCacheRoot(paths(home)), "claude-code", "sess-3.jsonl"), "utf8")
    ).rejects.toThrow();
  });

  it("does not cache a false negative when the only archive is merely unreachable", async () => {
    const home = await makeTempDir();
    const unreachable = new FakeArchiveS3("unreachable");

    const ok = await hydrateSession(
      paths(home),
      [archive("default")],
      "claude-code",
      "sess-4",
      () => unreachable as unknown as S3Client
    );

    expect(ok).toBe(false);
    await expect(
      readFile(path.join(archiveCacheRoot(paths(home)), "claude-code", "sess-4.absent"), "utf8")
    ).rejects.toThrow();
  });

  it("is negatively cached: a confirmed-absent session performs no further archive reads on retry", async () => {
    const home = await makeTempDir();
    const empty = new FakeArchiveS3(new Map());

    const first = await hydrateSession(
      paths(home),
      [archive("default")],
      "claude-code",
      "sess-5",
      () => empty as unknown as S3Client
    );
    expect(first).toBe(false);

    let called = false;
    const second = await hydrateSession(
      paths(home),
      [archive("default")],
      "claude-code",
      "sess-5",
      () => {
        called = true;
        throw new Error("must not construct a client once confirmed absent");
      }
    );

    expect(second).toBe(false);
    expect(called).toBe(false);
  });

  it("skips a profile-pinned archive rather than reading it with ambient credentials", async () => {
    const home = await makeTempDir();
    const pinned = archive("pinned");
    pinned.profile = "work-sso";
    const readable = new FakeArchiveS3(
      new Map([["claude-code/sess-6.jsonl", Buffer.from("content")]])
    );

    let pinnedClientConstructed = false;
    const ok = await hydrateSession(
      paths(home),
      [pinned, archive("secondary")],
      "claude-code",
      "sess-6",
      (a) => {
        if (a.name === "pinned") pinnedClientConstructed = true;
        return readable as unknown as S3Client;
      }
    );

    expect(ok).toBe(true);
    expect(pinnedClientConstructed).toBe(false);
  });

  it("does not cache a negative result when every archive is profile-pinned", async () => {
    const home = await makeTempDir();
    const pinned = archive("pinned");
    pinned.profile = "work-sso";

    let called = false;
    const ok = await hydrateSession(paths(home), [pinned], "claude-code", "sess-7", () => {
      called = true;
      throw new Error("must not construct a client for a profile-pinned archive");
    });

    expect(ok).toBe(false);
    expect(called).toBe(false);
    await expect(
      readFile(path.join(archiveCacheRoot(paths(home)), "claude-code", "sess-7.absent"), "utf8")
    ).rejects.toThrow();
  });
});
