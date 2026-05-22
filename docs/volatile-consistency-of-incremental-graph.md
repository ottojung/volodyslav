# Volatile consistency of incremental graph flows

## Current state

Incremental graph updates currently allow concurrent pull/invalidate flows that each keep their own mutable `IdentifierResolver` snapshot.  
To reduce divergence, the implementation then tries to merge multiple lookup views (`active`, persisted `identifiers_keys_map`, and resolver-local state) during persistence.

This has two practical problems:

1. Correctness depends on subtle merge rules and timing windows between `_computed` writes and global lookup writes.
2. The reconciliation logic adds complexity in hot paths and still leaves edge cases around ordering and interleavings.

## Target state

Use a `_computed`-scoped consistency lock for write flows and remove concurrency-merge recovery logic.

Design goals:

1. Treat one `_computed` state (active replica) as the serialization scope for computed-state edits.
2. Run each top-level computed edit under that lock.
3. Keep nested pulls in the same top-level edit re-entrant logically (no second lock acquisition), so dependency pulls do not deadlock.
4. Persist resolver lookup as a single snapshot from the active operation, instead of merging independent concurrent snapshots.
5. Keep lock-free read APIs unchanged; only mutation/persistence paths are serialized.

## Operational model

1. Begin top-level computed edit.
2. Acquire `_computed` lock for current replica.
3. Run batched graph writes and queue lookup persistence from the same resolver snapshot.
4. Commit resolver snapshot back to active in-memory lookup.
5. Release lock and end top-level edit.

Nested dependency pulls reuse the same resolver edit scope and do not reacquire the `_computed` lock.

## Expected effect on divergence control

- No lookup-merge conflict resolution in normal pull/invalidate persistence paths.
- No identifier-lookup overwrite races between independent concurrent edit snapshots on the same `_computed` state.
- Simpler invariants: one top-level computed edit owns one resolver snapshot, one persisted lookup snapshot, one in-memory active lookup update.
