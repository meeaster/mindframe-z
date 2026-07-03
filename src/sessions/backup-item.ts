// A single object to back up: its key tail (relative to <prefix>/<harness>/), a
// freshness signal (mtime for Claude, db-derived for OpenCode), and a lazy loader so
// the upload loop doesn't have to hold every session's bytes in memory at once.
export interface BackupItem {
  relPath: string;
  sourceMs: number;
  contentType: string;
  load(): Promise<Buffer>;
}
