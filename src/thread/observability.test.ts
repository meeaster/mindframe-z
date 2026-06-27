import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import { createRuntimePaths, threadRunPath } from "../core/paths.js";
import { writeRunDossiers } from "./observability.js";

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
