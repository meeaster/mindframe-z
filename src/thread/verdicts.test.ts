import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import { createRuntimePaths, threadSweepRoot } from "../core/paths.js";
import {
  hashCharter,
  isVerdictStanding,
  sourceQualifiedId,
  writeSweepState,
  writeVerdictLedger,
  type VerdictRow
} from "./verdicts.js";

const watermark = {
  message_count: 2,
  last_message_id: "m2",
  last_activity_at: "2026-07-06T00:00:00.000Z"
};

function row(overrides: Partial<VerdictRow> = {}): VerdictRow {
  return {
    id: sourceQualifiedId("claude-code", "abc"),
    source: "claude-code",
    bare_id: "abc",
    thread: "thread-a",
    verdict: "fits",
    reason: "matches charter",
    judged_at: "2026-07-06T00:00:00.000Z",
    watermark,
    charter_hash: hashCharter("charter"),
    ...overrides
  };
}

describe("thread verdicts", () => {
  it("hashes charters deterministically", () => {
    expect(hashCharter("charter")).toBe(hashCharter("charter"));
    expect(hashCharter("charter")).not.toBe(hashCharter("changed charter"));
  });

  it("voids agent verdicts and pass verdicts when watermark or charter moves", () => {
    expect(isVerdictStanding(row(), watermark, hashCharter("charter"))).toBe(true);
    expect(
      isVerdictStanding(
        row(),
        { ...watermark, message_count: 3, last_message_id: "m3" },
        hashCharter("charter")
      )
    ).toBe(false);
    expect(isVerdictStanding(row({ verdict: "pass" }), watermark, hashCharter("changed"))).toBe(
      false
    );
  });

  it("writes the ledger and sweep state as two-space JSON with one trailing newline", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });
    await writeVerdictLedger(paths, { verdicts: [row()] });
    await writeSweepState(paths, {});

    const ledger = await readFile(path.join(threadSweepRoot(paths), "ledger.json"), "utf8");
    expect(ledger.startsWith('{\n  "verdicts": [\n    {\n      "id": ')).toBe(true);
    expect(ledger.endsWith("}\n")).toBe(true);
    expect(ledger.endsWith("\n\n")).toBe(false);
    expect(await readFile(path.join(threadSweepRoot(paths), "sweep.json"), "utf8")).toBe("{}\n");
  });

  it("keeps reject verdicts sticky across watermark and charter changes", () => {
    expect(
      isVerdictStanding(
        row({ verdict: "reject" }),
        { ...watermark, message_count: 3, last_message_id: "m3" },
        hashCharter("changed")
      )
    ).toBe(true);
  });
});
