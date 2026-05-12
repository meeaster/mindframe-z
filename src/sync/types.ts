export interface SyncCandidate {
  target: string;
  yamlPrefix: string;
  key: string;
  value: unknown;
}

export interface SyncResult {
  candidates: SyncCandidate[];
}
