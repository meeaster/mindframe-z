import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import { threadIndexContent, writeThreadIndex } from "./index.js";
import { writeThreadManifest, type ThreadManifest } from "./storage.js";

function manifest(overrides: Partial<ThreadManifest>): ThreadManifest {
  return {
    slug: "thread-a",
    charter: "Preserve prior reasoning.",
    store: "personal-knowledge",
    created_at: "2026-07-01T00:00:00.000Z",
    sessions: [],
    excluded: [],
    synthesis: {},
    ...overrides
  };
}

describe("thread index", () => {
  it("renders threads in stable slug order with titles, activity, and digest links", () => {
    const content = threadIndexContent([
      manifest({
        slug: "thread-b",
        title: "Thread B",
        charter: "A charter\nwith wrapped text.",
        sessions: [
          {
            id: "session-1",
            source: "opencode",
            last_activity_at: "2026-07-03T00:00:00.000Z"
          }
        ]
      }),
      manifest({ slug: "thread-a" })
    ]);

    expect(content.indexOf("`thread-a`")).toBeLessThan(content.indexOf("`thread-b`"));
    expect(content).toContain("[`thread-a`](thread-a/digest.md)");
    expect(content).toContain("**Thread B**: A charter with wrapped text.");
    expect(content).toContain("1 session; latest activity 2026-07-03T00:00:00.000Z");
  });

  it("renders an explicit empty state", () => {
    expect(threadIndexContent([])).toContain("_No threads are currently available._");
  });

  it("writes byte-stable output from store manifests", async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, "thread-a"));
    await writeThreadManifest(path.join(root, "thread-a"), manifest({}));

    await writeThreadIndex(root);
    const first = await readFile(path.join(root, "index.md"), "utf8");
    await writeThreadIndex(root);
    const second = await readFile(path.join(root, "index.md"), "utf8");

    expect(second).toBe(first);
  });
});
