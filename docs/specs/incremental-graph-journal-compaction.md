# IncrementalGraph Journal 2 Compaction

## Purpose

Journal 2 is conceptually a local ordered history, but retaining every historical event forever is not permitted. Canonical compaction replaces history whose future-relevant meaning is already summarized by bounded journal records.

Compaction is required to preserve:

- future full synchronization behavior;
- future incremental synchronization behavior for valid cursors;
- current legacy graph projection;
- journal event allocation safety;
- the iterator semantic-effect contract.

It does not preserve forensic replay or payload history.

## Compacted representation

Canonical compaction retains:

1. one `JournalHeader`;
2. one `NodeJournalSummary` per represented semantic node;
3. one current changed-node marker per represented semantic node;
4. stored source cursors, one bounded record per known source;
5. at most a bounded implementation-defined raw event tail, which canonical size analysis may take to be empty.

Historical raw events whose effects are represented by these records may be deleted.

## Node-summary canonicalization

For each NodeKey K, fold all represented historical/adopted authority according to the same rules used by live authoring and full synchronization:

- retain the greatest semantic head authority;
- retain the componentwise maximum node-wide invalidation frontier;
- if the head is present with V, retain only metadata scoped to V;
- retain componentwise maximum current-value invalidate and hard-invalidate frontiers;
- retain only the greatest certificate naming V;
- retain the exact immutable context of the current `ValueRef` and certificate event;
- retain the latest local changed-node sequence.

Lower semantic heads, certificates for losing values, lower certificates for the current value, and value-specific invalidations for permanently losing values are not future candidates under Journal 2 semantics and may be discarded.

## Why one certificate is sufficient

Projection and synchronization define the canonical certificate for a current ValueId to be the greatest certificate event before compaction is considered.

Therefore lower certificates have no semantic role in an uncompacted journal. Removing them cannot turn a later merge from one valid certificate choice into another; that alternative choice never existed in Journal 2 semantics.

This design avoids an `O(R)` certificate antichain whose own causal vectors would produce an `O(NR²)` storage term.

## Why losing values need no payload/history

Semantic head authority is totally ordered. Once a node summary retains head H, a lower competing head can never become the selected head merely because some third state is observed later.

A genuinely later value is a new authority and can defeat H directly. It does not need the discarded losing value to remain stored.

If synchronization determines that the current winning payload is unsafe to retain, it authors a tombstone greater than the observed winning authority before deleting the payload. Hence the journal never needs hidden payload storage to prevent an older value from resurrecting.

## Invalidation compaction

### Node-wide invalidations

Node-scoped explicit invalidation can affect a future current value whose validation did not observe it. Therefore compaction retains the greatest represented node-invalidating sequence for every represented author:

```text
nodeInvalidateFrontier[A]
```

These coordinates remain even after current values change or the node becomes absent.

### Value-scoped invalidations

Value-specific invalidations can affect only their named ValueId. Once that ValueId is not the current semantic head and cannot become current again under total head authority, its value-specific frontiers may be discarded.

For the current value, repeated invalidates by one author collapse to one greatest all-mode coordinate and one greatest hard coordinate.

## Causal-summary compaction

`causalSummary` is already a componentwise maximum. Compaction retains it exactly.

Raw event contexts can be discarded when no retained semantic reference needs their exact context. The exact context of the current `ValueRef` and current certificate remains embedded in their retained refs.

## Changed-node index compaction

The incremental change index contains one live marker per represented node:

```text
(lastLocalChange(K), K)
```

When K changes at a later local sequence q, compaction/live authoring removes its old marker and inserts `(q,K)`.

This coalesces arbitrarily many changes to K while preserving the property:

```text
lastLocalChange(K) > P
```

iff K changed after a consumer which correctly incorporated this source through cursor P.

No historical marker list is required.

## Cursor preservation

Canonical compaction does not change:

- writer fingerprint;
- journal incarnation;
- local sequence coordinates;
- node `lastLocalChange` coordinates;
- source cursor coordinates.

Therefore a cursor valid before compaction remains valid afterward.

Controlled reset is different: it increments the journal incarnation and deliberately invalidates old cursors.

## Iterator semantic-effect theorem

Let P be a valid cursor and S a fixed committed source snapshot head in the same incarnation.

Let `History(P,S]` be the original un-compacted local events in that interval, and let `Delta(P,S]` be the compacted iterator output defined by the API specification: the current node summary for every node whose current changed-node marker is in `(P,S]`.

For any supported consumer state which correctly incorporated the source through P:

```text
apply(History(P,S])
```

and

```text
apply(Delta(P,S])
```

must produce observationally equivalent journal-derived synchronization state through S.

Reason: for each node, all source changes after P are folded into its current summary; if the node changed at least once after P, its latest marker remains greater than P. If it did not change after P, the consumer already incorporated its source summary through P. Cross-node global causal metadata is transferred from the header independently of the changed-node iterator.

After successful consumption, the iterator advances through S even when some or all historical events were removed and the returned delta is empty.

## Future synchronization theorem

For any supported state A, canonical compaction `C(A)`, and any future supported sequence T consisting of local graph operations, resets, and full/incremental synchronizations:

```text
observe(run(A,T)) == observe(run(C(A),T))
```

where `observe` includes the converged legacy graph and Journal 2 semantics promised by the intent records.

Sketch:

- current semantic heads are preserved exactly;
- current invalidation frontiers are preserved exactly;
- the only certificate ever considered is preserved exactly;
- current value/event contexts used by safety tests are preserved exactly;
- losing state cannot become winning without a genuinely new greater authority;
- causal allocation safety is preserved by the retained header summary/counter;
- changed-node markers preserve every valid cursor's semantic suffix;
- no future operation requires an old payload because the journal never promises one.

Thus old raw history is observationally redundant.

## Size bound

Use the intent-record variables:

- N = represented semantic nodes;
- R = represented durable authors;
- H >= 2 = upper bound on represented event/counter magnitudes;
- serialized NodeKey size is bounded;
- maximum direct in-degree is bounded;
- author IDs and fixed tags have bounded size.

One sequence coordinate costs `O(log H)` bits.

One `CausalPrefix` costs:

```text
O(R log H) bits
```

A `NodeJournalSummary` contains only a constant number of causal/frontier vectors plus a bounded number of input ValueIds, so:

```text
size(NodeJournalSummary) = O(R log H) bits
```

There are O(N) node summaries and O(N) changed-node markers. Markers cost only `O(log H)` bits plus bounded NodeKey storage. The header costs `O(R log H)`. Source cursors contribute at most `O(R log H)` when there is at most one stored cursor per durable source identity.

Therefore:

```text
size(compacted journal) = O(N R log H) bits
```

No term depends linearly on historical event count, number of synchronizations, number of resets, or database age except through `log H`.

## Per-LevelDB-value bound

No persisted journal value may contain a collection proportional to N, total dependency edges, or historical event count.

The largest allowed values are bounded node summaries/events/header vectors:

```text
O(R log H) bits
```

Graph-wide indexes are represented as many small LevelDB records rather than one giant map value.

## Compaction publication

Compaction may rewrite only the new journal sublevel. It must not change the representation or semantic contents of existing graph sublevels.

When compaction requires inactive-replica construction/cutover under the database lifecycle, the cutover must preserve atomic graph+journal consistency and must not expose a compacted journal paired with a different legacy graph snapshot.