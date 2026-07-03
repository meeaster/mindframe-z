import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  GetPublicAccessBlockCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import type { RuntimePaths } from "../core/paths.js";
import { defaultArchive, harnessPrefix, objectKey, resolveDefaultArchive } from "./archive.js";
import { listOpencodeItems } from "./opencode-source.js";
import { assertBucketHardened } from "./preflight.js";
import { backupHarness, needsUpload } from "./backup.js";
import type { BackupItem } from "./backup-item.js";

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

const bucketArchive = {
  name: "work",
  bucket: "mfz-test-bucket",
  region: "us-east-1",
  prefix: "",
  default: true
};

describe("defaultArchive / resolveDefaultArchive", () => {
  it("picks the last entry flagged default", () => {
    const archives = [
      { ...bucketArchive, name: "a", default: false },
      { ...bucketArchive, name: "b", default: true },
      { ...bucketArchive, name: "c", default: true }
    ];
    expect(defaultArchive(archives)?.name).toBe("c");
  });

  it("falls back to the first entry when none is flagged default", () => {
    const archives = [
      { ...bucketArchive, name: "a", default: false },
      { ...bucketArchive, name: "b", default: false }
    ];
    expect(defaultArchive(archives)?.name).toBe("a");
  });

  it("throws an actionable error when no archive is configured", () => {
    expect(() => resolveDefaultArchive([])).toThrow(/mindframe-z\/config\.yml/);
  });

  it("rejects a profile-pinned archive rather than falling back to default creds", () => {
    const archives = [{ ...bucketArchive, profile: "work-sso" }];
    expect(() => resolveDefaultArchive(archives)).toThrow(/not supported/);
  });

  it("resolves a non-pinned default archive", () => {
    expect(resolveDefaultArchive([bucketArchive]).name).toBe("work");
  });
});

describe("objectKey / harnessPrefix", () => {
  it("flattens prefix/harness/relPath, dropping empty segments", () => {
    expect(objectKey({ ...bucketArchive, prefix: "" }, "claude-code", "abc.jsonl")).toBe(
      "claude-code/abc.jsonl"
    );
    expect(objectKey({ ...bucketArchive, prefix: "mach1" }, "opencode", "abc.json")).toBe(
      "mach1/opencode/abc.json"
    );
  });

  it("keys subagent transcripts under the session's own prefix", () => {
    expect(
      objectKey({ ...bucketArchive, prefix: "" }, "claude-code", "sess-1/subagents/agent-1.jsonl")
    ).toBe("claude-code/sess-1/subagents/agent-1.jsonl");
  });

  it("harnessPrefix always ends with a trailing slash", () => {
    expect(harnessPrefix({ ...bucketArchive, prefix: "mach1" }, "opencode")).toBe(
      "mach1/opencode/"
    );
    expect(harnessPrefix({ ...bucketArchive, prefix: "" }, "opencode")).toBe("opencode/");
  });
});

// A fake S3 client covering exactly the commands backup.ts sends, so the freshness
// guard and preflight can be exercised without a real bucket.
class FakeS3 {
  public puts: Array<{ Key: string; Body: Buffer; ServerSideEncryption?: string | undefined }> = [];
  constructor(
    private objects: Map<string, number>,
    private accessBlock: Record<string, boolean> | "unreadable" = {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true
    }
  ) {}

  async send(command: unknown): Promise<unknown> {
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      const contents = [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, lastModified]) => ({ Key: key, LastModified: new Date(lastModified) }));
      return { Contents: contents, IsTruncated: false };
    }
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body as Buffer;
      this.objects.set(command.input.Key as string, Date.now());
      this.puts.push({
        Key: command.input.Key as string,
        Body: body,
        ServerSideEncryption: command.input.ServerSideEncryption
      });
      return {};
    }
    if (command instanceof GetPublicAccessBlockCommand) {
      if (this.accessBlock === "unreadable") {
        throw new Error("NoSuchPublicAccessBlockConfiguration");
      }
      return { PublicAccessBlockConfiguration: this.accessBlock };
    }
    throw new Error(`FakeS3: unsupported command ${command?.constructor?.name}`);
  }
}

describe("assertBucketHardened", () => {
  it("passes when all four Block Public Access flags are true", async () => {
    const client = new FakeS3(new Map()) as unknown as S3Client;
    await expect(assertBucketHardened(client, bucketArchive)).resolves.toBeUndefined();
  });

  it("aborts when public access is not fully blocked", async () => {
    const client = new FakeS3(new Map(), {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: false,
      RestrictPublicBuckets: true
    }) as unknown as S3Client;
    await expect(assertBucketHardened(client, bucketArchive)).rejects.toThrow(
      /Block Public Access/
    );
  });

  it("aborts when the public-access-block config is unreadable", async () => {
    const client = new FakeS3(new Map(), "unreadable") as unknown as S3Client;
    await expect(assertBucketHardened(client, bucketArchive)).rejects.toThrow(
      /BUCKET-LEVEL Block Public Access/
    );
  });
});

const MARGIN_MS = 5 * 60_000;

describe("needsUpload", () => {
  it("is true when there is no stored copy yet", () => {
    expect(needsUpload(Date.now(), undefined)).toBe(true);
  });

  it("is true when the source signal is newer than stored", () => {
    const now = Date.now();
    expect(needsUpload(now, now - 10 * 60_000)).toBe(true);
  });

  it("is false when the source signal is not newer than stored minus the margin", () => {
    const now = Date.now();
    expect(needsUpload(now - MARGIN_MS - 1000, now)).toBe(false);
  });

  it("re-uploads a write landing mid-sweep instead of freezing it out", () => {
    // LastModified is upload time, always >= the write it captured. A source signal
    // landing just before that LastModified must still be treated as changed on the
    // next run, not skipped forever.
    const uploadedAt = Date.now();
    const sourceSignalJustBeforeUpload = uploadedAt - 1000;
    expect(needsUpload(sourceSignalJustBeforeUpload, uploadedAt)).toBe(true);
  });
});

function item(relPath: string, sourceMs: number, body = "content"): BackupItem {
  return {
    relPath,
    sourceMs,
    contentType: "application/x-ndjson",
    load: async () => Buffer.from(body)
  };
}

describe("backupHarness", () => {
  it("uploads new sessions, skips unchanged, uploads changed, and reports counts", async () => {
    const now = Date.now();
    const store = new Map<string, number>([
      ["claude-code/unchanged.jsonl", now],
      ["claude-code/changed.jsonl", now - 10 * 60_000]
    ]);
    const client = new FakeS3(store) as unknown as S3Client;

    const summary = await backupHarness(client, bucketArchive, "claude-code", [
      item("new.jsonl", now),
      item("changed.jsonl", now),
      item("unchanged.jsonl", now - MARGIN_MS - 1000)
    ]);

    expect(summary).toEqual({ uploaded: 2, skipped: 1, failed: 0 });
  });

  it("sets ServerSideEncryption AES256 on every upload", async () => {
    const client = new FakeS3(new Map());

    await backupHarness(client as unknown as S3Client, bucketArchive, "claude-code", [
      item("new.jsonl", Date.now())
    ]);

    expect(client.puts).toHaveLength(1);
    expect(client.puts[0]?.ServerSideEncryption).toBe("AES256");
  });

  it("keys subagent transcripts under the session's own prefix", async () => {
    const client = new FakeS3(new Map());

    await backupHarness(client as unknown as S3Client, bucketArchive, "claude-code", [
      item("sess-1/subagents/agent-1.jsonl", Date.now())
    ]);

    expect(client.puts[0]?.Key).toBe("claude-code/sess-1/subagents/agent-1.jsonl");
  });

  it("does not abort the sweep when one session fails to upload", async () => {
    const client = new FakeS3(new Map());
    const failing: BackupItem = {
      relPath: "broken.jsonl",
      sourceMs: Date.now(),
      contentType: "application/x-ndjson",
      load: async () => {
        throw new Error("boom");
      }
    };

    const summary = await backupHarness(
      client as unknown as S3Client,
      bucketArchive,
      "claude-code",
      [failing, item("ok.jsonl", Date.now())]
    );

    expect(summary).toEqual({ uploaded: 1, skipped: 0, failed: 1 });
  });
});

describe("listOpencodeItems", () => {
  async function writeDb(
    home: string,
    sessions: Array<{ id: string; time_updated: number }>,
    messages: Array<{ id: string; session_id: string; time_created: number }>
  ): Promise<void> {
    const dir = path.join(home, ".local", "share", "opencode");
    await mkdir(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "opencode.db"));
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL)");
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL)"
    );
    const insertSession = db.prepare("INSERT INTO session (id, time_updated) VALUES (?, ?)");
    for (const s of sessions) insertSession.run(s.id, s.time_updated);
    const insertMessage = db.prepare(
      "INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)"
    );
    for (const m of messages) insertMessage.run(m.id, m.session_id, m.time_created);
    db.close();
  }

  it("enumerates sessions from the session table, keyed <id>.json", async () => {
    const home = await makeTempDir();
    await writeDb(home, [{ id: "ses_a", time_updated: 1000 }], []);

    const items = await listOpencodeItems(paths(home));

    expect(items).toHaveLength(1);
    expect(items[0]?.relPath).toBe("ses_a.json");
    expect(items[0]?.contentType).toBe("application/json");
  });

  it("derives the signal as the greater of time_updated and the latest message time_created", async () => {
    const home = await makeTempDir();
    await writeDb(
      home,
      [{ id: "ses_a", time_updated: 1000 }],
      [
        { id: "m1", session_id: "ses_a", time_created: 500 },
        { id: "m2", session_id: "ses_a", time_created: 2000 }
      ]
    );

    const items = await listOpencodeItems(paths(home));

    expect(items[0]?.sourceMs).toBe(2000);
  });

  it("detects message growth without a session-row update", async () => {
    // The exact gap the design doc calls out: time_updated stays frozen but a new
    // message lands with a newer time_created, so the signal must still advance.
    const home = await makeTempDir();
    await writeDb(
      home,
      [{ id: "ses_a", time_updated: 100 }],
      [{ id: "m1", session_id: "ses_a", time_created: 999_999 }]
    );

    const items = await listOpencodeItems(paths(home));

    expect(items[0]?.sourceMs).toBe(999_999);
  });

  it("uses time_updated when a session has no messages yet", async () => {
    const home = await makeTempDir();
    await writeDb(home, [{ id: "ses_a", time_updated: 4242 }], []);

    const items = await listOpencodeItems(paths(home));

    expect(items[0]?.sourceMs).toBe(4242);
  });

  it("returns no items when opencode.db does not exist", async () => {
    const home = await makeTempDir();
    expect(await listOpencodeItems(paths(home))).toEqual([]);
  });
});
