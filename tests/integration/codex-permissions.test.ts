import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

// Codex has no per-path "ask" filesystem level, so the renderer collapses each
// extra folder's mfz read/edit pair into one of deny/read/write. The apply suite
// already pins the read (references_dir) and write (allow/allow) outcomes; this
// suite pins the remaining branches — a fully denied folder, an ask-editable
// folder that degrades to read-only, and the two asymmetric-deny cases where a
// single deny on either axis dominates an allow on the other — so a future
// reshaping of the permission mapping (e.g. an "&&" that only denies when both
// axes deny) cannot silently widen or drop Codex filesystem access.
describe("codex extra-folder permission translation", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());

    // Activate codex for the personal profile.
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    const profileYml = (await readFile(profilePath, "utf8")).replace(
      "agents: [opencode, claude-code]",
      "agents: [codex]"
    );
    await writeFile(profilePath, profileYml, "utf8");

    // Declare a fully denied folder, an ask-editable (read-only) folder, and the
    // two asymmetric cases where a single deny must dominate an allow.
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        "  - path: ~/denied",
        "    description: Denied folder",
        "    read: deny",
        "    edit: deny",
        "  - path: ~/readonly",
        "    description: Read-only folder",
        "    edit: ask",
        "  - path: ~/editlocked",
        "    description: Readable but edit-denied folder",
        "    read: allow",
        "    edit: deny",
        "  - path: ~/readlocked",
        "    description: Read-denied but editable folder",
        "    read: deny",
        "    edit: allow",
        ""
      ].join("\n"),
      "utf8"
    );
  });

  it("maps denied folders to deny and ask-editable folders to read", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const config = parse(
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    ) as {
      default_permissions?: string;
      permissions: { mfz: { filesystem: Record<string, string> } };
    };

    // A generated permission profile is only named when filesystem rules exist.
    expect(config.default_permissions).toBe("mfz");
    expect(config.permissions.mfz.filesystem).toEqual({
      [path.join(home, "references")]: "read",
      [path.join(home, "denied")]: "deny",
      [path.join(home, "readonly")]: "read",
      // edit: deny dominates read: allow — must stay deny, not degrade to read/write.
      [path.join(home, "editlocked")]: "deny",
      // read: deny dominates edit: allow — must stay deny, not widen to write.
      [path.join(home, "readlocked")]: "deny"
    });
  });
});
