# PR #1335 review feedback analysis (review set 1)

## Feedback item 1: identifier collision reconciliation during sync
### Problem
Current sync merge calls `mergeIdentifierLookups(targetLookup, hostLookup)` directly. That merge enforces strict bijection and throws `IdentifierLookupError` when the same semantic key maps to different identifiers across replicas.

### Why this is a real scenario
In legitimate distributed behavior, two replicas can independently materialize the same semantic node and allocate different identifiers before synchronization.

### Failure mode
- Target: `K -> idA`
- Host: `K -> idB`
- Direct merge throws on conflict and aborts sync.

### Regression dimension
Under prior semantic-key persistence this converged naturally by key equality. With identifier-native persistence, failing to normalize key-level equivalence before merge causes a convergence regression.

## Feedback item 2: missing persisted mappings for migration-created nodes (legacy path)
### Problem
When source replica lacks existing `identifiers_keys_map`, migration key planning initializes output mappings from only preexisting materialized nodes.

### Failure mode
Nodes created by `storage.create(...)` during migration receive output identifiers via `keyToOutputKey(...)`, but those mappings were not guaranteed to be appended to persisted output mapping entries in legacy path.

### Consequence
Migrated data can contain identifier-keyed records whose key↔identifier mapping is not durably stored. On subsequent operations, reallocation can produce different identifiers and orphan previously migrated values.

## Severity rationale
Both issues are P1:
- Sync can hard-fail in normal concurrent workflows.
- Migration can silently produce unreachable persisted data.
