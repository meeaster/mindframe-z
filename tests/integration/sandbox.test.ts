import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

describe("sandbox integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  it("renders sandbox agent aliases into managed zshrc", async () => {
    await writeFile(
      path.join(root, "profiles", "base", ".zshrc"),
      "alias gs='git status'\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--target", "dotfiles", "--no-link"]);

    const zshrc = await readFile(configsPath(home, "personal", "dotfiles", ".zshrc"), "utf8");
    expect(zshrc).toContain("alias mfzcc='mfz cc'");
    expect(zshrc).toContain("alias mfzoc='mfz oc'");
  });

  it("refuses sandbox launch before explicit initialization", async () => {
    await expect(cli("mfz", root, home, ["sandbox", "cc", "-p", "ok"])).rejects.toMatchObject({
      stderr: expect.stringContaining("mfz sandbox init")
    });
  });

  it("initializes sandbox secrets and provisions Agent Vault without printing secrets", async () => {
    const binDir = path.join(home, "bin");
    const argsFile = path.join(home, "docker-init-args.txt");
    await mkdir(binDir, { recursive: true });
    const docker = path.join(binDir, "docker");
    await writeFile(
      docker,
      `#!/usr/bin/env sh\nprintf '%s\n' "$@" >> ${JSON.stringify(argsFile)}\n`,
      "utf8"
    );
    await chmod(docker, 0o755);

    // Stub the Agent Vault CLI: mint a token for `agent create`, write a CA for
    // `ca fetch`, and succeed for register/login/vault-create.
    const agentVault = path.join(binDir, "agent-vault");
    await writeFile(
      agentVault,
      [
        "#!/usr/bin/env sh",
        'if [ "$1" = --version ]; then echo "agent-vault version 0.37.1"; exit 0; fi',
        'if [ "$1" = agent ] && [ "$2" = create ]; then printf stub-agent-token; exit 0; fi',
        'if [ "$1" = ca ] && [ "$2" = fetch ]; then',
        '  out=""',
        '  while [ $# -gt 0 ]; do if [ "$1" = --output ]; then out="$2"; fi; shift; done',
        '  if [ -n "$out" ]; then printf CA > "$out"; fi',
        "  exit 0",
        "fi",
        "exit 0",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(agentVault, 0o755);

    const result = await cli("mfz", root, home, ["sandbox", "init"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    });

    const secretsFile = path.join(home, ".mindframe-z", "secrets", "sandbox.env");
    const secrets = await readFile(secretsFile, "utf8");
    expect(result.stdout).toContain("sandbox initialized");
    expect(result.stdout).toContain(secretsFile);
    expect(result.stdout).toContain("Back up");
    expect(result.stdout).not.toContain(secrets.split("\n")[0] ?? "secret");
    expect(secrets).toContain("AGENT_VAULT_TOKEN=stub-agent-token");
    expect(await readFile(path.join(home, ".mindframe-z", "secrets", "mitm-ca.pem"), "utf8")).toBe(
      "CA"
    );
    expect(await readFile(argsFile, "utf8")).toContain("compose\n--env-file");
  });

  it("forwards sandbox and shortcut arguments to docker", async () => {
    await mkdir(path.join(home, ".mindframe-z", "secrets"), { recursive: true });
    await mkdir(path.join(root, "sandbox", "image"), { recursive: true });
    await writeFile(path.join(root, "sandbox", "image", "Dockerfile"), "FROM scratch\n", "utf8");
    await writeFile(
      path.join(home, ".mindframe-z", "secrets", "sandbox.env"),
      ["AGENT_VAULT_MASTER_PASSWORD=test", "AGENT_VAULT_TOKEN=test", ""].join("\n"),
      "utf8"
    );
    const binDir = path.join(home, "bin");
    const argsFile = path.join(home, "docker-args.txt");
    await mkdir(binDir, { recursive: true });
    const docker = path.join(binDir, "docker");
    await writeFile(
      docker,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
        `if [ "$1" = image ]; then printf '%s\\n' stale; fi`,
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(docker, 0o755);
    const agentVault = path.join(binDir, "agent-vault");
    await writeFile(
      agentVault,
      '#!/usr/bin/env sh\nif [ "$1" = --version ]; then echo "agent-vault version 0.37.1"; fi\nexit 0\n',
      "utf8"
    );
    await chmod(agentVault, 0o755);

    await cli("mfz", root, home, ["sandbox", "cc", "-p", "ok"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    });
    expect(await readFile(argsFile, "utf8")).toContain("claude\n-p\nok\n");

    await cli("mfz", root, home, ["oc", "run", "ok"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    });
    expect(await readFile(argsFile, "utf8")).toContain("opencode\nrun\nok\n");
  });
});
