import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expandHome } from "./path-util.js";

describe("expandHome", () => {
  it("returns the home directory for a bare tilde", () => {
    expect(expandHome("~", "/tmp/home")).toBe("/tmp/home");
  });

  it("joins tilde-slash paths onto home", () => {
    expect(expandHome("~/nested/dir", "/tmp/home")).toBe(path.join("/tmp/home", "nested", "dir"));
  });

  it("leaves non-tilde paths untouched", () => {
    expect(expandHome("/abs/path", "/tmp/home")).toBe("/abs/path");
    expect(expandHome("relative/path", "/tmp/home")).toBe("relative/path");
  });

  it("does not expand a tilde-user prefix", () => {
    expect(expandHome("~alice", "/tmp/home")).toBe("~alice");
    expect(expandHome("~alice/dir", "/tmp/home")).toBe("~alice/dir");
  });

  describe("default home argument", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("falls back to process.env.HOME", () => {
      vi.stubEnv("HOME", "/tmp/env-home");
      expect(expandHome("~/dir")).toBe(path.join("/tmp/env-home", "dir"));
    });

    it("falls back to an empty home when HOME is unset", () => {
      vi.stubEnv("HOME", undefined);
      expect(expandHome("~")).toBe("");
    });
  });
});
