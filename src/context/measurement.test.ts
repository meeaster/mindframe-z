import { describe, expect, it } from "vitest";
import { measureText } from "./measurement.js";

describe("context text measurement", () => {
  it("keeps exact characters and UTF-8 bytes while labeling the heuristic separately", () => {
    expect(measureText("")).toEqual({ characters: 0, bytes: 0, estimatedTokens: 0 });
    expect(measureText("1234")).toEqual({ characters: 4, bytes: 4, estimatedTokens: 1 });
    expect(measureText("é🙂")).toEqual({ characters: 3, bytes: 6, estimatedTokens: 1 });
  });
});
