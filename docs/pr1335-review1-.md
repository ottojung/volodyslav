# PR #1335 Review Feedback Problem Statement

## Feedback thread scope
The review feedback highlights correctness regressions introduced in identifier-native persistence and replica-cutover flow.

## Problem 1: merged identifier lookup not persisted at cutover
During merge, node data from host (`inputs/values/timestamps/...`) is written into target replica, then active replica pointer is switched. But if corresponding host identifier mappings are not merged into `global/identifiers_keys_map`, active lookup can miss identifiers that now exist in graph data.

### Why this is severe
- `requireNodeKey` can fail for identifiers that exist in state.
- New allocations can produce fresh IDs for already-present semantic keys, bypassing merged cache entries.
- This is a consistency break between graph-state sublevels and global lookup.

## Problem 2: legacy multi-segment key paths rejected in decoder
`relativePathToKey` currently enforces single key segment for non-plain sublevels. Historical snapshots may encode semantic keys as multiple path segments (e.g. `head/arg1/...`).

### Why this is severe
- Filesystem scan (`scanFromFilesystem`) calls decoder directly.
- Upgrade from existing repositories can throw before migration logic executes.
- This is an external persisted-format regression.

## Additional thread comment findings
- `importResetSnapshotIntoDatabase` computed `switchedReplica` after pointer update, always returning false.
- `internalPullByNodeIdentifierWithStatusDuringPull` accepted/documented NodeIdentifier, but treated input as serialized NodeKey.
