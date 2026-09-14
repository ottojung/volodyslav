# IncrementalGraph Journal 3 Algebraic Properties

## Purpose

Journal 3 deliberately separates two layers which have different algebraic behavior:

1. immutable retained-information union; and
2. the graph projection/normalization built over that information.

This distinction prevents implementation code from assuming that because raw history union is a simple semilattice-like operation, every projected graph transition is automatically a CRDT merge.

## Retained-information partial order

For two compatible retained journals J and K, define:

```text
J <= K
```

iff for every writer A:

```text
frontierJ[A] <= frontierK[A]
```

and every record retained by J has exactly the same canonical meaning in K.

Thus K extends J only by retaining later immutable writer suffixes.

If overlapping record content differs, J and K are not comparable/compatible under this relation; that is a writer fork/corruption condition.

## Information join

For compatible causally closed prefix journals J and K:

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

The join never rewrites a record.

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
- make a receiver-only dependent stale;
- require synchronization-authored structural deletion normalization.

These are resolved by Journal 3 semantic replay/normalization, not by combining legacy graph fields algebraically.

## Monotonicity of retained information

Normal synchronization, ordinary local authoring, reset, and migration are monotone in retained history:

```text
Jbefore <= Jafter
```

They append/import history; they do not remove authoritative records.

Projection is not monotone in graph presence/value terms:

- a later DeleteEvent may make a node absent;
- a later ValueEvent may replace the selected payload;
- a later invalidation may make a node stale.

This is expected. Information growth can describe semantic deletion/change.

## Event authority versus information order

The retained-information order says whether one replica knows a superset of history.

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
- value-scoped `InvalidateEvent(reason="sync")` for persistent fresh-to-stale propagation.

These are ordinary immutable events after commit. They are not temporary merge annotations and are not retracted when later unseen concurrent history arrives.

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

For staleness, an uncovered value-scoped invalidation fixes one exact ValueId stale. Normalization cannot clear it because clearing requires a causally later validation, and normalization does not create validations.

With finitely many replicas, finite retained positive history after quiescence, and a finite dependency DAG, only finitely many such new normalization obligations can arise. Fair synchronization therefore eventually reaches a fixed point.

## Reset is not information replacement

Reset does not set:

```text
receiverJournal = sourceJournal
```

Instead:

```text
Jafter = union(Jreceiver, Jsource) + reset baseline
```

so:

```text
Jreceiver <= Jafter
Jsource   <= Jafter
```

while projection intentionally becomes source-target-equivalent relative to observed history.

Reset is itself a non-normalization graph-changing operation for the convergence/quiescence statement above.

## Migration is not history rewriting

Similarly:

```text
Jafter = Jbefore + migration baseline
```

and the current target schema interprets the new baseline as current state.

Old events remain immutable historical facts even when a new schema no longer selects/materializes their old semantic nodes.

Migration is also outside post-quiescence synchronization normalization.

## Checkpoint/index state is outside this algebra

Derived checkpoints, indexes, materialized legacy graph sublevels, staging targets, and transport cursors are not elements of the authoritative retained-history order.

They may be created/deleted/rebuilt without changing J.

Correctness always reduces back to retained immutable history plus deterministic current interpretation.
