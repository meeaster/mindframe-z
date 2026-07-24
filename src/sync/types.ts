export interface SyncCandidate {
  target: string;
  yamlPrefix: string;
  key: string;
  value: unknown;
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
  entries: Record<string, unknown>,
  target: string,
  yamlPrefix: string,
  managed: ReadonlySet<string>
): SyncCandidate[] {
  return Object.entries(entries)
    .filter(([key]) => !managed.has(key))
    .map(([key, value]) => ({ target, yamlPrefix, key, value }));
}
