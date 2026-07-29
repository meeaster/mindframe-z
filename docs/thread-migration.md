# Thread Store Migration

MFZ thread manifests are authoritative only after migration to the strict store model.
Run migration from an isolated store worktree, never against a canonical pull-request
store checkout.

The one-time migration reader accepts predecessor `destination`, `high_water`, embedded
`runs`, provenance, exclusions, and extraction-policy fields. It writes `store`, strict
session provenance, all-or-none canonical watermark triples, and imported run-ledger
records. Unknown fields and unresolved cursors stop that manifest's migration without
replacing its predecessor file.

Legacy cursor boundaries are resolved as follows:

- Claude timestamps select the final canonical user or assistant message at or before the timestamp.
- Claude integer cursors select the final canonical message in the first N valid JSONL records.
- OpenCode timestamps select messages created at or before the session-update timestamp.

Migration does not advance a cursor to the source tail. Any later source activity remains
visible to `thread outdated` and `thread refresh` after the converted store is accepted.

Validate every manifest, run ledger, generated `index.md`, store ownership, watermark, and
non-metadata content hash before opening one store migration pull request. Do not delete
predecessor paths or local runtime state until the accepted store passes those checks.
