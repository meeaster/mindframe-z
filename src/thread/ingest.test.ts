import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimePaths } from "../core/paths.js";
import { archiveCacheRoot, threadPath } from "../core/paths.js";
import type { Archive, MachineManifest } from "../core/manifests.js";
import type { ResolvedProfile } from "../core/profile.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  prepareThreadDestination,
  readThreadRuns,
  resolveThreadDestinations,
  writeSessionFile,
  writeThreadManifest
} from "./storage.js";
import { ingestThread, resolveRefreshSet } from "./ingest.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "./runner.js";
import type { ThreadManifest } from "./schema.js";
import type { hydrateSession } from "../sessions/hydrate.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    configsDir: path.join(home, "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

function machine(): MachineManifest {
  return {
    references_dir: "~/references",
    extra_folders: [],
    git: {},
    sandbox: {},
    thread: { destinations: [] },
    archives: [],
    opencode: {}
  };
}

function profile(): ResolvedProfile {
  return {
    name: "personal",
    agents: ["claude-code"],
    profile: {
      name: "personal",
      description: "Test profile",
      agents: ["claude-code"],
      instructions: [],
      references: [],
      skills: {},
      mcp: {},
      opencode: { config: {}, plugins: [], commands: [], agents: [] },
      claude: { settings: {} },
      mise: { tools: {}, env: {}, tool_alias: {}, settings: {} },
      thread: {
        destinations: [{ name: "personal", default: true, no_push: false }],
        defaults: {
          synthesize: "claude-code:sonnet@high",
          gather: "claude-code:haiku@low",
          discover: "claude-code:sonnet@high",
          session_sources: ["claude-code"]
        },
        credentials: "subscription"
      },
      dotfiles: {},
      extra_folders: []
    },
    manifests: {
      references: [],
      skills: [],
      mcpServers: {},
      profiles: new Map(),
      machine: machine()
    },
    instructionFiles: [],
    referencesDir: "/tmp/references",
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    mcpServers: [],
    extraFolders: []
  };
}

// A runner whose every dispatch returns an empty result, standing in for a gather
// that never read the session (e.g. a denied read it failed to recover from).
class EmptyDossierRunner implements AgentRunner {
  run(): Promise<AgentRunResult> {
    return Promise.resolve({
      text: "   \n",
      rawTrace: "",
      durationMs: 0,
      usage: {
        cost_usd: null,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: null
      }
    });
  }
}

// Gather returns a non-empty "session does not exist" refusal — the wrong-store read
// the guard must catch before synthesis (which would otherwise write a fabricated file).
class MissingSessionRunner implements AgentRunner {
  readonly calls: { role: string }[] = [];
  run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push({ role: request.role });
    const text =
      request.role === "gather"
        ? "The target session does not exist in the local store."
        : "# Session x — should not be reached\n\nbody";
    return Promise.resolve({
      text,
      rawTrace: "",
      durationMs: 0,
      usage: { cost_usd: null, input_tokens: 0, output_tokens: 0, reasoning_tokens: null }
    });
  }
  rolesNamed(role: string): number {
    return this.calls.filter((call) => call.role === role).length;
  }
}

// Records every dispatch and returns plausible, non-empty output per role so a full
// ingest runs to completion. Gather returns a dossier; synthesize returns a titled
// session file; digest returns digest text.
class RecordingRunner implements AgentRunner {
  readonly calls: { role: string; prompt: string }[] = [];
  run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push({ role: request.role, prompt: request.prompt });
    const text =
      request.role === "synthesize"
        ? "# Session x — Recorded\n\nbody"
        : request.role === "gather"
          ? "dossier content"
          : "digest content";
    return Promise.resolve({
      text,
      rawTrace: "",
      durationMs: 0,
      usage: { cost_usd: null, input_tokens: 0, output_tokens: 0, reasoning_tokens: null }
    });
  }

  rolesNamed(role: string): number {
    return this.calls.filter((call) => call.role === role).length;
  }
}

// Write a claude transcript of `turns` message lines under the temp home so the
// watermark reader sees a known tail signature. Returns that signature.
async function writeClaudeTranscript(
  home: string,
  id: string,
  turns: number
): Promise<{ message_count: number; last_message_id: string; last_activity_at: string }> {
  const dir = path.join(home, ".claude", "projects", "-tmp-project");
  await mkdir(dir, { recursive: true });
  const lines = Array.from({ length: turns }, (_, i) => ({
    type: i % 2 === 0 ? "user" : "assistant",
    uuid: `${id}-m${i}`,
    timestamp: `2026-06-27T00:00:${String(i).padStart(2, "0")}.000Z`,
    sessionId: id
  }));
  await writeFile(
    path.join(dir, `${id}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8"
  );
  const last = lines[lines.length - 1]!;
  return { message_count: turns, last_message_id: last.uuid, last_activity_at: last.timestamp };
}

// Simulate a hydrated cache copy directly (bypassing hydrateSession/S3), so
// resolveRefreshSet's re-classification-after-hydration logic can be tested without
// a real archive.
async function writeCachedClaudeTranscript(home: string, id: string, turns: number): Promise<void> {
  const dir = path.join(archiveCacheRoot(paths(home)), "claude-code");
  await mkdir(dir, { recursive: true });
  const lines = Array.from({ length: turns }, (_, i) => ({
    type: i % 2 === 0 ? "user" : "assistant",
    uuid: `${id}-m${i}`,
    timestamp: `2026-06-27T00:00:${String(i).padStart(2, "0")}.000Z`,
    sessionId: id
  }));
  await writeFile(
    path.join(dir, `${id}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8"
  );
}

function manifestFixture(sessions: ThreadManifest["sessions"]): ThreadManifest {
  return {
    slug: "hydrate-test",
    charter: "test",
    destination: "personal",
    created_at: "2026-06-27T00:00:00.000Z",
    sessions,
    synthesis: {}
  };
}

const oneArchive: Archive[] = [
  { name: "default", bucket: "test-bucket", region: "us-east-1", prefix: "", default: true }
];

describe("resolveRefreshSet hydration", () => {
  it("does not consult the archive for a shrank-but-present session", async () => {
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "shrank-session", 1);
    const manifest = manifestFixture([
      { id: "shrank-session", source: "claude-code", message_count: 3, last_message_id: "old" }
    ]);
    let hydrateCalled = false;
    const spyHydrate: typeof hydrateSession = async () => {
      hydrateCalled = true;
      return true;
    };

    const result = await resolveRefreshSet(paths(home), manifest, [], oneArchive, spyHydrate);

    expect(hydrateCalled).toBe(false);
    expect(result.vanished).toEqual(["claude-code:shrank-session"]);
    expect(result.refreshed).toEqual([]);
  });

  it("recoverable: a hydrated session with a newer tail than the cursor is folded into refreshed", async () => {
    const home = await makeTempDir();
    const manifest = manifestFixture([
      { id: "recoverable", source: "claude-code", message_count: 1, last_message_id: "old" }
    ]);
    const spyHydrate: typeof hydrateSession = async (p) => {
      await writeCachedClaudeTranscript(p.home, "recoverable", 3);
      return true;
    };

    const result = await resolveRefreshSet(paths(home), manifest, [], oneArchive, spyHydrate);

    expect(result.refreshed).toEqual(["claude-code:recoverable"]);
    expect(result.vanished).toEqual([]);
  });

  it("stale-recover: a hydrated session whose archived tail predates the cursor stays vanished", async () => {
    const home = await makeTempDir();
    const manifest = manifestFixture([
      { id: "stale", source: "claude-code", message_count: 5, last_message_id: "old" }
    ]);
    const spyHydrate: typeof hydrateSession = async (p) => {
      // The archive's last backup predates the ledger cursor — fewer messages than stored.
      await writeCachedClaudeTranscript(p.home, "stale", 2);
      return true;
    };

    const result = await resolveRefreshSet(paths(home), manifest, [], oneArchive, spyHydrate);

    expect(result.vanished).toEqual(["claude-code:stale"]);
    expect(result.refreshed).toEqual([]);
  });

  it("unrecoverable: no archive holds the session, so it stays vanished with no error", async () => {
    const home = await makeTempDir();
    const manifest = manifestFixture([
      { id: "lost", source: "claude-code", message_count: 3, last_message_id: "old" }
    ]);
    const spyHydrate: typeof hydrateSession = async () => false;

    const result = await resolveRefreshSet(paths(home), manifest, [], oneArchive, spyHydrate);

    expect(result.vanished).toEqual(["claude-code:lost"]);
    expect(result.refreshed).toEqual([]);
  });

  it("skips the hydration attempt entirely when no archives are configured", async () => {
    const home = await makeTempDir();
    const manifest = manifestFixture([
      { id: "lost", source: "claude-code", message_count: 3, last_message_id: "old" }
    ]);
    let hydrateCalled = false;
    const spyHydrate: typeof hydrateSession = async () => {
      hydrateCalled = true;
      return true;
    };

    const result = await resolveRefreshSet(paths(home), manifest, [], [], spyHydrate);

    expect(hydrateCalled).toBe(false);
    expect(result.vanished).toEqual(["claude-code:lost"]);
  });
});

async function ingestFixture(
  home: string,
  sessions: {
    id: string;
    source: "claude-code";
    message_count?: number;
    last_message_id?: string;
  }[]
): Promise<{ runtime: RuntimePaths; slug: string }> {
  const runtime = paths(home);
  const slug = "thread-refresh";
  const [destination] = resolveThreadDestinations(runtime, profile());
  await prepareThreadDestination(runtime, destination!);
  await writeThreadManifest(threadPath(runtime, slug), {
    slug,
    charter: "Keep sessions fresh.",
    destination: "personal",
    created_at: "2026-06-27T00:00:00.000Z",
    sessions: sessions.map((s) => ({
      id: s.id,
      source: s.source,
      ...(s.message_count !== undefined ? { message_count: s.message_count } : {}),
      ...(s.last_message_id !== undefined ? { last_message_id: s.last_message_id } : {})
    })),
    synthesis: {}
  });
  return { runtime, slug };
}

// Session ids recorded on the run's ledger — i.e. the resolved refresh work set.
async function refreshedSessions(runtime: RuntimePaths, slug: string): Promise<string[]> {
  const runs = await readThreadRuns(threadPath(runtime, slug));
  return runs.runs.at(-1)!.sessions;
}

describe("ingestThread auto-refresh", () => {
  it("skips an unchanged existing session and refreshes only the named id", async () => {
    const home = await makeTempDir();
    const wm = await writeClaudeTranscript(home, "unchanged-session", 3);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "unchanged-session", source: "claude-code", ...wm }
    ]);
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: profile(),
      threadSlug: slug,
      sessionIds: ["claude-code:named-session"],
      noPush: true,
      runner
    });

    expect(await refreshedSessions(runtime, slug)).toEqual(["claude-code:named-session"]);
    expect(runner.rolesNamed("gather")).toBe(1);
    expect(runner.rolesNamed("digest")).toBe(1);
  });

  it("refreshes a grown existing session alongside a named id, digesting once", async () => {
    const home = await makeTempDir();
    // Stored watermark is 3 turns; the store now has 5 → grown.
    await writeClaudeTranscript(home, "grown-session", 5);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "grown-session", source: "claude-code", message_count: 3, last_message_id: "old" }
    ]);
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: profile(),
      threadSlug: slug,
      sessionIds: ["claude-code:named-session"],
      noPush: true,
      runner
    });

    expect(new Set(await refreshedSessions(runtime, slug))).toEqual(
      new Set(["claude-code:named-session", "claude-code:grown-session"])
    );
    expect(runner.rolesNamed("gather")).toBe(2);
    expect(runner.rolesNamed("digest")).toBe(1);
  });

  it("refreshes a changed session when no ids are named, digesting once", async () => {
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "grown-session", 5);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "grown-session", source: "claude-code", message_count: 3, last_message_id: "old" }
    ]);
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: profile(),
      threadSlug: slug,
      sessionIds: [],
      refresh: true,
      noPush: true,
      runner
    });

    expect(await refreshedSessions(runtime, slug)).toEqual(["claude-code:grown-session"]);
    expect(runner.rolesNamed("gather")).toBe(1);
    expect(runner.rolesNamed("digest")).toBe(1);
  });

  it("leaves a vanished/shrank session untouched", async () => {
    const home = await makeTempDir();
    // Store has only 1 turn but the stored watermark claims 3 → shrank.
    await writeClaudeTranscript(home, "shrank-session", 1);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "shrank-session", source: "claude-code", message_count: 3, last_message_id: "old" }
    ]);
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: profile(),
      threadSlug: slug,
      sessionIds: ["claude-code:named-session"],
      noPush: true,
      runner
    });

    expect(await refreshedSessions(runtime, slug)).toEqual(["claude-code:named-session"]);
    expect(runner.rolesNamed("gather")).toBe(1);
    expect(runner.rolesNamed("digest")).toBe(1);
  });

  it("is a no-op success when a refresh finds nothing drifted", async () => {
    const home = await makeTempDir();
    const wm = await writeClaudeTranscript(home, "unchanged-session", 3);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "unchanged-session", source: "claude-code", ...wm }
    ]);
    const runner = new RecordingRunner();

    const result = await ingestThread({
      paths: runtime,
      profile: profile(),
      threadSlug: slug,
      sessionIds: [],
      refresh: true,
      noPush: true,
      runner
    });

    expect(result.sessionCount).toBe(0);
    expect(runner.rolesNamed("gather")).toBe(0);
    expect(runner.rolesNamed("digest")).toBe(0);
  });

  it("throws when a plain ingest names no session", async () => {
    const home = await makeTempDir();
    const { runtime, slug } = await ingestFixture(home, []);

    await expect(
      ingestThread({
        paths: runtime,
        profile: profile(),
        threadSlug: slug,
        sessionIds: [],
        noPush: true,
        runner: new RecordingRunner()
      })
    ).rejects.toThrow(/at least one session id/);
  });

  it("--all forces a full re-synthesis of every present session, skipping vanished", async () => {
    const home = await makeTempDir();
    // One unchanged session (would be skipped by a plain refresh) and one that vanished
    // from the store. --all must re-gather the present one and skip the vanished one.
    const wm = await writeClaudeTranscript(home, "steady-session", 3);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "steady-session", source: "claude-code", ...wm },
      { id: "gone-session", source: "claude-code", message_count: 3, last_message_id: "old" }
    ]);
    await writeSessionFile(threadPath(runtime, slug), "claude-code", "steady-session", "# prior");
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: withStrategy(profile(), "delta"),
      threadSlug: slug,
      sessionIds: [],
      refresh: true,
      all: true,
      noPush: true,
      runner
    });

    // The present session is re-gathered in full despite being unchanged and delta being
    // configured; the vanished one is left out of the work set.
    expect(await refreshedSessions(runtime, slug)).toEqual(["claude-code:steady-session"]);
    const gather = runner.calls.find((c) => c.role === "gather")!;
    const synth = runner.calls.find((c) => c.role === "synthesize")!;
    expect(gather.prompt).toBe(
      "Read session steady-session. Its transcript is the file /mnt/claude-sessions/projects/-tmp-project/steady-session.jsonl. Charter: Keep sessions fresh."
    );
    expect(synth.prompt).not.toContain("Revise the existing");
    expect(runner.rolesNamed("digest")).toBe(1);
  });
});

function withStrategy(p: ResolvedProfile, strategy: "full" | "delta"): ResolvedProfile {
  return {
    ...p,
    profile: { ...p.profile, thread: { ...p.profile.thread, update_strategy: strategy } }
  };
}

describe("ingestThread update strategy", () => {
  it("defaults to full re-synthesis: reads the whole session, no revise prompt", async () => {
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "grown-session", 5);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "grown-session", source: "claude-code", message_count: 3, last_message_id: "old" }
    ]);
    await writeSessionFile(threadPath(runtime, slug), "claude-code", "grown-session", "# prior");
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: profile(), // default update_strategy: "full"
      threadSlug: slug,
      sessionIds: [],
      refresh: true,
      noPush: true,
      runner
    });

    const gather = runner.calls.find((c) => c.role === "gather")!;
    const synth = runner.calls.find((c) => c.role === "synthesize")!;
    expect(gather.prompt).toBe(
      "Read session grown-session. Its transcript is the file /mnt/claude-sessions/projects/-tmp-project/grown-session.jsonl. Charter: Keep sessions fresh."
    );
    expect(synth.prompt).not.toContain("Revise the existing");
    expect(synth.prompt).toContain("Dossier (your only source)");
  });

  it("delta reads only messages after the cursor and revises the prior file", async () => {
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "grown-session", 5);
    const { runtime, slug } = await ingestFixture(home, [
      {
        id: "grown-session",
        source: "claude-code",
        message_count: 3,
        last_message_id: "old-cursor"
      }
    ]);
    await writeSessionFile(
      threadPath(runtime, slug),
      "claude-code",
      "grown-session",
      "# Session grown-session — Prior"
    );
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: withStrategy(profile(), "delta"),
      threadSlug: slug,
      sessionIds: [],
      refresh: true,
      noPush: true,
      runner
    });

    const gather = runner.calls.find((c) => c.role === "gather")!;
    const synth = runner.calls.find((c) => c.role === "synthesize")!;
    expect(gather.prompt).toContain("only the messages after message id old-cursor");
    expect(synth.prompt).toContain("Revise the existing session summary");
    expect(synth.prompt).toContain("# Session grown-session — Prior");
  });

  it("delta falls back to full for a named session with no prior watermark", async () => {
    const home = await makeTempDir();
    const { runtime, slug } = await ingestFixture(home, []);
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: withStrategy(profile(), "delta"),
      threadSlug: slug,
      sessionIds: ["claude-code:fresh-session"],
      noPush: true,
      runner
    });

    const gather = runner.calls.find((c) => c.role === "gather")!;
    expect(gather.prompt).toBe("Read session fresh-session. Charter: Keep sessions fresh.");
  });

  it("delta falls back to full for a named session that has not changed", async () => {
    const home = await makeTempDir();
    // Stored watermark equals the store, so the session is unchanged. Naming it under
    // delta must NOT read "only messages after the cursor" (there are none) — that would
    // gather an empty dossier and abort. It re-synthesizes the whole session instead.
    const wm = await writeClaudeTranscript(home, "steady-session", 3);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "steady-session", source: "claude-code", ...wm }
    ]);
    await writeSessionFile(threadPath(runtime, slug), "claude-code", "steady-session", "# prior");
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: withStrategy(profile(), "delta"),
      threadSlug: slug,
      sessionIds: ["claude-code:steady-session"],
      noPush: true,
      runner
    });

    const gather = runner.calls.find((c) => c.role === "gather")!;
    const synth = runner.calls.find((c) => c.role === "synthesize")!;
    expect(gather.prompt).toBe(
      "Read session steady-session. Its transcript is the file /mnt/claude-sessions/projects/-tmp-project/steady-session.jsonl. Charter: Keep sessions fresh."
    );
    expect(synth.prompt).not.toContain("Revise the existing");
  });
});

describe("ingestThread digest anchoring", () => {
  it("anchors the digest prompt on the prior digest when one exists", async () => {
    const home = await makeTempDir();
    const wm = await writeClaudeTranscript(home, "steady-session", 3);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "steady-session", source: "claude-code", ...wm }
    ]);
    await writeFile(
      path.join(threadPath(runtime, slug), "digest.md"),
      "# Digest — prior rendering\n",
      "utf8"
    );
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: profile(),
      threadSlug: slug,
      sessionIds: ["claude-code:steady-session"],
      noPush: true,
      runner
    });

    const digest = runner.calls.find((c) => c.role === "digest")!;
    expect(digest.prompt).toContain("Previous digest");
    expect(digest.prompt).toContain("# Digest — prior rendering");
  });

  it("hands the digest a repo lookup so reference and extra-folder paths resolve to URLs", async () => {
    const home = await makeTempDir();
    const wm = await writeClaudeTranscript(home, "steady-session", 3);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "steady-session", source: "claude-code", ...wm }
    ]);
    const withRepos: ResolvedProfile = {
      ...profile(),
      referencesDir: "/home/mark/references",
      enabledReferences: [
        { name: "opencode", url: "https://github.com/sst/opencode", description: "" }
      ],
      extraFolders: [
        {
          path: "/home/mark/work/ps-watchtower",
          url: "https://github.example.com/ps-watchtower",
          description: "",
          read: "allow",
          edit: "allow"
        },
        // no url → skipped
        { path: "/mnt/c/vaults/wiki", description: "", read: "allow", edit: "allow" }
      ]
    };
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: withRepos,
      threadSlug: slug,
      sessionIds: ["claude-code:steady-session"],
      noPush: true,
      runner
    });

    const digest = runner.calls.find((c) => c.role === "digest")!;
    expect(digest.prompt).toContain("Local repos");
    // A session may cite a repo by name or a differently-mounted path, so the lookup
    // resolves on either — not the host path alone.
    expect(digest.prompt).toContain("cited by its name or by any path ending in that name");
    expect(digest.prompt).toContain(
      "opencode — /home/mark/references/opencode → https://github.com/sst/opencode"
    );
    expect(digest.prompt).toContain(
      "ps-watchtower — /home/mark/work/ps-watchtower → https://github.example.com/ps-watchtower"
    );
    expect(digest.prompt).not.toContain("wiki");
  });

  it("withholds the prior digest under --all so form drift flushes", async () => {
    const home = await makeTempDir();
    const wm = await writeClaudeTranscript(home, "steady-session", 3);
    const { runtime, slug } = await ingestFixture(home, [
      { id: "steady-session", source: "claude-code", ...wm }
    ]);
    await writeFile(
      path.join(threadPath(runtime, slug), "digest.md"),
      "# Digest — prior rendering\n",
      "utf8"
    );
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: profile(),
      threadSlug: slug,
      sessionIds: [],
      refresh: true,
      all: true,
      noPush: true,
      runner
    });

    const digest = runner.calls.find((c) => c.role === "digest")!;
    expect(digest.prompt).not.toContain("Previous digest");
  });
});

describe("ingestThread", () => {
  it("aborts before synthesis when a gather yields an empty dossier", async () => {
    const home = await makeTempDir();
    const runtime = paths(home);
    const slug = "thread-empty";
    await writeThreadManifest(threadPath(runtime, slug), {
      slug,
      charter: "Design of per-session watermarks — deterministic TS-computed watermark.",
      destination: "personal",
      created_at: "2026-06-27T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    });

    await expect(
      ingestThread({
        paths: runtime,
        profile: profile(),
        threadSlug: slug,
        sessionIds: ["claude-code:a712ce9c-589a-46fc-b10f-e72c193e165c"],
        noPush: true,
        runner: new EmptyDossierRunner()
      })
    ).rejects.toThrow(/empty dossier/);
  });

  it("hands gather the exact transcript path when the session exists host-side", async () => {
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "here-session", 3);
    const { runtime, slug } = await ingestFixture(home, []);
    const runner = new RecordingRunner();

    await ingestThread({
      paths: runtime,
      profile: profile(),
      threadSlug: slug,
      sessionIds: ["claude-code:here-session"],
      noPush: true,
      runner
    });

    const gather = runner.calls.find((c) => c.role === "gather")!;
    expect(gather.prompt).toContain(
      "/mnt/claude-sessions/projects/-tmp-project/here-session.jsonl"
    );
  });

  it("aborts when gather reports a session missing though its transcript exists", async () => {
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "real-session", 3);
    const { runtime, slug } = await ingestFixture(home, []);
    const runner = new MissingSessionRunner();

    await expect(
      ingestThread({
        paths: runtime,
        profile: profile(),
        threadSlug: slug,
        sessionIds: ["claude-code:real-session"],
        noPush: true,
        runner
      })
    ).rejects.toThrow(/read the wrong store/);
    expect(runner.rolesNamed("synthesize")).toBe(0);
  });

  it("rejects an unqualified session id before dispatching", async () => {
    const home = await makeTempDir();
    const { runtime, slug } = await ingestFixture(home, []);
    const runner = new RecordingRunner();

    await expect(
      ingestThread({
        paths: runtime,
        profile: profile(),
        threadSlug: slug,
        sessionIds: ["a712ce9c-589a-46fc-b10f-e72c193e165c"],
        noPush: true,
        runner
      })
    ).rejects.toThrow(/source-qualified/);
    expect(runner.rolesNamed("gather")).toBe(0);
  });
});
