# IncrementalGraph Journal 2 Reset

## Purpose

This specification defines controlled reset-to-snapshot behavior for Journal 2.

Reset is not ordinary synchronization. It intentionally replaces the receiver's graph state with a chosen source snapshot and starts a new local journal incarnation so old incremental cursors cannot be mistaken for progress in the new history.

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

## Rebootstrap, not journal import

After the target legacy graph is constructed, Journal 2 creates a new local explanation of that resulting graph.

For every materialized target semantic node K:

1. author a new local `ValueEvent(reason="reset")`;
2. that new event ID becomes K's new `ValueId`, even if equal payload bytes were reused without rewriting;
3. later author a local `ValidateEvent(reason="reset")` whose basis encodes the resulting legacy incoming validity relation as described below;
4. if the resulting target node is stale, author a local value-scoped soft invalidation after the validation so the projection remains stale.

For every semantic node represented by the pre-reset journal/graph which is absent from the reset target, author a local `DeleteEvent(reason="reset")`.

These tombstones ensure that pre-reset values already known to the receiver cannot be resurrected merely because their old journal summaries are discarded by the reset rebootstrap.

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

Let N be the union of semantic nodes which must remain represented after reset, including tombstoned pre-reset nodes which are absent from the target.

Reset creates only a constant number of events/summary components per represented node:

- one value or tombstone authority;
- one certificate for a present value;
- at most one initial stale assertion;
- bounded input ValueId basis;
- ordinary bounded causal/frontier metadata.

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

For authorities already observed by the receiver before reset, reset-authored local heads have greater sequences because allocation occurs above observed causal coordinates. They therefore cannot displace the reset baseline.

A genuinely unseen remote authority may be concurrent with the reset and is resolved by ordinary Journal 2 synchronization rules when eventually observed. Journal 2 does not promise Journal 1's exact absorption of arbitrary unseen reset-anchor history.

This behavior is compatible with the current Journal 2 intent records and is what permits the bounded reset representation.

## Cursor behavior

Every cursor issued before reset has the old `journalIncarnation` and is invalid afterward.

The reset process rebuilds one changed-node marker per represented node in the new incarnation. A subsequent incremental relationship with any source is established only after a successful full synchronization under the new incarnation.

## Repeating reset

Repeating reset to an equivalent source snapshot is still a new controlled reset operation and therefore may create a new incarnation and new local baseline authority.

No convergence rule relies on reset being idempotent. Normal synchronization after reset remains convergent because the reset baseline is ordinary bounded Journal 2 semantic authority.