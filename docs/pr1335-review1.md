# PR #1335 Review Feedback Analysis (Review 4324712985 + P1 comments)

## Feedback sources
- Review: https://github.com/ottojung/volodyslav/pull/1335#pullrequestreview-4324712985
- Additional P1 findings provided inline in task request.

## Problem 1 (P1): Identifier collisions before lookup merge in host sync

### What happens
During `mergeHostIntoReplica` in `backend/src/generators/incremental_graph/database/sync_merge.js`, host and target lookup maps are merged with:

- `mergeIdentifierLookups(targetLookup, hostLookup)`

`mergeIdentifierLookups` enforces strict bijection with no conflict-resolution policy.

### Failing scenario
A valid distributed scenario:
- Target has semantic key `K -> idA`
- Host has semantic key `K -> idB`
- `idA !== idB`

Both mappings are locally valid and can occur when replicas materialize the same semantic node independently.

Current merge then throws `IdentifierLookupError` because key `K` is already assigned to a different identifier in the base map.

### Why this is severe
This is a **convergence regression**: a normal concurrent materialization no longer converges and instead aborts synchronization.

### Root cause
Conflict policy was implicitly moved from semantic-key identity to strict identifier-bijection identity, but this call site still receives heterogeneous allocations across replicas and needs a reconciliation step.

---

## Problem 2 (P1): Legacy migration drops mappings for newly created nodes

### What happens
In `backend/src/generators/incremental_graph/migration_runner.js`, `makeMigrationKeyPlan` has a legacy branch when no `identifiers_keys_map` exists.

In that branch:
- `outputEntries` is initialized from preexisting `materializedNodes`.
- `keyToOutputKey(...)` can allocate identifiers for additional nodes introduced during `storage.create(...)`.
- Those new mappings are **not appended** to `outputEntries`.

### Result
Migrated output may contain identifier-keyed graph records for newly created nodes, but `global.identifiers_keys_map` does not include their key↔id mapping.

### Why this is severe
After migration, unresolved mappings can cause re-allocation to different identifiers and make previously written values unreachable/orphaned.

### Root cause
The key plan in legacy mode behaves like a snapshot, not a live accumulating mapping source, even though migration logic can introduce new nodes after initial plan construction.

---

## Conceptual conclusion
Both P1 issues are manifestations of the same deeper invariant:

> Once identifier-native storage is introduced, **lookup-map lifecycle** (allocation, merge reconciliation, and persistence completeness) must be treated as part of core state transitions, not an afterthought.

