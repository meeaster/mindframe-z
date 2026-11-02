import { describe, expect, it } from "vitest";
import { machineSchema, repoSchema } from "./manifests.js";
import { resolveRepo } from "./repos.js";

const home = "/home/tester";

describe("resolveRepo", () => {
  it("clones GitHub repositories over the machine's protocol into the workspace", () => {
    const entry = repoSchema.parse({ name: "cairn", github: "meeaster/cairn" });

    expect(resolveRepo(entry, machineSchema.parse({}), home)).toMatchObject({
      path: "/home/tester/workspace/repos/cairn",
      cloneUrl: "https://github.com/meeaster/cairn.git"
    });
    expect(
      resolveRepo(entry, machineSchema.parse({ git: { protocol: "ssh" } }), home).cloneUrl
    ).toBe("git@github.com:meeaster/cairn.git");
  });

  it("uses a non-GitHub URL as written and honors a custom path and workspace root", () => {
    const entry = repoSchema.parse({
      name: "notes",
      url: "https://git.example.com/me/notes.git",
      path: "knowledge/notes"
    });

    const machine = machineSchema.parse({ workspace_root: "~/work", git: { protocol: "ssh" } });

    expect(resolveRepo(entry, machine, home)).toMatchObject({
      path: "/home/tester/work/knowledge/notes",
      cloneUrl: "https://git.example.com/me/notes.git"
    });
  });

  it("requires exactly one of github and url", () => {
    expect(() => repoSchema.parse({ name: "both", github: "a/b", url: "https://x" })).toThrow();
    expect(() => repoSchema.parse({ name: "neither" })).toThrow();
  });
});
