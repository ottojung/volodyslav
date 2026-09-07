# IncrementalGraph Journal 2 Compaction

## Purpose

Journal 2 is conceptually a local ordered history, but retaining every historical event forever is not permitted. Canonical compaction replaces history whose future-relevant meaning is already summarized by bounded journal records.

Compaction is required to preserve:

- future full synchronization behavior;
- future incremental synchronization behavior for valid cursors;
- current legacy graph projection;
- semantic journal event allocation safety;
- the iterator semantic-effect contract.

It does not preserve forensic replay, payload history, or high-level operation grouping for history whose raw semantic events have themselves been compacted away.

## Compacted representation

Canonical compaction retains:

1. one `JournalHeader`;
2. one `NodeJournalSummary` per represented semantic node;
3. one current changed-node marker per represented semantic node;
4. stored source cursors, one bounded record per known source;
5. at most a bounded implementation-defined raw history tail consisting of small operation records and low-level semantic events, which canonical size analysis may take to be empty.

Historical raw semantic events whose effects are represented by these records may be deleted. Operation records and operation references which only group deleted raw semantic events may be deleted with them.

Compaction does not synthesize a giant high-level `compiled` list. If an un-compacted low-level event retains an `operation` reference, the corresponding small operation record must remain available in the same retained history tail or the grouping reference must be removed as part of the same compaction rewrite.

A retained operation record may have an optional `parent` reference. If compaction discards that parent operation record, it may clear the retained child's `parent` field rather than retaining an unbounded ancestry solely for historical grouping. Parent links have no semantic role.

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

High-level operation IDs/records never participate in this fold.

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

`localOperationCounter` is retained only as local high-level-history allocation state. It has no causal or authority meaning.

## Changed-node index compaction

The incremental change index contains one live marker per represented node:

```text
(lastLocalChange(K), K)
```

When K changes at a later local semantic sequence q, compaction/live authoring removes its old marker and inserts `(q,K)`.

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
- semantic local sequence coordinates;
- node `lastLocalChange` coordinates;
- receiver-local stored source cursor coordinates.

Therefore a cursor whose source relationship was valid before compaction remains valid afterward.

Controlled reset is different in two ways:

- resetting a source changes that source's journal incarnation, invalidating cursors about it;
- resetting a receiver explicitly deletes that receiver's stored cursors about all other sources, because the receiver no longer satisfies their incorporated-state invariant.

## Iterator semantic-effect theorem

Let P be a valid cursor and S a fixed committed source snapshot head in the same incarnation.

Let `History(P,S]` be the original un-compacted local low-level semantic events in that interval, and let `Delta(P,S]` be the compacted iterator output defined by the API specification: the current node summary for every node whose current changed-node marker is in `(P,S]`.

High-level operation records are intentionally irrelevant to this theorem because they carry no synchronization semantics.

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

After successful consumption, the iterator advances through S even when some or all historical semantic events were removed and the returned delta is empty.

## Future synchronization theorem

For any supported state A, canonical compaction `C(A)`, and any future supported sequence T consisting of local graph operations, resets, and full/incremental synchronizations:

```text
observe(run(A,T)) == observe(run(C(A),T))
```

where `observe` includes the converged legacy graph and Journal 2 semantics promised by the intent records, but excludes optional high-level operation grouping for raw history removed by compaction.

Sketch:

- current semantic heads are preserved exactly;
- current invalidation frontiers are preserved exactly;
- the only certificate ever considered is preserved exactly;
- current value/event contexts used by safety tests are preserved exactly;
- losing state cannot become winning without a genuinely new greater authority;
- causal allocation safety is preserved by the retained header semantic summary/counter;
- changed-node markers preserve every valid cursor's semantic suffix;
- no future operation requires an old payload because the journal never promises one;
- operation records/IDs do not participate in any of the above semantic rules.

Thus old raw history is observationally redundant for synchronization.

## Size bound

Use the intent-record variables:

- N = represented semantic nodes;
- R = represented durable authors;
- H >= 2 = upper bound on represented semantic event/counter magnitudes and local operation-counter magnitudes;
- serialized NodeKey size is bounded;
- maximum direct in-degree is bounded;
- author IDs, `MigrationId`, `OperationTag`, and other fixed tags have bounded size.

One sequence/counter coordinate costs `O(log H)` bits.

One `CausalPrefix` costs:

```text
O(R log H) bits
```

A `NodeJournalSummary` contains only a constant number of causal/frontier vectors plus a bounded number of input ValueIds, so:

```text
size(NodeJournalSummary) = O(R log H) bits
```

There are O(N) node summaries and O(N) changed-node markers. Markers cost only `O(log H)` bits plus bounded NodeKey storage. The header costs `O(R log H)` including the additional scalar `localOperationCounter`. Source cursors contribute at most `O(R log H)` when there is at most one stored cursor per durable source identity.

A canonical compacted journal may take its raw history tail to be empty. Any implementation which retains a bounded raw tail retains only individually bounded operation/event records; that optional bounded tail does not change the asymptotic compacted-state bound.

Therefore:

```text
size(compacted journal) = O(N R log H) bits
```

No term depends linearly on historical semantic-event count, high-level operation count, number of synchronizations, number of resets, or database age except through `log H`.

## Per-LevelDB-value bound

No persisted journal value may contain a collection proportional to N, total dependency edges, or historical event/operation count.

The largest allowed values are bounded node summaries/semantic events/header vectors:

```text
O(R log H) bits
```

A source-bearing `OperationRecord` may now contain one source `CausalPrefix` in addition to a constant number of bounded primitive fields/NodeKeys and sequence-bearing references such as `OperationId`, source incarnation/head, and optional parent. Therefore:

```text
size(OperationRecord) = O(R log H) bits
```

in the worst case, still exactly within the required per-LevelDB-value bound. Non-source operation records remain smaller.

Graph-wide indexes and high-level-operation expansions are represented as many small LevelDB records rather than one giant map/list value.

## Compaction publication

Compaction may rewrite only the new journal sublevel. It must not change the representation or semantic contents of existing graph sublevels.

When compaction requires inactive-replica construction/cutover under the database lifecycle, the cutover must preserve atomic graph/journal consistency and must not expose a compacted journal paired with a different legacy graph snapshot.
