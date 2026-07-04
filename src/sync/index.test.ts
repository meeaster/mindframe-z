import { describe, expect, it } from "vitest";
import { parseProfileChoice } from "./index.js";

describe("parseProfileChoice", () => {
  const profiles = ["base", "personal", "work"];

  it("accepts exact and prefix profile names", () => {
    expect(parseProfileChoice("personal", profiles)).toEqual({ kind: "profile", name: "personal" });
    expect(parseProfileChoice("per", profiles)).toEqual({ kind: "profile", name: "personal" });
  });

  it("treats empty, skip, and s as skipped", () => {
    expect(parseProfileChoice("", profiles)).toEqual({ kind: "skip" });
    expect(parseProfileChoice("skip", profiles)).toEqual({ kind: "skip" });
    expect(parseProfileChoice("s", profiles)).toEqual({ kind: "skip" });
  });

  it("normalizes answers before matching or reporting unknown values", () => {
    expect(parseProfileChoice(" WORK ", profiles)).toEqual({ kind: "profile", name: "work" });
    expect(parseProfileChoice(" missing ", profiles)).toEqual({
      kind: "unknown",
      answer: "missing"
    });
  });
});
