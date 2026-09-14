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

## Replay is a deterministic function, not a join homomorphism requirement

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

## Normalization as append-only closure

Synchronization may compute a normalization operator relative to receiver history:

```text
N_R(J)
```

which appends receiver-authored semantic records required to make J publishable under IncrementalGraph semantics.

The required fixed-point property is:

```text
N_R(N_R(J)) = N_R(J)
```

when no new history is introduced between applications.

Operationally this means repeating synchronization against an unchanged already-incorporated source produces no new normalization records.

Normalization may differ in record identity/order across different receivers because each authors its own required local records. After those records disseminate, deterministic replay must still converge.

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

## Migration is not history rewriting

Similarly:

```text
Jafter = Jbefore + migration baseline
```

and the current target schema interprets the new baseline as current state.

Old events remain immutable historical facts even when a new schema no longer selects/materializes their old semantic nodes.

## Checkpoint/index state is outside this algebra

Derived checkpoints, indexes, materialized legacy graph sublevels, staging targets, and transport cursors are not elements of the authoritative retained-history order.

They may be created/deleted/rebuilt without changing J.

Correctness always reduces back to retained immutable history plus deterministic current interpretation.
