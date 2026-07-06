import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  createRuntimePaths,
  threadPath,
  threadStoreRoot,
  pathExists,
  type PathOptions
} from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import { threadIdentifierSchema } from "../core/manifests.js";
import { THREAD_PERSONAS } from "./personas.js";
import { DockerAgentRunner, type AgentRunner } from "./runner.js";
import { dispatch } from "./dispatch.js";
import { ingestThread } from "./ingest.js";
import { regenerateThread } from "./regenerate.js";
import { concludePending, listPending, rejectPending, runSweep } from "./sweep.js";
import {
  lapdogDashboardUrl,
  lapdogStatus,
  startLapdogContainer,
  stopLapdogContainer,
  waitForLapdog
} from "./lapdog.js";
import {
  defaultThreadDestination,
  deleteThreadFromDestination,
  findThread,
  findThreadDestination,
  prepareThreadDestination,
  readThreadManifest,
  readThreadRuns,
  resolveSynthesisDefaults,
  resolveSessionSources,
  resolveThreadDestinations,
  syncThreadDestination,
  writeThreadManifest,
  writeThreadRuns,
  type ThreadManifest
} from "./storage.js";
import {
  appendThreadCliLog,
  listRunStatuses,
  readRunTrace,
  writeRunStatus
} from "./observability.js";

interface ThreadOptions extends PathOptions {
  profile?: string | undefined;
}

// Slugs come from argv and flow into `path.join` → `cp`/`rm`/`git`, so bound them
// to a safe identifier before they can escape the thread store root.
function assertThreadSlug(slug: string): string {
  return threadIdentifierSchema.parse(slug);
}

export async function runThreadDestinations(
  options: ThreadOptions & { json?: boolean }
): Promise<void> {
  await withThreadLog(options, "thread destinations", async ({ paths, profile }) => {
    const destinations = resolveThreadDestinations(paths, profile);
    if (options.json) console.log(JSON.stringify({ destinations }, null, 2));
    else
      for (const destination of destinations)
        console.log(
          `${destination.default ? "*" : " "} ${destination.name}\t${destination.remote ?? "-"}${destination.no_push ? "\tno_push" : ""}`
        );
  });
}

export async function runThreadCreate(
  slug: string,
  options: ThreadOptions & {
    dest?: string | undefined;
    charter: string;
    discover?: string | undefined;
    gather?: string | undefined;
    synthesize?: string | undefined;
  }
): Promise<void> {
  await withThreadLog(options, `thread create ${slug}`, async ({ paths, profile }) => {
    assertThreadSlug(slug);
    const destinations = resolveThreadDestinations(paths, profile);
    const destination = options.dest
      ? findThreadDestination(destinations, options.dest)
      : defaultThreadDestination(destinations);
    if (!destination) throw new Error("No thread destinations configured");
    await prepareThreadDestination(paths, destination);
    const dir = threadPath(paths, slug);
    if (await pathExists(path.join(dir, "manifest.json")))
      throw new Error(`Thread already exists: ${slug}`);
    const manifest: ThreadManifest = {
      slug,
      charter: options.charter,
      destination: destination.name,
      created_at: new Date().toISOString(),
      sessions: [],
      synthesis: {
        ...(options.discover ? { discover: options.discover } : {}),
        ...(options.gather ? { gather: options.gather } : {}),
        ...(options.synthesize ? { synthesize: options.synthesize } : {})
      }
    };
    await writeThreadManifest(dir, manifest);
    await writeThreadRuns(dir, { runs: [] });
    console.log(`created\t${slug}\t${destination.name}`);
  });
}

export async function runThreadList(options: ThreadOptions & { json?: boolean }): Promise<void> {
  await withThreadLog(options, "thread list", async ({ paths }) => {
    const threads = await listThreads(paths);
    if (options.json) console.log(JSON.stringify({ threads }, null, 2));
    else
      for (const thread of threads)
        console.log(`${thread.slug}\t${thread.destination}\t${thread.session_count} sessions`);
  });
}

export async function runThreadShow(slug: string, options: ThreadOptions): Promise<void> {
  await withThreadLog(options, `thread show ${slug}`, async ({ paths, profile }) => {
    assertThreadSlug(slug);
    const thread = await findThread(paths, profile, slug);
    console.log(await readFile(path.join(thread.dir, "digest.md"), "utf8"));
  });
}

export async function runThreadDiscover(
  prompt: string,
  options: ThreadOptions & {
    json?: boolean | undefined;
    discover?: string | undefined;
    sources?: readonly string[] | undefined;
    runner?: AgentRunner | undefined;
  }
): Promise<void> {
  await withThreadLog(options, "thread discover", async ({ paths, profile }) => {
    const settings = resolveSynthesisDefaults(profile.profile.thread.defaults, emptyManifest(), {
      discover: options.discover
    });
    const { harness, model, effort } = settings.discover;
    const sessionSources = resolveSessionSources(profile.profile.thread.defaults, options.sources);
    const runner =
      options.runner ?? new DockerAgentRunner(paths, profile.profile.thread.credentials);
    const runId = `run-${Date.now()}`;
    const startedAt = new Date().toISOString();
    await writeRunStatus(paths, {
      id: runId,
      mode: "discover",
      pid: process.pid,
      current_step: "discover",
      started_at: startedAt,
      cost_usd: null
    });
    const { result } = await dispatch(runner, paths, runId, "discover", {
      role: "discover",
      harness,
      model,
      effort,
      persona: THREAD_PERSONAS.discover,
      skills: ["agent-sessions"],
      sessionSources,
      prompt: `Sessions to search: ${sessionSources.join(", ")}.\n\n${prompt}`
    });
    await writeRunStatus(paths, {
      id: runId,
      mode: "discover",
      pid: process.pid,
      current_step: "complete",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      cost_usd: result.usage.cost_usd
    });
    if (options.json) console.log(JSON.stringify({ candidates_text: result.text }, null, 2));
    else console.log(result.text);
  });
}

export async function runThreadIngest(
  ids: string[],
  options: ThreadOptions & {
    thread: string;
    noPush?: boolean | undefined;
    gather?: string | undefined;
    synthesize?: string | undefined;
    runner?: AgentRunner | undefined;
  }
): Promise<void> {
  await withThreadLog(options, `thread ingest ${options.thread}`, async ({ paths, profile }) => {
    const result = await ingestThread({
      paths,
      profile,
      threadSlug: assertThreadSlug(options.thread),
      sessionIds: ids,
      noPush: Boolean(options.noPush),
      gather: options.gather,
      synthesize: options.synthesize,
      runner: options.runner
    });
    if (result.refreshed.length > 0)
      console.log(`refresh (changed):\t${result.refreshed.join("\t")}`);
    if (result.vanished.length > 0)
      console.log(`skip (vanished/shrank):\t${result.vanished.join("\t")}`);
    console.log(`ingested\t${result.slug}\t${result.sessionCount} sessions`);
  });
}

export async function runThreadRefresh(
  options: ThreadOptions & {
    thread: string;
    all?: boolean | undefined;
    noPush?: boolean | undefined;
    gather?: string | undefined;
    synthesize?: string | undefined;
    runner?: AgentRunner | undefined;
  }
): Promise<void> {
  await withThreadLog(options, `thread refresh ${options.thread}`, async ({ paths, profile }) => {
    const result = await ingestThread({
      paths,
      profile,
      threadSlug: assertThreadSlug(options.thread),
      sessionIds: [],
      refresh: true,
      all: Boolean(options.all),
      noPush: Boolean(options.noPush),
      gather: options.gather,
      synthesize: options.synthesize,
      runner: options.runner
    });
    if (result.vanished.length > 0)
      console.log(`skip (vanished/shrank):\t${result.vanished.join("\t")}`);
    if (result.sessionCount === 0) {
      console.log(`up to date\t${result.slug}\tnothing drifted`);
      return;
    }
    console.log(`refreshed\t${result.slug}\t${result.sessionCount} sessions`);
  });
}

export async function runThreadSweep(
  options: ThreadOptions & {
    includeHot?: boolean | undefined;
    triageModel?: string | undefined;
    json?: boolean | undefined;
    runner?: AgentRunner | undefined;
  }
): Promise<void> {
  await withThreadLog(options, "thread sweep", async ({ paths, profile }) => {
    const report = await runSweep({
      paths,
      profile,
      includeHot: Boolean(options.includeHot),
      triageModel: options.triageModel,
      runner: options.runner
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (report.baseline_staked) console.log(`baseline staked\t${report.baseline_at}`);
    console.log(`sessions since last sweep\t${report.counts_since_last_sweep.sessions}`);
    console.log(`triage dispatches\t${report.triage_dispatches}`);
    console.log(`pending proposals\t${report.proposals.length}\tmfz thread pending`);
    for (const drift of groupByThread(report.drifted))
      console.log(
        `${drift.thread}\t${drift.count} members drifted\tmfz thread refresh --thread ${drift.thread}`
      );
    for (const item of report.deferred) console.log(`deferred\t${item.id}\t${item.reason}`);
    for (const item of report.malformed) console.log(`malformed\t${item.id}\t${item.line}`);
  });
}

export async function runThreadPending(
  options: ThreadOptions & { json?: boolean | undefined }
): Promise<void> {
  await withThreadLog(options, "thread pending", async ({ paths }) => {
    const proposals = await listPending(paths);
    if (options.json) {
      console.log(JSON.stringify({ proposals }, null, 2));
      return;
    }
    for (const proposal of proposals)
      console.log(
        `${proposal.stale ? "stale" : "pending"}\t${proposal.id}\t${proposal.thread}\t${proposal.reason}`
      );
  });
}

export async function runThreadReject(
  id: string,
  options: ThreadOptions & { thread: string }
): Promise<void> {
  await withThreadLog(options, `thread reject ${id}`, async ({ paths }) => {
    await rejectPending(paths, id, assertThreadSlug(options.thread));
    console.log(`rejected\t${id}\t${options.thread}`);
  });
}

export async function runThreadConclude(options: ThreadOptions): Promise<void> {
  await withThreadLog(options, "thread conclude", async ({ paths }) => {
    const count = await concludePending(paths);
    console.log(`concluded\t${count} passed`);
  });
}

export async function runThreadRegenerate(
  slug: string,
  options: ThreadOptions & {
    noPush?: boolean | undefined;
    synthesize?: string | undefined;
    runner?: AgentRunner | undefined;
  }
): Promise<void> {
  await withThreadLog(options, `thread regenerate ${slug}`, async ({ paths, profile }) => {
    const result = await regenerateThread({
      paths,
      profile,
      threadSlug: assertThreadSlug(slug),
      noPush: Boolean(options.noPush),
      synthesize: options.synthesize,
      runner: options.runner
    });
    console.log(`regenerated\t${result.slug}\t$${result.totalCostUsd ?? "?"}`);
  });
}

export async function runThreadRuns(
  options: ThreadOptions & {
    thread?: string | undefined;
    runId?: string | undefined;
    trace?: boolean;
    json?: boolean;
  }
): Promise<void> {
  await withThreadLog(options, "thread runs", async ({ paths, profile }) => {
    if (options.thread) {
      const thread = await findThread(paths, profile, assertThreadSlug(options.thread));
      const runs = await readThreadRuns(thread.dir);
      console.log(
        options.json
          ? JSON.stringify(runs, null, 2)
          : runs.runs.map((run) => `${run.id}\t${run.total_cost_usd ?? "?"}`).join("\n")
      );
      return;
    }
    if (options.runId && options.trace) {
      console.log(await readRunTrace(paths, options.runId));
      return;
    }
    const statuses = await listRunStatuses(paths);
    if (options.json) console.log(JSON.stringify({ runs: statuses }, null, 2));
    else
      for (const run of statuses)
        console.log(`${run.id}\t${run.state}\t${run.thread ?? "-"}\t${run.current_step}`);
  });
}

export async function runThreadDelete(
  slug: string,
  options: ThreadOptions & { noPush?: boolean }
): Promise<void> {
  await withThreadLog(options, `thread delete ${slug}`, async ({ paths, profile }) => {
    assertThreadSlug(slug);
    const thread = await findThread(paths, profile, slug);
    const manifest = await readThreadManifest(thread.dir);

    await rm(thread.dir, { recursive: true, force: true });
    await deleteThreadFromDestination(thread.destination, manifest.slug, !options.noPush);

    console.log(`deleted\t${slug}`);
  });
}

export async function runThreadSync(
  options: ThreadOptions & {
    all?: boolean | undefined;
    slugs?: string[] | undefined;
  }
): Promise<void> {
  await withThreadLog(options, "thread sync", async ({ paths, profile }) => {
    const destinations = resolveThreadDestinations(paths, profile);

    const targetDests = new Set<string>();

    if (options.all || !options.slugs || options.slugs.length === 0) {
      for (const dest of destinations) targetDests.add(dest.name);
    } else {
      const threads = await listThreads(paths);
      const threadMap = new Map(threads.map((t) => [t.slug, t]));
      for (const slug of options.slugs) {
        const thread = threadMap.get(assertThreadSlug(slug));
        if (!thread) {
          console.warn(`thread not found: ${slug}`);
          continue;
        }
        targetDests.add(thread.destination);
      }
    }

    for (const destName of targetDests) {
      const destination = findThreadDestination(destinations, destName);
      await prepareThreadDestination(paths, destination);
      const updated = await syncThreadDestination(destination, threadStoreRoot(paths));
      if (updated.length === 0) {
        console.log(`sync\t${destName}\tup to date`);
      } else {
        console.log(`synced\t${destName}\t${updated.join(", ")}`);
      }
    }
  });
}

export async function runThreadObserveUp(options: ThreadOptions): Promise<void> {
  await withThreadLog(options, "thread observe up", async ({ paths }) => {
    const result = await startLapdogContainer(paths);
    console.log(`lapdog\t${result}`);
    console.log(`dashboard\t${lapdogDashboardUrl()}`);
    if (result === "started") {
      const ready = await waitForLapdog();
      if (!ready) {
        console.log("warning: lapdog did not become reachable within the wait window");
      }
    }
  });
}

export async function runThreadObserveDown(options: ThreadOptions): Promise<void> {
  await withThreadLog(options, "thread observe down", async () => {
    await stopLapdogContainer();
    console.log("lapdog\tstopped");
  });
}

export async function runThreadObserveStatus(
  options: ThreadOptions & { json?: boolean }
): Promise<void> {
  await withThreadLog(options, "thread observe status", async () => {
    const status = await lapdogStatus();
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`reachable\t${status.reachable}`);
      console.log(`dashboard\t${status.dashboardUrl}`);
    }
  });
}

async function withThreadLog(
  options: ThreadOptions,
  command: string,
  action: (context: {
    paths: ReturnType<typeof createRuntimePaths>;
    profile: Awaited<ReturnType<typeof resolveProfile>>;
  }) => Promise<void>
): Promise<void> {
  const paths = createRuntimePaths(options);
  const profile = await resolveProfile(paths, options.profile);
  try {
    await action({ paths, profile });
    await appendThreadCliLog(paths, command, "ok");
  } catch (error) {
    await appendThreadCliLog(paths, command, "error");
    throw error;
  }
}

async function listThreads(paths: ReturnType<typeof createRuntimePaths>) {
  const threads = [];
  try {
    for (const entry of await readdir(threadStoreRoot(paths), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "runs") continue;
      const dir = path.join(threadStoreRoot(paths), entry.name);
      try {
        const manifest = await readThreadManifest(dir);
        threads.push({
          slug: manifest.slug,
          destination: manifest.destination,
          session_count: manifest.sessions.length
        });
      } catch {
        continue;
      }
    }
  } catch {
    /* no threads yet */
  }
  return threads.sort((a, b) => a.slug.localeCompare(b.slug));
}

function emptyManifest(): ThreadManifest {
  return {
    slug: "discover",
    charter: "discover",
    destination: "",
    created_at: "",
    sessions: [],
    synthesis: {}
  };
}

function groupByThread(
  items: ReadonlyArray<{ thread: string }>
): Array<{ thread: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.thread, (counts.get(item.thread) ?? 0) + 1);
  return [...counts].map(([thread, count]) => ({ thread, count }));
}
