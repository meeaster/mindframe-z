import { describe, expect, it } from "vitest";
import { profileSchema } from "./manifests.js";
import { mergeProfiles } from "./profile.js";

describe("mergeProfiles thread defaults", () => {
  // Regression for the default-before-inheritance trap: `session_sources` used to
  // carry an auto-filled default on every parsed profile, so a child that omitted
  // it silently clobbered the parent's intentional value during the spread merge.
  it("inherits session_sources when the child omits it", () => {
    const base = profileSchema.parse({
      name: "base",
      thread: { defaults: { session_sources: ["claude-code"] } }
    });
    const child = profileSchema.parse({ name: "child", extends: "base" });

    expect(child.thread.defaults.session_sources).toBeUndefined();

    const merged = mergeProfiles(base, child);
    expect(merged.thread.defaults.session_sources).toEqual(["claude-code"]);
  });

  it("lets a child override session_sources when it sets its own", () => {
    const base = profileSchema.parse({
      name: "base",
      thread: { defaults: { session_sources: ["claude-code"] } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      thread: { defaults: { session_sources: ["opencode"] } }
    });

    expect(mergeProfiles(base, child).thread.defaults.session_sources).toEqual(["opencode"]);
  });

  // Same trap, one level up on the `thread` object: `update_strategy` must stay optional
  // (no parse-time default) or a child that omits it would clobber a parent's `delta`.
  it("inherits update_strategy when the child omits it", () => {
    const base = profileSchema.parse({ name: "base", thread: { update_strategy: "delta" } });
    const child = profileSchema.parse({ name: "child", extends: "base" });

    expect(child.thread.update_strategy).toBeUndefined();
    expect(mergeProfiles(base, child).thread.update_strategy).toBe("delta");
  });

  it("lets a child override update_strategy when it sets its own", () => {
    const base = profileSchema.parse({ name: "base", thread: { update_strategy: "delta" } });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      thread: { update_strategy: "full" }
    });

    expect(mergeProfiles(base, child).thread.update_strategy).toBe("full");
  });
});

describe("mergeProfiles codex plugins", () => {
  it("merges child plugins with base plugins", () => {
    const base = profileSchema.parse({
      name: "base",
      codex: { plugins: { "github@openai-curated": { enabled: true } } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      codex: { plugins: { "teams@openai-curated": { enabled: true } } }
    });

    expect(mergeProfiles(base, child).codex.plugins).toEqual({
      "github@openai-curated": { enabled: true },
      "teams@openai-curated": { enabled: true }
    });
  });

  it("lets a child override a base plugin", () => {
    const base = profileSchema.parse({
      name: "base",
      codex: { plugins: { "github@openai-curated": { enabled: true } } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      codex: { plugins: { "github@openai-curated": { enabled: false } } }
    });

    expect(mergeProfiles(base, child).codex.plugins["github@openai-curated"]?.enabled).toBe(false);
  });
});
