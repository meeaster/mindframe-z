import { describe, expect, it } from "vitest";
import { prefixParams } from "./sqlite-compat.js";

describe("prefixParams", () => {
  it("prefixes each named-param key with $ for bun:sqlite binding", () => {
    expect(prefixParams({ id: "s1", limit: 5 })).toEqual({ $id: "s1", $limit: 5 });
  });

  it("passes undefined through so positional/no-param calls are unaffected", () => {
    expect(prefixParams(undefined)).toBeUndefined();
  });
});
