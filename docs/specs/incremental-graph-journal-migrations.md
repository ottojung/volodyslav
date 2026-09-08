# IncrementalGraph Journal 2 Migration

## Purpose

This specification defines migration from a pre-Journal-2 database representation to Journal 2 without changing any existing IncrementalGraph sublevel representation.

Migration adds only the new journal sublevel and advances the database version according to the normal exact-version lifecycle.

The migration implementation has one stable bounded `MigrationId` supplied by the database migration/lifecycle registry. If this migration persists a high-level `OperationRecord(kind="migration")`, that record MUST contain this `MigrationId`; the operation envelope must not collapse all migrations into an indistinguishable generic `migration` kind.

`DeleteEvent(reason="migration")` is reserved for Journal-2-aware migrations which remove already represented semantic nodes under the general database migration lifecycle. The initial pre-Journal-2 bootstrap defined here does not need to author such a delete because it begins with no Journal 2 tombstone domain.

This document fully specifies the initial pre-Journal-2-to-Journal-2 bootstrap. A later migration whose input already contains valid Journal 2 state must separately specify whatever per-node Journal 2 transformations are required by that migration. Journal 2 nevertheless imposes one migration-wide rule on every such later migration: receiver-local stored source cursors are not preserved across the migration.

## Preconditions

The source database must satisfy the current legacy IncrementalGraph invariants:

- materialized nodes are covered by the identifier lookup;
- `values`, `freshness`, and `timestamps` have the same materialized key set;
- the dependency graph is schema-valid and dependency-closed;
- fresh nodes have complete incoming validity;
- every `valid` edge is structurally sound.

Corrupt legacy state is rejected rather than assigned invented journal meaning.

Every legacy `modifiedAt` used to seed a bootstrap value authority time must be parseable by the canonical timestamp conversion required by Journal 2. Malformed persisted timestamps are rejected rather than assigned invented authority.

## Journal-2-aware migration cursor invalidation

A migration whose input already contains Journal 2 MUST atomically delete every receiver-local stored source cursor, for example every record under:

```text
journal/cursors/*
```

The deletion is required even when the migration does not obviously change a particular source's nodes.

A source cursor certifies more than a source sequence coordinate: it also relies on the receiver-local invariant that the current receiver state already incorporates that source's synchronization-relevant state through the cursor. A database/schema migration may change the graph schema, dependency interpretation, materialized state, certificates, invalidation meaning, or other Journal 2 state on which that invariant depended. Journal 2 therefore does not assume that the pre-migration cursor remains valid under the post-migration interpretation.

The base Journal 2 design intentionally provides no migration optimization for proving individual cursors safe to preserve. After a Journal-2-aware migration, the next synchronization with each source falls back to full synchronization. A successful full synchronization may then establish a fresh cursor under the migrated state.

This rule preserves the required equivalence between incremental synchronization and the normative full-sync result without requiring every migration to prove a cross-version cursor theorem.

The initial pre-Journal-2 bootstrap has no valid Journal 2 source cursors to preserve, so this rule adds no extra bootstrap work there.

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

When this bootstrap follows same-host restoration of a pre-Journal-2 snapshot, reuse of the existing `DatabaseFingerprint` is supported under the publication-before-propagation lifecycle invariant in `database-lifecycle.md`: no Journal 2 event from that writer can exist in supported external state unless this host's own authoritative published snapshot had first advanced to Journal 2.

This is a supported-state invariant, not a global discovery protocol. If the authoritative same-host snapshot is pre-Journal-2, migration MAY rely on the lifecycle invariant and MUST NOT scan, contact, or wait for every possible peer merely to prove the absence of unsupported same-writer Journal 2 events. If locally available evidence actually demonstrates that the invariant was bypassed—for example, a state being processed already contains incompatible same-writer Journal 2 evidence not represented by the authoritative snapshot—then the state is outside the supported lifecycle and bootstrap under that writer identity MUST be rejected. Journal 2 does not require detecting every unsupported external manipulation which is not locally observable.

Bootstrap semantic events use the canonical local semantic-event allocator from `incremental-graph-journal-types.md`; this migration does not define a separate allocation rule. The initially empty causal summary contains no remote coordinates, and later bootstrap events advance the same writer-local state through that canonical allocator.

The migration may allocate one local high-level operation record and attach its `OperationId` to bootstrap semantic events. A `kind="migration"` record carries the stable migration `MigrationId`; a `kind="bootstrap"` record may also carry that migration ID when the bootstrap is specifically the expansion of this migration. Operation grouping is local history only and does not affect semantic allocation.

## Pass 1: assign current value occurrences

Enumerate every materialized semantic NodeKey in ascending order of its legacy `modifiedAt`, with canonical NodeKey order as the deterministic tie-breaker.

For each K:

1. read K's unchanged legacy value/timestamp record;
2. author `ValueEvent(reason="bootstrap")`, seeding its HLC physical component from K's existing `modifiedAt`;
3. assign its event ID as K's initial Journal 2 `ValueId`;
4. do not rewrite K's legacy payload or timestamps;
5. set the present semantic head to that ValueRef.

This ordering keeps the one-writer bootstrap HLC monotone without allowing an unrelated node with a later `modifiedAt` to inflate the authority time of a node whose own legacy modification happened earlier. Equal legacy modification times are ordered deterministically by NodeKey and separated by the HLC logical coordinate.

All current ValueIds are known before certificate bases are constructed.

## Pass 2: encode incoming validity

Enumerate every materialized K in canonical NodeKey order. For each K, create one `ValidateEvent(reason="bootstrap")` using the migration/publication wall-clock time as its physical HLC seed.

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

The bootstrap certificate does not claim that an `"unknown"` basis entry was historically validated against the migration-time input. `"unknown"` records unavailable historical validity provenance only. It does not make the migrated cached value unsafe to retain or to supply later as `oldValue`: the existing IncrementalGraph algorithm permits a stale cached value to remain while dependencies change, and passes that cache to the computor when revalidation cannot prove reuse.

## Pass 3: encode stale state

Enumerate legacy nodes whose freshness is `potentially-outdated` in canonical NodeKey order. For each such node, author one value-scoped soft invalidation after its bootstrap certificate.

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

Journal 2 synchronization requires exact compatible database versions and valid Journal 2 metadata on both sides. A pre-Journal-2 replica is not incrementally or semantically synchronized directly with a Journal 2 replica and is not a valid Journal 2 reset source.

It must first migrate to Journal 2. Same-host restoration may restore an older pre-Journal-2 saved database as lifecycle recovery, but the migration gate must establish Journal 2 before that state participates in Journal 2 synchronization or semantic reset.

A later migration from one Journal-2-aware database version to another deletes receiver-local source cursors as specified above. Exact version compatibility still applies after migration; once compatible migrated peers synchronize again, their first post-migration synchronization relationship is re-established by full synchronization rather than by a pre-migration cursor.

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
