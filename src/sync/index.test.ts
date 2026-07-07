import { describe, expect, it, vi } from "vitest";
import { parseProfileChoice, resolveMoves, setNested } from "./index.js";

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

describe("resolveMoves", () => {
  const profiles = ["base", "work"];

  it("assigns an available target profile to every item without prompting", async () => {
    const prompt = vi.fn();
    const moves = await resolveMoves(["a", "b"], "work", profiles, prompt);
    expect(moves).toEqual([
      { item: "a", targetProfile: "work" },
      { item: "b", targetProfile: "work" }
    ]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts per item when no target profile is given and drops skipped items", async () => {
    const prompt = vi.fn(async (item: string) => (item === "b" ? null : "base"));
    const moves = await resolveMoves(["a", "b", "c"], undefined, profiles, prompt);
    expect(moves).toEqual([
      { item: "a", targetProfile: "base" },
      { item: "c", targetProfile: "base" }
    ]);
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(prompt).toHaveBeenCalledWith("a", profiles);
  });

  it("prompts when the requested target profile is not available", async () => {
    const prompt = vi.fn(async () => "work");
    const moves = await resolveMoves(["a"], "missing", profiles, prompt);
    expect(moves).toEqual([{ item: "a", targetProfile: "work" }]);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("returns no moves for an empty item list without prompting", async () => {
    const prompt = vi.fn();
    expect(await resolveMoves([], "work", profiles, prompt)).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("setNested", () => {
  it("places a candidate under the container named by its dotted prefix", () => {
    const doc: Record<string, unknown> = { name: "personal" };
    setNested(doc, "claude.settings", "theme", "dark");
    expect(doc).toEqual({ name: "personal", claude: { settings: { theme: "dark" } } });
  });

  it("reuses an existing container instead of clobbering sibling keys", () => {
    const doc: Record<string, unknown> = { claude: { settings: { model: "sonnet" } } };
    setNested(doc, "claude.settings", "theme", "dark");
    expect(doc).toEqual({ claude: { settings: { model: "sonnet", theme: "dark" } } });
  });

  it("replaces a non-object value on the path with a fresh container", () => {
    const doc: Record<string, unknown> = { claude: "unexpected" };
    setNested(doc, "claude.settings", "theme", "dark");
    expect(doc).toEqual({ claude: { settings: { theme: "dark" } } });
  });

  it("does nothing when the prefix is empty", () => {
    const doc: Record<string, unknown> = { name: "personal" };
    setNested(doc, "", "theme", "dark");
    expect(doc).toEqual({ name: "personal" });
  });
});
