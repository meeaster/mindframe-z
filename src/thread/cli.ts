import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "../core/fs-util.js";
import { createRuntimePaths, type PathOptions } from "../core/paths.js";
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
  defaultThreadStore,
  findThread,
  findThreadStore,
  listThreads,
  prepareThreadStore,
  readThreadManifest,
  readThreadRuns,
  resolveSynthesisDefaults,
  resolveSessionSources,
  resolveThreadStores,
  syncThreadStore,
  writeThreadManifest,
  writeThreadRuns,
  type ThreadManifest
} from "./storage.js";
import {
  assertThreadStoreWritable,
  commitThreadChanges,
  deleteThreadFromStore,
  type ThreadPublication
} from "./publication.js";
import {
  appendThreadCliLog,
  listRunStatuses,
  readRunTrace,
  writeRunStatus
} from "./observability.js";
import { ensureThreadToolsImage, threadToolsImageBuildPlan } from "./build.js";
import { listOutdatedThreads } from "./outdated.js";
import { withThreadLock } from "./lock.js";
import { migrateThreadRuntimeState } from "./runtime.js";
import { migrateStore, publishStoreMigration } from "./migration.js";

interface ThreadOptions extends PathOptions {
  profile?: string | undefined;
}

// Slugs come from argv and flow into store paths and Git commands, so bound
// them to a safe identifier before they can escape an authoritative checkout.
function assertThreadSlug(slug: string): string {
  return threadIdentifierSchema.parse(slug);
}

export async function runThreadStores(options: ThreadOptions & { json?: boolean }): Promise<void> {
  await withThreadLog(options, "thread stores", async ({ paths, profile }) => {
    const stores = resolveThreadStores(paths, profile);
    if (options.json) console.log(JSON.stringify({ stores }, null, 2));
    else
      for (const store of stores)
        console.log(
          `${store.default ? "*" : " "} ${store.name}\t${store.root}\t${store.path}\t${store.publication === "direct" ? "direct" : `pull-request:${store.publication.base}`}`
        );
  });
}

export async function runThreadMigration(
  options: ThreadOptions & {
    store?: string | undefined;
    dryRun?: boolean;
    publish?: boolean;
    json?: boolean;
  }
): Promise<void> {
  await withThreadLog(options, "thread migrate", async ({ paths, profile }) => {
    if (!options.dryRun && !options.publish) {
      throw new Error(
        "Thread migration is dry-run only until a reviewed store worktree is selected"
      );
    }
    const stores = resolveThreadStores(paths, profile);
    const selected = options.store ? [findThreadStore(stores, options.store)] : stores;
    if (options.publish) {
      const publications = await Promise.all(
        selected.map((store) => {
          if (store.publication === "direct") {
            throw new Error(
              `Store ${store.name} uses direct publication; select a reviewed workflow explicitly`
            );
          }
          return publishStoreMigration({
            paths,
            storeName: store.name,
            storeRoot: store.root,
            storePath: store.path,
            base: store.publication.base
          });
        })
      );
      if (options.json) console.log(JSON.stringify({ publications }, null, 2));
      else for (const publication of publications) console.log(`pull-request\t${publication.url}`);
      return;
    }
    const results = await Promise.all(
      selected.map((store) =>
        migrateStore({
          paths,
          storeName: store.name,
          storePath: store.path,
          dryRun: true
        })
      )
    );
    if (options.json) {
      console.log(JSON.stringify({ stores: results }, null, 2));
    } else {
      for (const result of results)
        console.log(`validated\t${result.storeName}\t${result.threads.length} threads`);
    }
  });
}

export async function runThreadToolsBuild(
  options: ThreadOptions & { force?: boolean | undefined }
): Promise<void> {
  await withThreadLog(options, "thread tools build", async ({ paths }) => {
    const plan = await threadToolsImageBuildPlan(paths);
    const result = await ensureThreadToolsImage(plan, { force: options.force });
    console.log(`${result}\t${plan.image}\t${plan.hash}`);
  });
}

export async function runThreadCreate(
  slug: string,
  options: ThreadOptions & {
    store?: string | undefined;
    charter: string;
    discover?: string | undefined;
    gather?: string | undefined;
    synthesize?: string | undefined;
  }
): Promise<void> {
  await withThreadLog(options, `thread create ${slug}`, async ({ paths, profile }) => {
    assertThreadSlug(slug);
    const stores = resolveThreadStores(paths, profile);
    const store = options.store
      ? findThreadStore(stores, options.store)
      : defaultThreadStore(stores);
    if (!store) throw new Error("No thread stores configured");
    assertThreadStoreWritable(store);
    await prepareThreadStore(paths, store);
    if ((await listThreads(paths, profile)).some((thread) => path.basename(thread.dir) === slug))
      throw new Error(`Thread already exists: ${slug}`);
    const dir = path.join(store.path, slug);
    if (await pathExists(path.join(dir, "manifest.json")))
      throw new Error(`Thread already exists: ${slug}`);
    const manifest: ThreadManifest = {
      slug,
      charter: options.charter,
      store: store.name,
      created_at: new Date().toISOString(),
      sessions: [],
      excluded: [],
      synthesis: {
        ...(options.discover ? { discover: options.discover } : {}),
        ...(options.gather ? { gather: options.gather } : {}),
        ...(options.synthesize ? { synthesize: options.synthesize } : {})
      }
    };
    if (store.publication !== "direct") {
      const workspace = await mkdtemp(path.join(tmpdir(), "mfz-thread-run-"));
      const stagedDir = path.join(workspace, slug);
      try {
        await writeThreadManifest(stagedDir, manifest);
        await writeThreadRuns(stagedDir, { runs: [] });
        printThreadPublication(
          await commitThreadChanges(store, slug, stagedDir, `chore(thread): create ${slug}`, true)
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    } else {
      await writeThreadManifest(dir, manifest);
      await writeThreadRuns(dir, { runs: [] });
      printThreadPublication(
        await commitThreadChanges(store, slug, dir, `chore(thread): create ${slug}`, true)
      );
    }
    console.log(`created\t${slug}\t${store.name}`);
  });
}

export async function runThreadList(options: ThreadOptions & { json?: boolean }): Promise<void> {
  await withThreadLog(options, "thread list", async ({ paths, profile }) => {
    const threads = await listThreads(paths, profile);
    const entries = await Promise.all(
      threads.map(async (thread) => {
        const manifest = await readThreadManifest(thread.dir);
        return {
          slug: manifest.slug,
          store: thread.store.name,
          session_count: manifest.sessions.length
        };
      })
    );
    if (options.json) console.log(JSON.stringify({ threads: entries }, null, 2));
    else
      for (const thread of entries)
        console.log(`${thread.slug}\t${thread.store}\t${thread.session_count} sessions`);
  });
}

export async function runThreadOutdated(
  options: ThreadOptions & { json?: boolean | undefined }
): Promise<void> {
  const paths = createRuntimePaths(options);
  const runtimeMigration = await migrateThreadRuntimeState(paths);
  for (const conflict of runtimeMigration.conflicts) {
    console.warn(`thread runtime state conflict: ${conflict.source} -> ${conflict.target}`);
  }
  const profile = await resolveProfile(paths, options.profile);
  const report = { threads: await listOutdatedThreads(paths, profile) };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const thread of report.threads)
    for (const session of thread.sessions) {
      const change = session.change === "grew" ? "grew" : "tail changed";
      const detail =
        session.change === "grew"
          ? `${session.behind_messages} message${session.behind_messages === 1 ? "" : "s"} behind`
          : "not quantifiable";
      console.log(`${thread.slug}\t${session.source}:${session.id}\t${change}\t${detail}`);
    }
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
    const runId = `run-${Date.now()}-${randomUUID()}`;
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
      skills: ["thread-sessions"],
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
    const slug = assertThreadSlug(options.thread);
    const result = await withThreadLock(paths, slug, `thread ingest ${slug}`, () =>
      ingestThread({
        paths,
        profile,
        threadSlug: slug,
        sessionIds: ids,
        noPush: Boolean(options.noPush),
        gather: options.gather,
        synthesize: options.synthesize,
        runner: options.runner
      })
    );
    if (result.refreshed.length > 0)
      console.log(`refresh (changed):\t${result.refreshed.join("\t")}`);
    if (result.vanished.length > 0)
      console.log(`skip (vanished/shrank):\t${result.vanished.join("\t")}`);
    printThreadPublication(result.publication);
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
    const slug = assertThreadSlug(options.thread);
    const result = await withThreadLock(paths, slug, `thread refresh ${slug}`, () =>
      ingestThread({
        paths,
        profile,
        threadSlug: slug,
        sessionIds: [],
        refresh: true,
        all: Boolean(options.all),
        noPush: Boolean(options.noPush),
        gather: options.gather,
        synthesize: options.synthesize,
        runner: options.runner
      })
    );
    if (result.vanished.length > 0)
      console.log(`skip (vanished/shrank):\t${result.vanished.join("\t")}`);
    if (result.sessionCount === 0) {
      console.log(`up to date\t${result.slug}\tnothing drifted`);
      return;
    }
    printThreadPublication(result.publication);
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
  await withThreadLog(options, "thread pending", async ({ paths, profile }) => {
    const proposals = await listPending(paths, profile);
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
  await withThreadLog(options, `thread reject ${id}`, async ({ paths, profile }) => {
    await rejectPending(paths, profile, id, assertThreadSlug(options.thread));
    console.log(`rejected\t${id}\t${options.thread}`);
  });
}

export async function runThreadConclude(options: ThreadOptions): Promise<void> {
  await withThreadLog(options, "thread conclude", async ({ paths, profile }) => {
    const count = await concludePending(paths, profile);
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
    const threadSlug = assertThreadSlug(slug);
    const result = await withThreadLock(paths, threadSlug, `thread regenerate ${threadSlug}`, () =>
      regenerateThread({
        paths,
        profile,
        threadSlug,
        noPush: Boolean(options.noPush),
        synthesize: options.synthesize,
        runner: options.runner
      })
    );
    printThreadPublication(result.publication);
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
          : runs.runs
              .map(
                (run) =>
                  `${run.id}\t${run.kind === "native" ? (run.total_cost_usd ?? "?") : (run.cost_usd ?? "?")}`
              )
              .join("\n")
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
    assertThreadStoreWritable(thread.store);

    const publication = await deleteThreadFromStore(thread.store, manifest.slug, !options.noPush);
    printThreadPublication(publication);
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
    const stores = resolveThreadStores(paths, profile);

    const targetDests = new Set<string>();

    if (options.all || !options.slugs || options.slugs.length === 0) {
      for (const store of stores) targetDests.add(store.name);
    } else {
      const threads = await listThreads(paths, profile);
      const threadMap = new Map(threads.map((thread) => [path.basename(thread.dir), thread]));
      for (const slug of options.slugs) {
        const thread = threadMap.get(assertThreadSlug(slug));
        if (!thread) {
          console.warn(`thread not found: ${slug}`);
          continue;
        }
        targetDests.add(thread.store.name);
      }
    }

    for (const destName of targetDests) {
      const store = findThreadStore(stores, destName);
      await prepareThreadStore(paths, store);
      const updated = await syncThreadStore(store);
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
  const runtimeMigration = await migrateThreadRuntimeState(paths);
  for (const conflict of runtimeMigration.conflicts) {
    console.warn(`thread runtime state conflict: ${conflict.source} -> ${conflict.target}`);
  }
  try {
    await action({ paths, profile });
    await appendThreadCliLog(paths, command, "ok");
  } catch (error) {
    await appendThreadCliLog(paths, command, "error");
    throw error;
  }
}

function emptyManifest(): ThreadManifest {
  return {
    slug: "discover",
    charter: "discover",
    store: "",
    created_at: "",
    sessions: [],
    excluded: [],
    synthesis: {}
  };
}

function printThreadPublication(publication: ThreadPublication): void {
  if (publication.kind === "pull-request") console.log(`pull-request\t${publication.url}`);
  if (publication.kind === "local-branch")
    console.log(`local-branch\t${publication.branch}\t${publication.commit}`);
}

function groupByThread(
  items: ReadonlyArray<{ thread: string }>
): Array<{ thread: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.thread, (counts.get(item.thread) ?? 0) + 1);
  return [...counts].map(([thread, count]) => ({ thread, count }));
}
