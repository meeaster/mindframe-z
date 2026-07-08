import { describe, expect, it } from "vitest";
import { parseEnvRef } from "./env-ref.js";

describe("parseEnvRef", () => {
  it("returns the variable name for a whole env reference", () => {
    expect(parseEnvRef("{env:EXA_API_KEY}")).toBe("EXA_API_KEY");
  });

  it("returns null for a literal value", () => {
    expect(parseEnvRef("literal-secret")).toBeNull();
  });

  it("returns null when the reference is not the whole value", () => {
    expect(parseEnvRef("Bearer {env:TOKEN}")).toBeNull();
    expect(parseEnvRef("{env:TOKEN}/path")).toBeNull();
  });

  it("returns null for an empty reference body", () => {
    expect(parseEnvRef("{env:}")).toBeNull();
  });
});
