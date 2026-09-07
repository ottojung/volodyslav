# IncrementalGraph Journal 2 Migration

## Purpose

This specification defines migration from a pre-Journal-2 database representation to Journal 2 without changing any existing IncrementalGraph sublevel representation.

Migration adds only the new journal sublevel and advances the database version according to the normal exact-version lifecycle.

The migration implementation has one stable bounded `MigrationId` supplied by the database migration/lifecycle registry. If this migration persists a high-level `OperationRecord(kind="migration")`, that record MUST contain this `MigrationId`; the operation envelope must not collapse all migrations into an indistinguishable generic `migration` kind.

## Preconditions

The source database must satisfy the current legacy IncrementalGraph invariants:

- materialized nodes are covered by the identifier lookup;
- `values`, `freshness`, and `timestamps` have the same materialized key set;
- the dependency graph is schema-valid and dependency-closed;
- fresh nodes have complete incoming validity;
- every `valid` edge is structurally sound.

Corrupt legacy state is rejected rather than assigned invented journal meaning.

Every legacy `modifiedAt` used to seed a bootstrap value authority time must be parseable by the canonical timestamp conversion required by Journal 2. Malformed persisted timestamps are rejected rather than assigned invented authority.

## Frozen existing sublevels

The migration must not rewrite a value merely to add Journal 2 metadata.

Except for ordinary lifecycle metadata whose value necessarily changes when the database version advances, all existing graph sublevel records retain their established representation and semantic contents.

In particular, no journal envelope is wrapped around `values`, `freshness`, `timestamps`, `valid`, or identifiers.

## Bootstrap writer state

Initialize:

```text
header.writer = existing DatabaseFingerprint
header.incarnation = 1
header.localJournalCounter = 0
header.localOperationCounter = 0
header.causalSummary = {}
header.authorityClock = { physical: 0, logical: 0 }
```

Journal event sequences allocated by this migration are strictly writer-local:

```text
nextSequence = localJournalCounter + 1
```

They are not based on any cross-writer maximum.

The migration may allocate one local high-level operation record and attach its `OperationId` to bootstrap semantic events. A `kind="migration"` record carries the stable migration `MigrationId`; a `kind="bootstrap"` record may also carry that migration ID when the bootstrap is specifically the expansion of this migration. Operation grouping is local history only and does not affect semantic allocation.

## Pass 1: assign current value occurrences

Enumerate every materialized semantic NodeKey in deterministic canonical NodeKey order.

For each K:

1. read K's unchanged legacy value/timestamp record;
2. author `ValueEvent(reason="bootstrap")`, seeding its HLC physical component from K's existing `modifiedAt`;
3. assign its event ID as K's initial Journal 2 `ValueId`;
4. do not rewrite K's legacy payload or timestamps;
5. set the present semantic head to that ValueRef.

Because all bootstrap events are authored by one local journal in deterministic order, each successive event also advances from the previous HLC high-water mark as required by the ordinary event-allocation rule. The HLC may therefore be later than an individual legacy `modifiedAt` when necessary to preserve same-writer happened-before.

All current ValueIds are known before certificate bases are constructed.

## Pass 2: encode incoming validity

For every materialized K, create one `ValidateEvent(reason="bootstrap")` using the migration/publication wall-clock time as its physical HLC seed.

Let `inputEdges(K) = [D0, D1, ...]`. Set:

```text
basis[i] = currentValueId(Di)
    if legacy valid[Di] contains K
basis[i] = "unknown"
    otherwise
```

This exactly represents the current legacy incoming validity relation without pretending to know historical input value identities which the old database never stored.

For a fresh node, the legacy invariant guarantees every basis entry is the current input ValueId.

For a stale node, partial validity is preserved exactly.

## Pass 3: encode stale state

For every legacy node whose freshness is `potentially-outdated`, author one value-scoped soft invalidation after its bootstrap certificate.

This is necessary even when the node currently has complete incoming validity: the existing flag algorithm deliberately keeps such a node stale until it is itself pulled/cache-revalidated.

For a fresh node, author no bootstrap invalidation.

Zero-input stale nodes are therefore also represented correctly.

## Projection check

Before cutover, derive the Journal 2 projection and require exact agreement with the unchanged legacy graph for:

- materialized semantic node set;
- current `freshness` of every materialized node;
- every `valid` edge;
- dependency closure.

Payload/timestamp records are not regenerated by projection and must remain the source records.

If the projection does not match, migration fails before publication.

## Initial compaction

The bootstrap historical events may be canonically compacted immediately into:

- header, including the final local sequence, causal summary, and HLC authority high-water mark;
- one node summary per materialized node;
- one changed-node marker per represented node;
- no required historical raw event/operation prefix.

The conceptual bootstrap history remains the explanation of how the Journal 2 baseline was established even if its raw semantic events and operation grouping are removed by compaction.

## Initial changed-node markers

Every represented node receives a current marker in the initial incarnation. There is no valid pre-Journal-2 cursor, so the exact bootstrap marker coordinates are used only for future Journal 2 cursors.

## Synchronization compatibility

Journal 2 synchronization requires exact compatible database versions. A pre-Journal-2 replica is not incrementally or semantically synchronized directly with a Journal 2 replica.

It must first migrate or be reset/bootstrap-restored through the supported lifecycle.

## Size

Let L be the number of materialized nodes in the legacy state being migrated. The initial migration baseline has no historical Journal-2 tombstone domain, so its bootstrap work is O(L) semantic events plus at most O(1) high-level operation records.

Each event is individually within the Journal 2 per-value bound, and canonical compaction leaves O(L) bounded summaries/markers plus one bounded header.

Therefore the migrated compacted journal satisfies the general bound:

```text
O((L + T) R log H) bits
```

with `T = 0` at this initial bootstrap unless the supported migration explicitly creates retained absent-key authority, and with individual journal LevelDB values bounded by:

```text
O(R log H) bits.
```
