import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import { createRuntimePaths, threadRunPath } from "../core/paths.js";
import { writeRunDossiers, writeRunStatus } from "./observability.js";

describe("writeRunDossiers", () => {
  it("writes dossiers under the canonical run path, not a hand-built one", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });

    await writeRunDossiers(paths, "run-1", [
      { source: "claude-code", id: "sess-a", text: "DOSSIER A" },
      { source: "opencode", id: "ses_b", text: "DOSSIER B" }
    ]);

    const dossiers = path.join(threadRunPath(paths, "run-1"), "dossiers");
    await expect(readFile(path.join(dossiers, "claude-code-sess-a.md"), "utf8")).resolves.toBe(
      "DOSSIER A"
    );
    await expect(readFile(path.join(dossiers, "opencode-ses_b.md"), "utf8")).resolves.toBe(
      "DOSSIER B"
    );
  });
});

describe("writeRunStatus", () => {
  it("writes the status record as two-space JSON with one trailing newline", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });

    await writeRunStatus(paths, {
      id: "run-2",
      mode: "sweep",
      pid: 4242,
      current_step: "gather",
      started_at: "2026-07-06T00:00:00.000Z",
      cost_usd: null
    });

    expect(await readFile(path.join(threadRunPath(paths, "run-2"), "status.json"), "utf8")).toBe(
      '{\n  "id": "run-2",\n  "mode": "sweep",\n  "pid": 4242,\n  "current_step": "gather",\n  "started_at": "2026-07-06T00:00:00.000Z",\n  "cost_usd": null\n}\n'
    );
  });
});
