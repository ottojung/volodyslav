# IncrementalGraph Journal 2 Reset

## Purpose

This specification defines controlled reset-to-snapshot behavior for Journal 2.

Reset is not ordinary synchronization. It intentionally replaces the receiver's graph state with a chosen source snapshot and starts a new local journal incarnation.

Journal 2 reset does not import the source journal as receiver history and does not retain Journal 1-style historical reset anchors.

## Preconditions

Reset operates under the lifecycle's exclusive replacement boundary on stable receiver and source snapshots with compatible schema/database versions.

The source snapshot must itself satisfy the Journal 2/legacy graph consistency invariants when Journal 2 is present.

## Resulting legacy graph

Reset constructs the target legacy graph according to the existing reset semantics for values, timestamps, freshness, validity, identifiers, graph scheme, and database version.

The representation of those sublevels is unchanged.

A reset implementation may avoid rewriting a receiver payload when:

```text
isEqual(receiverValue, sourceValue)
```

for the corresponding semantic node. This is the one Journal 2 synchronization/lifecycle operation allowed to use `ComputedValue` equality for this purpose.

Equality merely permits leaving already-equal payload bytes in place. It does not prove shared ValueId, provenance, causal history, validation history, or journal identity.

## New journal incarnation

A successful reset increments:

```text
journalIncarnation := journalIncarnation + 1
```

before issuing new cursors.

The local writer fingerprint remains the database's durable writer identity unless the broader database lifecycle explicitly creates a new database identity.

`localJournalCounter` remains monotone across reset; it is not reset to zero.

Before reset-authored events are allocated, the receiver observes the chosen source's current journal causal knowledge and semantic refs where available, so newly authored reset authority receives sequences above every observed coordinate.

The receiver may retain its accumulated `causalSummary`; reset does not require historical per-node reset anchors.

## Receiver-side cursor invalidation

A receiver reset destroys the invariant certified by every receiver-local stored source cursor: that this receiver has incorporated that source through the cursor's `through` coordinate.

The cursor's `incarnation` field names the **source** journal incarnation, not the receiver's. Incrementing the receiver's own `journalIncarnation` therefore does not invalidate receiver-local cursors for other sources by field comparison.

Accordingly, controlled reset MUST atomically delete every receiver-local stored source cursor, for example every record under:

```text
journal/cursors/*
```

as part of installing the reset state.

After reset, incremental synchronization with any source is unavailable until a successful full synchronization establishes a fresh cursor for that source.

Separately, the receiver's incremented journal incarnation invalidates cursors held by other replicas **about this receiver**, because those cursors name the receiver as their source.

## Rebootstrap, not journal import

After the target legacy graph is constructed, Journal 2 creates a new local explanation of that resulting graph.

Define the reset semantic domain as:

```text
ResetKeys =
    representedKeys(preResetReceiver)
    union representedKeys(resetSource)
```

where represented keys include both present heads and tombstoned/absent heads in compacted Journal 2 summaries, plus materialized legacy nodes when bootstrapping a journal-less supported source.

For every materialized target semantic node K:

1. author a new local `ValueEvent(reason="reset")`;
2. that new event ID becomes K's new `ValueId`, even if equal payload bytes were reused without rewriting;
3. later author a local `ValidateEvent(reason="reset")` whose basis encodes the resulting legacy incoming validity relation as described below;
4. if the resulting target node is stale, author a local value-scoped soft invalidation after the validation so the projection remains stale.

For every K in `ResetKeys` which is absent from the resulting target legacy graph, author a local `DeleteEvent(reason="reset")`.

This includes a node which is represented only by a tombstone in the chosen source and was completely unknown to the pre-reset receiver. Such a source tombstone has been observed by reset and must be represented by the new local reset baseline; otherwise an older delayed value could later resurrect the node.

These tombstones ensure that both pre-reset receiver values and source-observed absent authority cannot be resurrected merely because their old/source journal summaries are not imported into the new local history.

The set of reset-created events is O(N) and each is individually bounded.

## Encoding target validity

Reset must preserve the resulting legacy `valid` relation without assuming unavailable historical value versions.

After every target present node has received its new reset `ValueId`, build each certificate basis over `inputEdges(K)`:

```text
basis[i] = currentValueId(Di)
    if legacy valid[Di] contains K
basis[i] = "unknown"
    otherwise
```

For a target fresh node, the existing graph invariant guarantees that every required incoming validity edge exists, so the basis contains the current ValueId for every direct input.

For a target stale node, partial or absent validity is represented exactly by current IDs and `"unknown"` sentinels. A following soft invalidation keeps the node stale even when all basis entries happen to match.

No source historical certificate is imported.

## Reset invalidation baseline

The new incarnation's per-node value-specific invalidation state is rebuilt from the resulting target graph rather than carrying arbitrary old value-specific frontier history.

Old node-wide/value-specific journal invalidation frontiers are not required to survive as reset-anchor archives. Reset's newly authored values/certificates/tombstones are a new local baseline.

The global causal summary may still remember old author coordinates for event-allocation/causal observation; those coordinates are not reset semantic authority for individual nodes.

## Why reset stays within the bound

Let N be the size of `ResetKeys` after including every resulting materialized node. This includes source-only tombstoned keys which remain absent after reset.

Reset creates only a constant number of events/summary components per represented node:

- one value or tombstone authority;
- one certificate for a present value;
- at most one initial stale assertion;
- bounded input ValueId basis;
- ordinary bounded causal/frontier metadata.

Receiver-local source cursors are deleted rather than accumulated across resets.

After canonical compaction this is still:

```text
O(N R log H) bits
```

and each individual journal LevelDB value is:

```text
O(R log H) bits
```

No term depends on the number of prior resets or the number of historical reset anchors because prior reset-specific per-node history is subsumed by the new incarnation baseline.

## Delayed old replicas

A replica which has not participated since before reset may later present old semantic authorities.

For authorities represented by either reset input and therefore observed before the reset baseline was authored, reset-authored local heads have greater sequences because allocation occurs above observed causal coordinates. They therefore cannot displace the reset baseline.

This includes absent authority represented only by a source tombstone: reset creates a new local tombstone for that key.

A genuinely unseen remote authority may be concurrent with the reset and is resolved by ordinary Journal 2 synchronization rules when eventually observed. Journal 2 does not promise Journal 1's exact absorption of arbitrary unseen reset-anchor history.

This behavior is compatible with the current Journal 2 intent records and is what permits the bounded reset representation.

## Cursor behavior

Two distinct cursor effects apply:

1. cursors held by other replicas about this receiver become invalid because this receiver's `journalIncarnation` changed;
2. cursors stored by this receiver about other sources are explicitly deleted because reset destroyed their incorporated-state invariant.

The reset process rebuilds one changed-node marker per represented node in the new incarnation. A subsequent incremental relationship with any source is established only after a successful full synchronization under the reset receiver state.

## Repeating reset

Repeating reset to an equivalent source snapshot is still a new controlled reset operation and therefore may create a new incarnation and new local baseline authority.

No convergence rule relies on reset being idempotent. Normal synchronization after reset remains convergent because the reset baseline is ordinary bounded Journal 2 semantic authority.