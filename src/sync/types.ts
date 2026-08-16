import { z } from "zod";
import { TomlDate } from "smol-toml";

export type SyncScalar = boolean | null | number | string | TomlDate;
export type SyncValue = SyncScalar | SyncValue[] | SyncDocument;
export interface SyncDocument {
  [key: string]: SyncValue;
}

const syncValueSchema: z.ZodType<SyncValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.instanceof(TomlDate),
    z.array(syncValueSchema),
    z.record(z.string(), syncValueSchema)
  ])
);

export const syncDocumentSchema = z.record(z.string(), syncValueSchema);

export interface SyncCandidate {
  target: string;
  yamlPrefix: string;
  key: string;
  value: SyncValue;
}

export interface SyncResult {
  candidates: SyncCandidate[];
}

/**
 * Turn the entries of a parsed config object into adoption candidates, dropping
 * any key the profile already renders. This is the canonical seam behind the
 * per-agent "scan for unmanaged keys" loops: each detector owns the set of keys
 * it manages or derives and passes it as `managed`, so the candidate shape and
 * insertion order stay identical across the claude, opencode, and codex paths.
 */
export function unmanagedCandidates(
  entries: SyncDocument,
  target: string,
  yamlPrefix: string,
  managed: ReadonlySet<string>
): SyncCandidate[] {
  return Object.entries(entries)
    .filter(([key]) => !managed.has(key))
    .map(([key, value]) => ({ target, yamlPrefix, key, value }));
}
