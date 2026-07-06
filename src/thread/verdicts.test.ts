import { describe, expect, it } from "vitest";
import { hashCharter, isVerdictStanding, sourceQualifiedId, type VerdictRow } from "./verdicts.js";

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
