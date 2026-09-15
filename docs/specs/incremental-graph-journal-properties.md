# IncrementalGraph Journal 3 Algebraic Properties

## Purpose

Journal 3 deliberately separates three layers which have different algebraic behavior:

1. retained-information union within one compatible current database format/schema snapshot;
2. the graph projection/normalization built over that information; and
3. whole-database format migration, which deterministically re-encodes retained history while preserving journal identities and historical meaning.

This distinction prevents implementation code from assuming that because raw same-version history union is a simple semilattice-like operation, every projected graph transition or cross-version migration is automatically the same kind of merge.

## Compatibility boundary before same-version algebra

Ordinary synchronization/reset first obtains one held source `JournalSnapshot` and requires exact compatibility:

```text
snapshot.databaseVersion == receiver.databaseVersion
snapshot.graphSchemeString == receiver.graphSchemeString
```

The snapshot's compatibility metadata and journal records belong to one immutable committed source cut.

Only after this check succeeds do the same-version retained-information relations below apply. Journal 3 does not define ordinary cross-version/cross-schema union by silently interpreting one side through the other's metadata.

## Same-version retained-information partial order

For two compatible retained journals J and K already encoded under the same current `global/version` and exact current `global/graph_scheme`, define:

```text
J <= K
```

iff for every writer A:

```text
frontierJ[A] <= frontierK[A]
```

and every record retained by J has exactly the same canonical current-format meaning in K.

Thus K extends J only by retaining later immutable writer suffixes.

If overlapping record content differs, J and K are not comparable/compatible under this relation; that is a writer fork/corruption condition.

This relation is intentionally not used directly to compare the physical source and target replicas of a database-format migration, because those replicas use different canonical representations.

## Information join

For compatible causally closed prefix journals J and K at one current database version/schema:

```text
J join K = immutable prefix union
```

with frontier:

```text
frontier[A] = max(frontierJ[A], frontierK[A])
```

provided all actual records through those coordinates are retained and overlap agrees.

This join is:

```text
J join J = J
J join K = K join J
(J join K) join L = J join (K join L)
```

for mutually compatible histories.

The join never rewrites a record. Cross-version/schema peers migrate first; ordinary synchronization does not define a join between incompatible persisted interpretations.

## Replay is deterministic, not a join-homomorphism requirement

Journal 3 requires:

```text
project(J)
```

to be deterministic.

It does **not** require:

```text
project(J join K)
```

to equal a simple fieldwise join of `project(J)` and `project(K)`.

For example, union can:

- select a different ValueEvent head;
- invalidate an old certificate basis;
- reveal a node-scoped invalidation concurrent with a validation;
- select a new remote occurrence which is stale because one of the receiver's selected inputs is stale;
- require synchronization-authored structural deletion normalization.

These are resolved by Journal 3 semantic replay/normalization, not by combining legacy graph fields algebraically.

## Monotonicity of retained information

Within one current database version/schema, normal synchronization, ordinary local authoring, and reset are monotone in retained history:

```text
Jbefore <= Jafter
```

They append/import history; they do not remove authoritative historical facts.

A semantic migration also retains all historical facts, but a format-changing database migration first maps their physical representation into the target version. Therefore source-format Jbefore and target-format Jconverted are related by the migration-preservation law rather than by the same-version `<=` relation.

Projection is not monotone in graph presence/value terms:

- a later DeleteEvent may make a node absent;
- a later ValueEvent may replace the selected payload;
- a later invalidation may make a node stale.

This is expected. Information growth can describe semantic deletion/change.

## Event authority versus information order

The retained-information order says whether one same-version replica knows a superset of history.

`authorityCompare` says which competing semantic event wins for a node.

They are distinct concepts.

A journal containing more history is not globally "more authoritative" as one scalar object. It simply contains more facts from which deterministic replay selects current heads/proofs.

## Causal relation versus total authority

`happenedBefore` is a partial causal relation.

`authorityCompare` is a total conflict-precedence relation extending that causal relation.

For concurrent events:

```text
not happenedBefore(E,F)
not happenedBefore(F,E)
```

but exactly one of:

```text
authorityCompare(E,F) < 0
authorityCompare(F,E) < 0
```

holds for distinct supported EventRefs.

This deterministic order does not turn concurrency into historical causality.

Consequently, causal rules such as "validation covers invalidation" use `happenedBefore`, not merely total authority ordering.

## Normalization is semantic authoring, not a pure join

Synchronization may append receiver-authored semantic records required to make newly combined history obey the existing IncrementalGraph state-transition rules.

Core normalization records are:

- `DeleteEvent(reason="sync")` for structural dependency-closure removal; and
- value-scoped `InvalidateEvent(reason="sync")` for persistent staleness of the selected current occurrence when its own exact matching proof is sound but a direct input is stale.

The stale marker is about the **post-union selected ValueId**, not about whether that ValueId was already selected on the receiver. A newly selected imported occurrence is subject to the same rule.

An extra marker is unnecessary when the selected occurrence is already persistently stale because of its own uncovered value invalidation, a node invalidation, or a current-basis mismatch. Those causes are not merely recursive input freshness.

These are ordinary historical events after commit. They are not temporary merge annotations and are not retracted when later unseen concurrent history arrives.

Therefore define normalization operationally over one actual receiver execution rather than pretending it is a pure mathematical function only of an eventual raw history set.

For an unchanged receiver/history state, normalization has the fixed-point property:

```text
normalize(normalizedState, sameSourceFacts)
    = normalizedState
```

meaning no semantically redundant acknowledgement/delete/invalidation chain is authored merely by receiving the same facts again.

## Convergence is not counterfactual confluence

The immutable imported-record union is order-independent.

Synchronization-authored normalization is different because the synchronization call itself is a graph-changing historical operation.

Two counterfactual executions may observe sources in different orders and therefore commit different real normalization events before all concurrent positive facts are known. Journal 3 does **not** require those counterfactual executions to have byte-identical histories or identical final projections.

The required property is execution convergence:

> For every one supported fair execution, once non-normalization graph-changing operations stop, normalization eventually stops, all actually authored records disseminate, all replicas become observably equivalent, and further synchronization is a semantic no-op.

This is the same distinction as ordinary application history: two executions in which the user really called `invalidate()` at different times are not required to end identically merely because some earlier value history was the same.

## Why normalization terminates after quiescence

After non-normalization graph-changing operations stop, synchronization normalization never creates a new `ValueEvent` or `ValidateEvent`.

It can only add negative state transitions:

```text
sync DeleteEvent
sync value-scoped InvalidateEvent
```

For deletion, a newly authored delete causally/authoritatively defeats the already-observed selected value whose structural retention became impossible. Another delete can become necessary only if some previously unseen finite positive history later selects another value occurrence. Normalization itself never creates such a positive occurrence.

For staleness, an uncovered value-scoped invalidation fixes one exact selected ValueId stale, whether that ValueId was previously local or newly imported. Normalization cannot clear it because clearing requires a causally later validation, and normalization does not create validations.

With finitely many replicas, finite retained positive history after quiescence, and a finite dependency DAG, only finitely many such new normalization obligations can arise. Fair synchronization therefore eventually reaches a fixed point.

## Reset is not information replacement

Reset does not set:

```text
receiverJournal = sourceJournal
```

Instead, after exact compatibility is established from one held source snapshot:

```text
Jafter = union(Jreceiver, Jsource) + reset baseline
```

so, within the compatible current format/schema:

```text
Jreceiver <= Jafter
Jsource   <= Jafter
```

while projection intentionally becomes source-target-equivalent relative to observed history.

Reset is itself a non-normalization graph-changing operation for the convergence/quiescence statement above.

## Migration preserves history while rewriting representation

A Journal-3-aware database-format migration has two stages:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
Jafter = Jconverted + migration baseline
```

The representation rewrite is a deterministic bijection over the retained record identities of Jbefore: every old `(author,sequence)` remains exactly that identity in Jconverted, with the same historical semantic/causal/reference meaning, but represented in the target version's canonical format.

Consequently:

```text
frontier(Jconverted) == frontier(Jbefore)
historicalMeaning(Jconverted) == historicalMeaning(Jbefore)
```

although their physical record bodies need not be byte-equal and the same-version `<=` relation is not applied across those two representations.

The semantic migration baseline then appends new target-state facts. Old historical facts remain retained even when a new schema no longer selects/materializes their old semantic nodes.

Independently migrating the same old record through the same version transition must produce the same canonical target record so later same-version overlap comparison remains meaningful.

Whole-journal time/I/O for this transformation is an accepted trade-off. Migration is outside post-quiescence synchronization normalization.

## Checkpoint/index state is outside this algebra

Derived checkpoints, indexes, materialized legacy graph sublevels, staging targets, and transport cursors are not elements of the authoritative retained-history order.

They may be created/deleted/rebuilt without changing journal historical meaning.

A format-changing migration may rewrite or discard/rebuild their representation as part of constructing the target-version replica.

Correctness always reduces back to retained historical journal facts plus deterministic current interpretation.
