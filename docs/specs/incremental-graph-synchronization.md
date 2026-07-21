# Incremental Graph Synchronization

Synchronization merges persisted IncrementalGraph replicas without invoking computors and without inspecting cached `ComputedValue` payloads. Cached values are opaque. All cached-value ordering, conflict detection, retention, invalidation, deletion, and validity transport decisions are based on explicit causal metadata and graph structure.

## Semantic node states

For each semantic `NodeKeyString`, a replica is in exactly one of these states:

- **absent**: no materialization and no conflict frontier.
- **materialized**: identifier lookup entry, cached value, freshness, timestamps, and value clock all exist; no conflict frontier exists.
- **conflicted**: no materialization exists; a conflict frontier exists.

A semantic key must never be both materialized and conflicted.

## Value clocks

A `ValueClock` is a deterministic JSON object mapping host fingerprint strings to positive integer counters. `value_clocks` is keyed by `NodeIdentifier`. For every materialized node:

```text
keys(identifier lookup) = keys(values) = keys(freshness) = keys(timestamps) = keys(value_clocks)
```

A materialized node without a valid value clock is corrupt. A clock is never derived from cached value contents, timestamps, identifiers, freshness, or validity.

Clock operations are:

- `normalizeValueClock`: validate and sort components canonically.
- `valueClocksEqual`: same components and counters.
- `valueClockDominates`: left is greater than or equal to right in every component and greater in at least one.
- `valueClocksConcurrent`: neither equal nor dominating in either direction.
- `joinValueClocks`: component-wise maximum.
- `incrementValueClock`: increase the local host component by one.

Timestamps are descriptive metadata only and are never causal evidence.

## Clock lifecycle

Increment the local host component when creating a new cached value version: first materialization, any successful computor execution returning a real `ComputedValue`, recomputation of a conflicted unmaterialized node, and any other semantic value replacement.

Preserve the existing clock for `Unchanged`, explicit invalidation, propagated invalidation, freshness-only writes, validity-only writes, sync copy/preserve, representation-preserving migration override, and timestamp-only metadata changes.

## Conflict frontiers

`conflict_frontiers` is keyed by semantic `NodeKeyString`. A frontier is the joined clock of rejected value versions for an unmaterialized conflict. Frontiers are valid nonempty value clocks.

A later pull of a conflicted key treats it as unmaterialized with remembered causal history: dependencies are pulled, the computor receives `oldValue === undefined`, `Unchanged` is rejected, a fresh identifier is allocated, the new value clock is `incrementValueClock(frontier, localFingerprint)`, normal materialization records are written, and the frontier is removed atomically. If computation fails, the frontier remains.

## Causal source-state merge

For every semantic key, synchronization reads each source as absent, materialized with a value clock, or conflicted with a frontier.

Absent plus any state yields the other state. Two conflicted states yield `conflicted(join(F1, F2))`.

For two materialized states with clocks `A` and `B`:

- `A == B`: retain one deterministic source record for the single causal version.
- `A` dominates `B`: retain `A`.
- `B` dominates `A`: retain `B`.
- concurrent: produce `conflicted(join(A, B))`.

For materialized `V` plus conflicted `F`:

- `V` strictly dominates `F`: retain `V` as the conflict resolution.
- otherwise: remain conflicted with `join(V, F)`.

Concurrent materialized versions conflict even if their stored values are byte-for-byte identical. Synchronization must not compare, hash, serialize for comparison, inspect object identity, inspect size, inspect shape, or inspect type tags of `ComputedValue`s.

## Source selection, invalidation, and deletion

The merge plan keeps source selection, hard invalidation, and materialization survival as orthogonal outcomes. It exposes selected surviving sources, direct hard-invalidation keys, conflicted root keys, deleted materialization keys, final conflict frontiers, final identifiers, final lookup, final lowered inputs, and identifier-reconciliation status. It must not reintroduce a single `keep | take | invalidate | delete` decision enum.

A surviving materialized value keeps one exact selected source origin. Validity transport is based on exact selected-source provenance for both endpoints; equal clocks do not combine source validity metadata or mint cross-source proofs.

## Hard invalidation

A causally unique surviving value may be invalid for the merged input combination. Mixed ancestry, target-only or host-only opposite-side ancestry, direct input relowering, conservative freshness reconciliation, missing transported validity proofs, and any other lost freshness proof make the survivor a direct hard invalidation root.

A direct hard invalidation root retains its selected identifier, cached value, value clock, and timestamps according to selected-source rules; final freshness is `potentially-outdated`; every incoming validity proof is removed; the next pull invokes the computor and supplies the retained value as `oldValue`. Direct relowering alone does not delete a causally unique value.

## Structural deletion closure

A conflicted key is unmaterialized. Materializations must be dependency-closed, so every transitive materialized dependent of a conflicted key is also unmaterialized. The closure uses semantic dependency edges from the graph scheme, never validity edges.

Every deleted key receives a final conflict frontier equal to the join of all source materialized value clocks and source conflict frontiers for that key. This prevents old host materializations from resurrecting rejected or dependency-broken versions. Unrelated materializations survive.

## Application and validation

Application copies or preserves surviving selected source records opaquely, copies their value clocks, hard-invalidates direct roots, fully removes deleted materializations, writes final conflict frontiers, removes obsolete frontiers resolved by dominating materializations, removes losing target identifiers, rebuilds validity, and validates the inactive destination before replica cutover.

Merge summaries count kept, taken, invalidated, conflicted, and deleted outcomes independently. `hasChanges` reflects persistent graph changes: host records copied, invalidation, deletion, frontier creation/update/removal, identifier reconciliation, and validity changes.

Repeated merges converge because rejected versions are represented by joined frontiers, joins are commutative/associative/idempotent, and any pull-based resolution increments the joined frontier so the new value strictly dominates every incorporated rejected version. Differently ordered host merges of the same causal versions therefore produce the same conflicted frontier or the same dominating resolved materialization.
