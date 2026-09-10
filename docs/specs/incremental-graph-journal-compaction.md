# IncrementalGraph Journal 2 Compaction

## Purpose

Journal 2 is conceptually a local ordered history, but retaining every historical event forever is not required. Canonical compaction removes history whose future-relevant meaning is already summarized by bounded journal records.

Compaction is required to preserve:

- future full synchronization behavior;
- future incremental synchronization behavior for valid cursors;
- current legacy graph projection;
- semantic journal event identity/causal/authority allocation safety;
- the iterator semantic-effect contract.

It does not preserve forensic replay, payload history, or high-level operation grouping for history whose raw semantic events have themselves been compacted away.

## Scheduling and uncompacted history

Journal 2 semantics do not assign a deterministic time, event count, or lifecycle transition at which compaction occurs. Canonical compaction may be invoked from time to time at implementation-chosen moments, and every correctness theorem in this document must hold regardless of the exact compaction points chosen.

There is intentionally **no storage-size bound on the uncompacted raw historical layer**. Between compactions, raw semantic events and operation records may accumulate without a fixed bound. The size guarantees in this specification apply to the result of canonical compaction, not to every supported committed journal state before compaction. See `$id-8247698182975014`.

Volodyslav's concrete operational policy is separate from Journal 2 semantics: its existing hourly periodic job attempts canonical compaction once per hourly-job execution, as specified in `periodic-jobs.md` and required by `$id-2399748558090155`. Scheduler downtime or other timing effects therefore change when compaction actually happens without changing journal meaning.

## Compacted representation

A canonically compacted state retains:

1. one `JournalHeader`, including local counters, `causalSummary`, and `authorityClock`;
2. one `NodeJournalSummary` per represented semantic node/key, including retained absent/tombstoned keys;
3. one current changed-node marker per represented semantic node/key;
4. stored source cursors, one bounded record per known source;
5. the exact derived reverse structural-edge index for the current materialized graph, one bounded record per materialized dependency edge;
6. optionally, a bounded implementation-defined raw history tail consisting of small operation records and low-level semantic events; canonical size analysis may take this tail to be empty.

The optional bound in item 6 constrains only the raw tail deliberately retained **after a compaction has completed**. It does not impose a bound on the amount of raw history that may have accumulated immediately before that compaction.

Historical raw semantic events whose effects are represented by these records may be deleted. Historical operation records may also be deleted once their grouping value is no longer worth retaining.

The reverse structural-edge index is current derived acceleration state rather than historical state. Canonical compaction preserves it unchanged; maintenance of that index belongs to graph/journal publication as specified in `incremental-graph-journal-api.md` and `incremental-graph-journal-locking.md`.

Compaction does not synthesize a giant high-level `compiled` list.

`operation` and `parent` are historical-only references with no role in folding, authority, projection, synchronization, compaction correctness, or causality. Compaction may delete an `OperationRecord` while a retained event or child operation still names it. A reader which encounters a reference to a missing operation record treats that historical grouping edge as unavailable; such a dangling historical reference is not unsupported state.

## Node-summary canonicalization

This section defines the canonical content of the retained node summary. Live authoring and synchronization already maintain this content on every publication; compaction does not recompute or rewrite node summaries.

For each NodeKey K, the retained canonical summary represents all historical/adopted authority and synchronization-relevant metadata according to these rules:

- retain the greatest semantic head authority by `authorityCompare` over its `EventRef`;
- retain the componentwise maximum node-wide invalidation frontier;
- if the head is present with V, retain only metadata scoped to V;
- retain the componentwise maximum current-value invalidate frontier;
- retain only the greatest certificate naming V by certificate EventRef authority;
- retain the exact immutable context and `authorityTime` of the current `ValueRef` and certificate event;
- if the head is present, retain the materialization-lineage `createdAt` carried by that selected head; if the head is absent, retain no `createdAt`;
- retain the latest local changed-node sequence.

Canonical compaction MUST NOT stop representing an already represented semantic key merely to reduce the represented-key domain. In particular, a tombstoned/absent key keeps its `NodeJournalSummary` and current changed-node marker. Removing such a key is a distinct reclamation optimization, not canonical compaction, and is permitted only when a separate correctness argument proves that no negative authority required against any supported delayed replica can be lost. Host liveness alone cannot supply that proof under `$id-4719065396881648`.

Lower semantic heads, certificates for losing values, lower certificates for the current value, and value-specific invalidations for permanently losing values are not future candidates under Journal 2 semantics and need not remain as raw history after compaction. Creation-time metadata belonging only to a losing or absent head is likewise not retained as part of the current summary.

High-level operation IDs/records never participate in this canonical summary.

## Why one certificate is sufficient

Projection and synchronization define the canonical certificate for a current ValueId to be the greatest certificate EventRef before compaction is considered.

Therefore lower certificates have no semantic role in an uncompacted journal. Removing them cannot turn a later merge from one valid certificate choice into another; that alternative choice never existed in Journal 2 semantics.

This design avoids an `O(R)` certificate antichain whose own causal vectors would produce an `O(NR²)` storage term.

## Why losing values need no payload/history

Semantic head authority is totally ordered by immutable EventRef authority. Once a node summary retains head H, a lower competing head can never become the selected head merely because some third state is observed later.

A genuinely later value is a new authority and can defeat H directly. It does not need the discarded losing value to remain stored.

If synchronization determines that the current winning present head cannot remain materialized because dependency closure fails, it authors a tombstone after joining the observed candidate causal/authority high-water state. The tombstone is therefore greater than the observed winning authority before the payload is deleted. Hence the journal never needs hidden payload storage to prevent an older value from resurrecting after structural removal.

Mixed cache/input provenance does not require deletion: a surviving present cache remains ordinary stale `oldValue` when its final inputs no longer match its certificate basis.

## Invalidation compaction

### Node-wide invalidations

Node-scoped explicit invalidation can affect a future current value whose validation did not observe it. Therefore the canonical summary retains the greatest represented writer-local invalidating sequence for every represented author:

```text
nodeInvalidateFrontier[A]
```

These are vector-clock coordinates, not cross-writer conflict-precedence numbers. They remain even after current values change or the node becomes absent.

### Value-scoped invalidations

Value-specific invalidations can affect only their named ValueId. Once that ValueId is not the current semantic head and cannot become current again under total head authority, its value-specific frontier need not remain as raw history.

For the current value, repeated invalidates by one author collapse to one greatest writer-local coordinate in `valueInvalidateFrontier`.

## Causal/authority header compaction

`causalSummary` is already a componentwise maximum and is retained exactly.

`authorityClock` is the scalar HLC high-water mark of all authored/observed semantic authorities and is also retained exactly. This is required so a future local event can advance beyond an authority time whose raw event has been compacted away.

The two fields remain the same coupled high-water summary required by J2-INV-7. Compaction does not lower or independently rewrite either field merely because corresponding raw events are discarded.

Raw event contexts/authority times can be discarded when no retained semantic reference needs their exact immutable metadata. The exact context and authority time of the current `ValueRef` and current certificate remain embedded in those retained refs.

`localJournalCounter` is retained as the writer-local event identity/change-index coordinate. It is not inflated by remote causal coordinates.

`localOperationCounter` is retained only as local high-level-history allocation state. It has no causal or authority meaning and remains monotone across controlled reset.

## Changed-node index compaction

The incremental change index contains one live marker per represented node/key:

```text
(lastLocalChange(K), K)
```

Whenever K's synchronization-relevant semantic summary changes at a later local semantic sequence q, including a retained `createdAt` change, live authoring removes its old marker and inserts `(q,K)` atomically with that publication. Compaction leaves the current marker unchanged.

This coalesces arbitrarily many semantic-summary changes while preserving the implication needed for incremental correctness:

```text
K's synchronization-relevant semantic summary changed after P
    => lastLocalChange(K) > P
```

Both q and P are coordinates in this source writer's local sequence. No historical marker list is required. Projection-only freshness/validity changes caused by another node's semantic change do not create a marker for K; the changed input's marker is sufficient for the receiver to revisit the dependent closure. A `createdAt` change is different because `createdAt` is retained directly in K's semantic summary and is observable through `getCreationTime()`.

## Cursor preservation

Canonical compaction does not change:

- writer fingerprint;
- journal incarnation;
- writer-local semantic sequence coordinates;
- node `lastLocalChange` coordinates;
- causal summary coordinates;
- authority-clock high-water mark;
- retained present-head `createdAt` values;
- receiver-local stored source cursor coordinates;
- the derived reverse structural-edge index.

Therefore a cursor whose source relationship was valid before compaction remains valid afterward.

Lifecycle transitions which intentionally invalidate cursor assumptions are different:

- resetting a source changes that source's journal incarnation, invalidating cursors about it;
- resetting a receiver explicitly deletes that receiver's stored cursors about all other sources, because the receiver no longer satisfies their incorporated-state invariant;
- migrating a receiver whose input already contains Journal 2 explicitly deletes that receiver's stored cursors about all sources, because the post-migration state does not assume the pre-migration incorporated-state invariant remains valid.

The initial pre-Journal-2 bootstrap has no valid Journal 2 cursors to invalidate.

## Iterator semantic-effect theorem

Let P be a valid cursor and S a fixed committed source snapshot head in the same incarnation.

Let `History(P,S]` be the original un-compacted local low-level semantic events in that interval. Let `PossibleMaybeChanges(P,S]` mean the bounded range metadata plus the sequence of current node summaries yielded by the private async iterator for every node whose current changed-node marker is in `(P,S]`.

High-level operation records are intentionally irrelevant to this theorem because they carry no synchronization semantics.

For any supported consumer state which correctly incorporated the source through P:

```text
apply(History(P,S])
```

and

```text
apply(PossibleMaybeChanges(P,S])
```

must produce observationally equivalent journal-derived synchronization state through S.

Reason: every source semantic-summary change after P is folded into the current summary, and any node whose semantic summary changed after P has a latest marker greater than P. This includes a change to retained `createdAt`, so an earlier creation time learned by the source after P is yielded to the consumer rather than hidden behind an unchanged `ValueId`. A node with no semantic-summary change after P contributes no new per-node semantic information beyond what the consumer already incorporated through P. Projection-only consequences of a changed input are rediscovered on the receiver by traversing the reverse structural-edge closure from that changed input. Cross-node causal and HLC high-water metadata are transferred from the header independently of the changed-node iterator.

After successful consumption, the iterator advances through S even when some or all historical semantic events were removed and the async stream yields no changed node.

The theorem concerns the sequence of yielded bounded records, not materialization of that sequence as one collection. Canonical compaction and `possibleMaybeChanges` must remain streamable as required by `$id-4924739474925738`.

## Future synchronization theorem

For any supported state A, canonical compaction `C(A)`, and any future supported sequence T consisting of local graph operations, migrations, resets, and full/incremental synchronizations:

```text
observe(run(A,T)) == observe(run(C(A),T))
```

where `observe` includes the converged legacy graph and Journal 2 semantics promised by the intent records, but excludes optional high-level operation grouping for raw history removed by compaction.

The quantification over T includes arbitrarily delayed synchronization with a state which has not participated for an arbitrarily long time. The theorem does not assume that every known or potentially relevant remote host eventually returns.

A Journal-2-aware migration in T follows the migration specification, including atomic deletion of receiver-local source cursors. Thus compaction cannot cause a stale pre-migration cursor to survive a migration in one execution but not the other.

Sketch:

- current semantic heads and their immutable EventRef authority are preserved exactly;
- current invalidation frontiers are preserved exactly;
- the only certificate ever considered, including its context/authority, is preserved exactly;
- current value and certificate EventRef contexts required by projection and future causal reasoning are preserved exactly;
- current present-head `createdAt` is preserved exactly;
- losing state cannot become winning without a genuinely new greater authority;
- future local event identity safety is preserved by `localJournalCounter`;
- exact causal allocation safety is preserved by `causalSummary`;
- future total-authority allocation safety is preserved by `authorityClock` even when high-authority raw events were compacted away;
- changed-node markers preserve every valid cursor's semantic suffix until a lifecycle transition intentionally deletes those cursors;
- the derived reverse structural-edge index remains the same exact view of the unchanged current materialized graph;
- no future operation requires an old payload because the journal never promises one;
- operation records/IDs do not participate in any of the above semantic rules.

Thus old raw history is observationally redundant for synchronization.

## Liveness-independent worst case

Canonical compaction must satisfy `$id-4719065396881648` and `$id-1762448645994697`.

In particular, the required correctness proof and compacted-size bound may not rely on eventually receiving an acknowledgement from every host which could later present old state. A host may return only after an arbitrarily long delay, may first be encountered only after an arbitrarily long delay, or may never return at all.

Therefore host-liveness/acknowledgement-based reclamation cannot be used to justify the mandatory compacted-state bound or to remove tombstoned negative authority required by the canonical representation. Such reclamation may exist as an optional optimization only when it has an independent proof that no supported reachable state can require the reclaimed authority; the canonical worst-case representation must remain correct and within its stated parameters without it.

## Size bound

This section bounds the **result of canonical compaction**. It deliberately does not bound an arbitrary uncompacted committed journal; `$id-8247698182975014` explicitly accepts unbounded raw historical growth between compactions.

Use the intent-record variables:

- `L` = currently present/materialized represented semantic nodes;
- `T` = retained absent/tombstoned semantic keys whose negative authority remains synchronization-relevant;
- `N = L + T` = complete represented semantic key domain;
- `R` = represented durable authors;
- `H >= 2` = upper bound on represented history-growing writer-local event/operation/incarnation counters and HLC logical components; physical real-time values are fixed-width `O(1)` under `$id-5823796411086523`;
- serialized NodeKey size is bounded;
- maximum direct in-degree is bounded;
- author IDs, `MigrationId`, `OperationTag`, and other fixed/bounded primitive tags have bounded serialized size.

One history-growing sequence/counter/HLC-logical coordinate costs `O(log H)` bits. A physical real-time coordinate costs `O(1)` bits under `$id-5823796411086523`.

One `CausalPrefix` costs:

```text
O(R log H) bits
```

A retained `AuthorityTime` costs `O(log H)` bits overall: its physical component is `O(1)` and its logical component is `O(log H)`. A retained `CreationTime` is one fixed-width physical-time scalar and costs `O(1)` bits.

A `NodeJournalSummary` contains only a constant number of causal/frontier vectors plus a bounded number of input ValueIds and constant-many authority timestamps, plus at most one `CreationTime`, so:

```text
size(NodeJournalSummary) = O(R log H) bits
```

There are O(L + T) node summaries and O(L + T) changed-node markers. Markers cost only `O(log H)` bits plus bounded NodeKey storage. The header costs `O(R log H)` including `causalSummary`, `authorityClock`, and scalar local counters. Source cursors contribute at most `O(R log H)` when there is at most one stored cursor per durable source identity.

The reverse structural-edge index contains one constant-size record for every materialized structural edge. Bounded direct in-degree gives at most O(L) such edges even when one input has unbounded out-degree, so the entire reverse index costs O(L) bits under the bounded-NodeKey assumption. This is subsumed by `O((L + T) R log H)` because a writable Journal 2 database has at least one represented writer and `H >= 2`.

A canonical compacted journal may take its raw history tail to be empty. Any implementation which retains a bounded raw tail in the compacted result retains only individually bounded operation/event records; that optional bounded tail does not change the asymptotic compacted-state bound.

Therefore:

```text
size(compacted journal) = O((L + T) R log H) bits
                        = O(N R log H) bits.
```

The bound is independent of the number of historical semantic events, validations, invalidations, synchronizations, resets, and repeated changes **for a fixed retained represented key/author domain**, except through `log H`.

It is deliberately not stated as independent of historical unique-key churn: T may increase when new keys are created and later require retained tombstones/negative authority. This is part of the pessimistic worst-case accounting rather than hidden history dependence.

## Per-LevelDB-value bound

No persisted journal value may contain a collection proportional to N, total dependency edges, or historical event/operation count.

The largest allowed values are bounded node summaries/semantic events/header vectors:

```text
O(R log H) bits
```

A source-bearing `OperationRecord` may contain one source `CausalPrefix`, one `AuthorityTime`, and a constant number of bounded primitive fields/NodeKeys and sequence-bearing references such as `OperationId`, source incarnation/head, and optional parent. Therefore:

```text
size(OperationRecord) = O(R log H) bits
```

in the worst case, still exactly within the required per-LevelDB-value bound. Non-source operation records remain smaller.

Each reverse structural-edge index entry contains only a bounded pair of NodeKeys and bounded marker data, so it is O(1) and therefore within the `O(R log H)` per-value bound. The optional `CreationTime` inside a present node summary is likewise one fixed-width `O(1)` physical-time scalar under `$id-5823796411086523`, so it does not change that per-value bound.

Graph-wide indexes and high-level-operation expansions are represented as many small LevelDB records rather than one giant map/list value.

The per-LevelDB-value bound applies equally before and after compaction. Unbounded uncompacted journal size is permitted only through an unbounded **number** of individually bounded records, never through one unbounded record.

## Compaction publication

Compaction modifies only the historical part of the new journal sublevel and must not change the representation or semantic contents of existing graph sublevels, `JournalHeader`, node summaries, changed-node markers, the derived reverse structural-edge index, or stored source cursors.

Compaction is not a seventh database lifecycle transition and does not require inactive-replica construction or lifecycle cutover. Each batch runs against the current active database in IncrementalGraph `daytime` mode and under the ordinary per-replica commit serialization specified in `incremental-graph-journal-locking.md`.

For each implementation-bounded batch, `daytime` mode and commit serialization are acquired before candidate selection and held through the atomic historical prune commit. Candidates are selected only from records already committed and historical in that same current active replica. The batch then releases both before the next batch is selected.

No candidate set is carried across a lifecycle cutover or database close. If the active replica is replaced or closed between batches, the remaining compaction work is abandoned and a later attempt re-selects from the then-current active replica.

Because compaction does not rewrite semantic summaries, markers, headers, the reverse structural-edge index, cursors, or legacy graph state, it cannot publish a journal summary paired with incompatible graph state. A failure may leave earlier prune batches committed; those intermediate states are semantically equivalent supported states, and a later compaction attempt may continue from the remaining history.
