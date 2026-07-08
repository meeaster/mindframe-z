import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import { createRuntimePaths } from "../core/paths.js";
import { writeRunStatus } from "./observability.js";
import type { AgentRunner } from "./runner.js";
import {
  runThreadCreate,
  runThreadDelete,
  runThreadDestinations,
  runThreadDiscover,
  runThreadIngest,
  runThreadList,
  runThreadObserveDown,
  runThreadObserveStatus,
  runThreadObserveUp,
  runThreadRegenerate,
  runThreadRuns,
  runThreadSync
} from "./cli.js";
import { lapdogImageRef, lapdogNetworkName } from "./lapdog.js";

const oldPath = process.env.PATH;
const oldStateDir = process.env.FAKE_DOCKER_STATE_DIR;

afterEach(() => {
  process.env.PATH = oldPath;
  if (oldStateDir === undefined) delete process.env.FAKE_DOCKER_STATE_DIR;
  else process.env.FAKE_DOCKER_STATE_DIR = oldStateDir;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  logs.length = 0;
});

async function writeFakeDocker(home: string): Promise<string> {
  const binDir = path.join(home, "bin");
  const stateDir = path.join(home, "fake-docker-state");
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const docker = path.join(binDir, "docker");
  const inspectJson = JSON.stringify({
    State: { Running: true },
    Config: { Image: lapdogImageRef },
    NetworkSettings: { Networks: { [lapdogNetworkName]: null } }
  });
  const lines = [
    "#!/usr/bin/env sh",
    "STATE=${FAKE_DOCKER_STATE_DIR:?FAKE_DOCKER_STATE_DIR not set}",
    'log() { printf \'%s\\n\' "$*" >> "$STATE/docker.log"; }',
    'log "$*"',
    'if [ "$1" = network ] && [ "$2" = inspect ] && [ "$3" = mfz-net ]; then',
    '  [ -f "$STATE/network-exists" ] && exit 0 || exit 1',
    "fi",
    'if [ "$1" = network ] && [ "$2" = create ] && [ "$3" = mfz-net ]; then',
    '  touch "$STATE/network-exists"; exit 0',
    "fi",
    'if [ "$1" = inspect ] && [ "$2" = lapdog ]; then',
    '  if [ -f "$STATE/container-exists" ]; then',
    `    printf '%s' '${inspectJson}'`,
    "    exit 0",
    "  fi",
    "  exit 1",
    "fi",
    'if [ "$1" = run ]; then',
    '  shift; while [ "$1" != --name ] && [ $# -gt 0 ]; do shift; done; shift',
    '  touch "$STATE/container-exists"; exit 0',
    "fi",
    'if [ "$1" = rm ]; then',
    '  rm -f "$STATE/container-exists"; exit 0',
    "fi",
    'if [ "$1" = network ] && [ "$2" = rm ]; then',
    '  rm -f "$STATE/network-exists"; exit 0',
    "fi",
    "exit 0"
  ];
  await writeFile(docker, lines.join("\n") + "\n", "utf8");
  await chmod(docker, 0o755);
  process.env.FAKE_DOCKER_STATE_DIR = stateDir;
  await writeFile(path.join(stateDir, "docker.log"), "", "utf8");
  return stateDir;
}

// A self-contained fixture root so these tests own their profile/destinations
// instead of reading the live repo `profiles/`, where legitimate config edits
// (adding/removing destinations) would otherwise break unrelated thread tests.
async function makeFixtureRoot(): Promise<string> {
  const root = await makeTempDir();
  await mkdir(path.join(root, "catalog"), { recursive: true });
  await writeFile(path.join(root, "mfz_home.yml"), "description: Thread test home\n", "utf8");
  await writeFile(path.join(root, "catalog", "references.yml"), "references: []\n", "utf8");
  await writeFile(path.join(root, "catalog", "skills.yml"), "skills: []\n", "utf8");
  await writeFile(path.join(root, "catalog", "mcp.yml"), "servers: {}\n", "utf8");
  const profileDir = path.join(root, "profiles", "base");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(profileDir, "profile.yml"),
    [
      "name: base",
      "thread:",
      "  destinations:",
      "    - name: personal",
      "      default: true",
      ""
    ].join("\n"),
    "utf8"
  );
  return root;
}

const logs: string[] = [];

function captureConsole(): void {
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    logs.push(String(value));
  });
}

describe("thread cli", () => {
  it("creates a thread without dispatch and lists it", async () => {
    captureConsole();
    const home = await makeTempDir();
    const root = await makeFixtureRoot();

    await runThreadCreate("thread-a", {
      root,
      home,
      profile: "base",
      dest: "personal",
      charter: "Track thread work."
    });
    await runThreadList({ root, home, profile: "base" });

    const manifest = JSON.parse(
      await readFile(
        path.join(home, ".mindframe-z", "threads", "thread-a", "manifest.json"),
        "utf8"
      )
    );
    expect(manifest).toMatchObject({ slug: "thread-a", destination: "personal" });
    expect(logs).toContain("created\tthread-a\tpersonal");
    expect(logs).toContain("thread-a\tpersonal\t0 sessions");
  });

  it("prints configured destinations as JSON", async () => {
    captureConsole();
    const home = await makeTempDir();
    await runThreadDestinations({
      root: await makeFixtureRoot(),
      home,
      profile: "base",
      json: true
    });

    const parsed = JSON.parse(logs[0]!) as { destinations: Array<{ name: string }> };
    expect(parsed.destinations).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "personal" })])
    );
  });

  it("uses the fake runner seam for discovery", async () => {
    captureConsole();
    const home = await makeTempDir();
    const runner: AgentRunner = {
      async run() {
        return {
          text: "session-1\tclaude-code\tmatched prompt",
          rawTrace: JSON.stringify({ type: "result", result: "session-1" }) + "\n",
          durationMs: 1,
          usage: {
            cost_usd: 0.01,
            input_tokens: null,
            output_tokens: null,
            reasoning_tokens: null
          },
          rawUsage: null
        };
      }
    };

    await runThreadDiscover("thread design", {
      root: await makeFixtureRoot(),
      home,
      profile: "base",
      runner
    });

    expect(logs).toContain("session-1\tclaude-code\tmatched prompt");
    const runsRoot = path.join(home, ".mindframe-z", "thread-runs", "runs");
    const runDirs = await import("node:fs/promises").then((fs) => fs.readdir(runsRoot));
    expect(runDirs).toHaveLength(1);
    const status = JSON.parse(
      await readFile(path.join(runsRoot, runDirs[0]!, "status.json"), "utf8")
    );
    expect(status).toMatchObject({ mode: "discover", current_step: "complete", cost_usd: 0.01 });
    await expect(
      readFile(path.join(runsRoot, runDirs[0]!, "discover.jsonl"), "utf8")
    ).resolves.toContain("session-1");
  });

  it("ingests two sessions: two-stage split, parallel, deterministic log, one digest", async () => {
    captureConsole();
    const home = await makeTempDir();
    const root = await makeFixtureRoot();

    // Each session's synthesized file carries one Decision; sess-b is timestamped
    // earlier than sess-a so the log can prove it sorts by timestamp, not id order.
    const timestamps: Record<string, string> = {
      "sess-a": "2026-01-02 09:00",
      "sess-b": "2026-01-01 08:00"
    };
    // Each session file is H1 + sections (no frontmatter). TS lifts the title from
    // the H1 and stamps extracted_by from the resolved synthesize ID.
    const synthFile = (id: string) =>
      `# Session ${id} — Title ${id}\n\n## Thread Relevance\n\nBelongs.\n\n## Gaps\n\nNone.\n\n## Decisions\n\n- [${timestamps[id]}] **Choice for ${id}** that wins. (${id} · turn 1)\n`;

    const calls: { role: string; prompt: string; skills: readonly string[] }[] = [];
    const runner: AgentRunner = {
      async run(request) {
        calls.push({ role: request.role, prompt: request.prompt, skills: request.skills });
        const id = /(sess-[ab])/.exec(request.prompt)?.[1] ?? "sess-a";
        const text =
          request.role === "gather"
            ? `DOSSIER-${id}: verbatim transcript material`
            : request.role === "synthesize"
              ? synthFile(id)
              : "# Digest — t\n\n## Current State\nsettled.\n";
        return {
          text,
          rawTrace: "{}\n",
          durationMs: 1,
          usage: {
            cost_usd: 0.01,
            input_tokens: null,
            output_tokens: null,
            reasoning_tokens: null
          },
          rawUsage: null
        };
      }
    };

    await runThreadCreate("t", { root, home, profile: "base", dest: "personal", charter: "C" });
    await runThreadIngest(["claude-code:sess-a", "claude-code:sess-b"], {
      root,
      home,
      profile: "base",
      thread: "t",
      noPush: true,
      synthesize: "claude-code:sonnet@high",
      runner
    });

    const threadDir = path.join(home, ".mindframe-z", "threads", "t");

    // Two-stage split: gather loads the reader skill and sees no contract; the
    // synthesizer loads only the contract, reads the gather dossier, and never
    // touches a session-reader skill (so it cannot see the raw transcript).
    const gathers = calls.filter((c) => c.role === "gather");
    const synths = calls.filter((c) => c.role === "synthesize");
    const digests = calls.filter((c) => c.role === "digest");
    expect(gathers).toHaveLength(2);
    expect(synths).toHaveLength(2);
    for (const gather of gathers) expect(gather.skills).toEqual(["agent-sessions"]);
    for (const synth of synths) {
      expect(synth.skills).toEqual(["thread-contract"]);
      expect(synth.prompt).toContain("DOSSIER-");
      expect(synth.skills).not.toContain("agent-sessions");
    }

    // Parallel fan-out wrote one frontmatter-free session file per id; provenance
    // lives in the manifest ledger, not the file.
    const sessA = await readFile(path.join(threadDir, "sessions", "claude-code-sess-a.md"), "utf8");
    expect(sessA).toContain("Choice for sess-a");
    expect(sessA.startsWith("# Session sess-a")).toBe(true);
    expect(sessA).not.toContain("extracted_by");
    await expect(
      readFile(path.join(threadDir, "sessions", "claude-code-sess-b.md"), "utf8")
    ).resolves.toContain("Choice for sess-b");

    // The ledger carries TS-owned provenance: title lifted from the H1, extracted_by
    // from the dispatch settings (not the agent).
    const manifest = JSON.parse(await readFile(path.join(threadDir, "manifest.json"), "utf8")) as {
      sessions: Array<{ id: string; title?: string; extracted_by?: string; source: string }>;
    };
    const ledgerA = manifest.sessions.find((s) => s.id === "sess-a");
    expect(ledgerA).toMatchObject({
      source: "claude-code",
      title: "Title sess-a",
      extracted_by: "claude-code:sonnet@high"
    });

    // Deterministic log: flat, strictly timestamp-ordered, bold stripped — sess-b
    // (earlier) leads despite sess-a sorting first by filename.
    const log = await readFile(path.join(threadDir, "log.md"), "utf8");
    expect(log).toBe(
      [
        "- [2026-01-01 08:00] decision (sess-b · turn 1): Choice for sess-b that wins.",
        "- [2026-01-02 09:00] decision (sess-a · turn 1): Choice for sess-a that wins."
      ].join("\n")
    );

    // Exactly one digest dispatch, and it reads the full session files (not the log).
    expect(digests).toHaveLength(1);
    expect(digests[0]!.prompt).toContain("# Session sess-a");
    expect(digests[0]!.prompt).toContain("# Session sess-b");

    expect(logs).toContain("ingested\tt\t2 sessions");
  });

  it("regenerate rebuilds views from existing sessions without re-gathering", async () => {
    captureConsole();
    const home = await makeTempDir();
    const root = await makeFixtureRoot();

    const synthFile =
      "# Session sess-a — Title A\n\n## Thread Relevance\n\nBelongs.\n\n## Gaps\n\nNone.\n\n## Decisions\n\n- [2026-01-02 09:00] **Choice A** that wins. (sess-a · turn 1)\n";
    let calls: { role: string; prompt: string }[] = [];
    const runner: AgentRunner = {
      async run(request) {
        calls.push({ role: request.role, prompt: request.prompt });
        const text =
          request.role === "gather"
            ? "DOSSIER: material"
            : request.role === "synthesize"
              ? synthFile
              : "# Digest — t\n\n## Current State\nregenerated body.\n";
        return {
          text,
          rawTrace: "{}\n",
          durationMs: 1,
          usage: {
            cost_usd: 0.02,
            input_tokens: null,
            output_tokens: null,
            reasoning_tokens: null
          },
          rawUsage: null
        };
      }
    };

    await runThreadCreate("t", { root, home, profile: "base", dest: "personal", charter: "C" });
    await runThreadIngest(["claude-code:sess-a"], {
      root,
      home,
      profile: "base",
      thread: "t",
      noPush: true,
      synthesize: "claude-code:sonnet@high",
      runner
    });

    // Discard ingest's dispatches — only the regenerate phase is under test now.
    calls = [];
    await runThreadRegenerate("t", {
      root,
      home,
      profile: "base",
      noPush: true,
      synthesize: "claude-code:sonnet@high",
      runner
    });

    // No re-gather, no re-synthesize: exactly one digest dispatch over the existing
    // session file, proving regeneration re-pays only synthesis of the views.
    expect(calls.map((c) => c.role)).toEqual(["digest"]);
    expect(calls[0]!.prompt).toContain("# Session sess-a");

    const threadDir = path.join(home, ".mindframe-z", "threads", "t");
    await expect(readFile(path.join(threadDir, "digest.md"), "utf8")).resolves.toContain(
      "regenerated body."
    );
    await expect(readFile(path.join(threadDir, "log.md"), "utf8")).resolves.toContain(
      "decision (sess-a · turn 1)"
    );
    expect(logs).toContain("regenerated\tt\t$0.02");
  });

  it("pins synthesis overrides on create and refuses a duplicate", async () => {
    captureConsole();
    const home = await makeTempDir();
    const opts = {
      root: await makeFixtureRoot(),
      home,
      profile: "base",
      dest: "personal",
      charter: "C",
      synthesize: "opencode:opus@high"
    } as const;

    await runThreadCreate("pinned", opts);
    const manifest = JSON.parse(
      await readFile(path.join(home, ".mindframe-z", "threads", "pinned", "manifest.json"), "utf8")
    );
    expect(manifest.synthesis).toMatchObject({
      synthesize: "opencode:opus@high"
    });

    await expect(runThreadCreate("pinned", opts)).rejects.toThrow(/already exists/i);
  });

  it("lists runs across threads with crashed detection and json round-trip", async () => {
    captureConsole();
    const home = await makeTempDir();
    const root = await makeFixtureRoot();
    const paths = createRuntimePaths({ root, home });
    await writeRunStatus(paths, {
      id: "run-live",
      thread: "t1",
      mode: "ingest",
      pid: process.pid,
      current_step: "digest",
      started_at: "2026-01-02T00:00:00Z",
      cost_usd: null
    });
    await writeRunStatus(paths, {
      id: "run-dead",
      thread: "t2",
      mode: "ingest",
      pid: 999_999_999,
      current_step: "gather-synthesize",
      started_at: "2026-01-01T00:00:00Z",
      cost_usd: null
    });

    await runThreadRuns({ root, home, profile: "base", json: true });

    const parsed = JSON.parse(logs[0]!) as {
      runs: Array<{ id: string; thread: string; state: string }>;
    };
    // Cross-thread view, newest-first, derived from run folders alone (no thread read).
    expect(parsed.runs.map((run) => run.id)).toEqual(["run-live", "run-dead"]);
    expect(parsed.runs.find((run) => run.id === "run-live")?.state).toBe("running");
    expect(parsed.runs.find((run) => run.id === "run-dead")?.state).toBe("crashed");
  });

  it("deletes a thread and reports the slug", async () => {
    captureConsole();
    const home = await makeTempDir();
    const root = await makeFixtureRoot();

    await runThreadCreate("to-delete", {
      root,
      home,
      profile: "base",
      dest: "personal",
      charter: "C"
    });
    logs.length = 0;

    await runThreadDelete("to-delete", { root, home, profile: "base", noPush: true });

    expect(logs).toContain("deleted\tto-delete");
  });

  it("rejects path-escaping or malformed slugs and accepts safe ones", async () => {
    captureConsole();
    const home = await makeTempDir();
    const root = await makeFixtureRoot();
    const base = { root, home, profile: "base", dest: "personal", charter: "C" } as const;

    for (const bad of ["../escape", "a/b", ".hidden", "Upper", "x".repeat(65)]) {
      await expect(runThreadCreate(bad, base)).rejects.toThrow();
      await expect(
        runThreadIngest(["claude-code:sess-a"], {
          root,
          home,
          profile: "base",
          thread: bad,
          noPush: true
        })
      ).rejects.toThrow();
      await expect(
        runThreadDelete(bad, { root, home, profile: "base", noPush: true })
      ).rejects.toThrow();
    }

    // Dots, underscores, and hyphens inside a lowercase-alnum-led slug are allowed.
    await runThreadCreate("a.b_c-1", base);
    expect(logs).toContain("created\ta.b_c-1\tpersonal");
  });

  it("syncs with no remote skips silently", async () => {
    captureConsole();
    const home = await makeTempDir();
    const root = await makeFixtureRoot();

    await runThreadCreate("sync-me", {
      root,
      home,
      profile: "base",
      dest: "personal",
      charter: "C"
    });
    logs.length = 0;

    await runThreadSync({ root, home, profile: "base", all: true });

    expect(logs).toContain("sync\tpersonal\tup to date");
  });
});

describe("thread observe lifecycle", () => {
  async function withFakeDocker<T>(
    body: (paths: ReturnType<typeof createRuntimePaths>, stateDir: string) => Promise<T>
  ): Promise<T> {
    const home = await makeTempDir();
    const root = await makeFixtureRoot();
    const stateDir = await writeFakeDocker(home);
    process.env.PATH = `${path.join(home, "bin")}:${oldPath ?? ""}`;
    const paths = createRuntimePaths({ root, home });
    return body(paths, stateDir);
  }

  it("starts the lapdog container and reports the dashboard URL on a cold start", async () => {
    captureConsole();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    );
    await withFakeDocker(async (paths) => {
      await runThreadObserveUp({ root: paths.root, home: paths.home, profile: "base" });
      expect(logs).toContain("lapdog\tstarted");
      expect(logs).toContain("dashboard\thttp://localhost:8080");
    });
  });

  it("reports 'already_running' on a second up when the container is present", async () => {
    captureConsole();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    );
    await withFakeDocker(async (paths) => {
      await runThreadObserveUp({ root: paths.root, home: paths.home, profile: "base" });
      logs.length = 0;
      await runThreadObserveUp({ root: paths.root, home: paths.home, profile: "base" });
      expect(logs).toContain("lapdog\talready_running");
    });
  });

  it("down is idempotent and tolerates a missing container", async () => {
    captureConsole();
    await withFakeDocker(async (paths) => {
      await expect(
        runThreadObserveDown({ root: paths.root, home: paths.home, profile: "base" })
      ).resolves.toBeUndefined();
      expect(logs).toContain("lapdog\tstopped");
    });
  });

  it("status reports reachable=false and the dashboard URL when /info refuses", async () => {
    captureConsole();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await withFakeDocker(async (paths) => {
      await runThreadObserveStatus({ root: paths.root, home: paths.home, profile: "base" });
      expect(logs).toContain("reachable\tfalse");
      expect(logs).toContain("dashboard\thttp://localhost:8080");
    });
  });

  it("status emits JSON when --json is passed", async () => {
    captureConsole();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await withFakeDocker(async (paths) => {
      await runThreadObserveStatus({
        root: paths.root,
        home: paths.home,
        profile: "base",
        json: true
      });
      const parsed = JSON.parse(logs[0]!) as { reachable: boolean; dashboardUrl: string };
      expect(parsed.reachable).toBe(false);
      expect(parsed.dashboardUrl).toBe("http://localhost:8080");
    });
  });
});
