import type { ThreadHarness } from "../core/manifests.js";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { listThreads, readThreadManifest } from "./storage.js";
import { classifyWatermark, readWatermark } from "./watermark.js";

export type OutdatedChange = "grew" | "tail_changed";

export interface OutdatedSession {
  source: ThreadHarness;
  id: string;
  change: OutdatedChange;
  behind_messages: number | null;
}

export interface OutdatedThread {
  slug: string;
  sessions: OutdatedSession[];
}

// Explicit status reads must observe the authoritative store directly. Unlike sweep,
// this query deliberately has no source-mtime or quiescence gate.
export async function listOutdatedThreads(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<OutdatedThread[]> {
  const threads: OutdatedThread[] = [];
  for (const thread of await listThreads(paths, profile)) {
    const manifest = await readThreadManifest(thread.dir);

    const sessions = (
      await Promise.all(
        manifest.sessions.map(async (session): Promise<OutdatedSession | undefined> => {
          const current = await readWatermark(paths, { source: session.source, id: session.id });
          if (classifyWatermark(session, current) !== "changed" || current === undefined) {
            return undefined;
          }

          if (
            session.message_count !== undefined &&
            current.message_count > session.message_count
          ) {
            return {
              source: session.source,
              id: session.id,
              change: "grew",
              behind_messages: current.message_count - session.message_count
            };
          }

          return {
            source: session.source,
            id: session.id,
            change: "tail_changed",
            behind_messages: null
          };
        })
      )
    ).filter((session): session is OutdatedSession => session !== undefined);

    if (sessions.length === 0) continue;
    sessions.sort((a, b) => `${a.source}\t${a.id}`.localeCompare(`${b.source}\t${b.id}`));
    threads.push({ slug: manifest.slug, sessions });
  }

  return threads.sort((a, b) => a.slug.localeCompare(b.slug));
}
