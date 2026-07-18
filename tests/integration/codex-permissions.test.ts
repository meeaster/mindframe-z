import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

// Codex has no per-path "ask" filesystem level, so the renderer collapses each
// extra folder's mfz read/edit pair into one of deny/read/write. The apply suite
// already pins the read (references_dir) and write (allow/allow) outcomes; this
// suite pins the two remaining branches — a fully denied folder and an
// ask-editable folder that degrades to read-only — so a future reshaping of the
// permission mapping cannot silently widen or drop Codex filesystem access.
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

    // Declare one denied folder and one ask-editable (read-only) folder.
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
      [path.join(home, "readonly")]: "read"
    });
  });
});
