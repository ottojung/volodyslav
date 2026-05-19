# PR #1335 review thread analysis (review 4321392820 + follow-up)

## Scope of this review pass
This document analyzes:
- The review thread feedback for PR #1335.
- The explicit follow-up constraints:
  - Do **not** add `NodeIdentifier` validation in this pass.
  - Explicitly state that validation is intentionally omitted because it is unnecessary compute for this trusted/internal path.
- Two high-priority concurrency correctness issues:
  - P1: map overwrite from stale resolver snapshot.
  - P2: mutable lookup object stored by reference in RootDatabase.

## Problem 1 (P1): overwriting `identifiers_keys_map` from stale per-operation snapshot

### What happens
Each resolver starts from a cloned lookup snapshot. If multiple pull operations run concurrently and each allocates identifiers, each operation can enqueue a `rawPutOp(IDENTIFIERS_KEY, serializeIdentifierLookup(lookup))` generated from *its own* snapshot.

When commits interleave, the later write can replace the full map with an older view plus only its own additions, dropping mappings created by another concurrent operation.

### Why it is dangerous
Dropped mappings mean graph-state records keyed by those dropped identifiers still exist, but the semantic-key reverse mapping disappears. That creates logically unreachable persisted nodes and violates the bijection invariant.

### Root cause
The write path currently performs **replace-whole-map from local snapshot**, not **merge-with-latest committed state**.

## Problem 2 (P2): storing mutable resolver lookup by reference in RootDatabase

### What happens
After successful persistence, resolver code publishes the same mutable `lookup` object reference into RootDatabase (`replaceActiveIdentifierLookup(lookup)`).

Resolvers may be reused across recursive operations, and later allocations mutate that same object before subsequent persistence is durably committed.

### Why it is dangerous
If a later batch fails, in-memory state can reflect mappings that were never persisted. Future operations can read phantom mappings from memory that do not exist on disk.

### Root cause
No defensive clone when publishing committed lookup to active root cache.

## Additional review-thread points

1. **Reset snapshot replica-switch return value bug**
   `importResetSnapshotIntoDatabase()` checks equality after `setCurrentReplicaPointer()`, which makes the condition always false.

2. **NodeIdentifier validation feedback**
   The review suggested validating string-to-identifier conversion.
   In this pass we intentionally do **not** add this validation. Rationale: this path is internal, upstream code already controls shape, and extra per-conversion validation adds redundant compute cost without practical correctness benefit for this trusted boundary.

3. **typed_database passthrough cast feedback**
   Review notes that broad `* -> *` passthrough weakens type boundaries.
   This is a real design smell but secondary to the concurrency data-loss issues; concurrency correctness is prioritized.

## Desired invariants after fix
- Lookup persistence must be monotonic under parallel pulls: concurrent allocations should union, not overwrite.
- RootDatabase active lookup must only expose committed snapshots, and those snapshots must be immutable from the perspective of later resolver mutations.
- In-memory and persisted lookup maps must remain aligned across success and failure paths.
