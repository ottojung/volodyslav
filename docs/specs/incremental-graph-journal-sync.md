# IncrementalGraph Journal 3 Synchronization

## Purpose

Journal 3 synchronization replicates immutable journal history and then materializes the deterministic replay projection.

It does not synchronize by rendering the mutable current graph and does not define a second semantic merge algorithm for a special "full sync" case.

The core operation is always:

```text
open one stable source journal snapshot
copy every missing immutable writer suffix
normalize the resulting history when required by IncrementalGraph semantics
project the final causally closed journal
atomically publish journal + projection
```

A receiver with no history simply has a zero frontier. Initial/full synchronization is the same operation starting from zero.

## Semantic API

The pairwise operation is conceptually:

```text
synchronizeFrom(source: JournalSyncSource) -> SyncResult
```

`JournalSyncSource` and the result/error meanings are defined by `incremental-graph-journal-api.md`.

The source abstraction is transport-neutral. Journal 3 requires only one fixed `JournalSnapshot`; it does not require or specify Git branches, remote database tables, HTTP endpoints, publication RPCs, or another backend protocol.

## Preconditions

Synchronization requires:

- an exact compatible Journal 3 record interpretation;
- compatible database version and graph schema for the histories being projected;
- a stable, causally closed source snapshot;
- a valid receiver journal/projection pair;
- exclusive receiver maintenance ownership for the final import/replay/cutover;
- no conflicting content under one `JournalRecordId`.

Participating state is non-adversarial but may be old, interrupted, partially replicated, or offline for arbitrarily long periods.

## Source and receiver frontiers

Let receiver R retain:

```text
FR
```

and let one fixed source snapshot S retain:

```text
FS
```

For every writer A such that:

```text
FS[A] > FR[A]
```

R is missing:

```text
A:(FR[A] + 1) .. FS[A]
```

Synchronization transfers those actual records in ascending writer-local sequence order.

No current-node summary substitutes for the missing history.

## Immutable overlap law

For any writer A and sequence q present on both sides, `(A,q)` denotes one immutable record.

If receiver and source representations disagree on its canonical meaning, synchronization fails with a same-writer-history/fork error.

It must not resolve this disagreement by:

- payload equality;
- event `AuthorityTime`;
- filesystem/Git ancestry;
- source preference;
- receiver preference; or
- inventing a new record identity.

A writer stream is one history, not a mergeable branch namespace.

## Same-writer prefix recovery

Suppose the receiver is writable under local writer A and the source snapshot contains a longer A-authored prefix:

```text
FS[A] > FR[A]
```

If the complete overlap agrees, Journal 3 MAY and normally SHOULD import the missing A suffix just like any other writer suffix.

This is safe because the receiver is an exact prefix of its own immutable history, not a competing continuation. The receiver is under exclusive maintenance ownership while importing it. Before any new A-authored record is allocated, the receiver reconstructs all writer-local allocator state from the recovered A prefix, including:

- the new local journal head;
- local writer-state/`last_node_index` projection;
- observed authority high-water; and
- any other derived local allocator state defined by the journal.

The next local record is allocated strictly after the recovered head.

This rule provides the semantic core of same-writer restoration without creating a separate journal merge algorithm.

Two independently live installations must not intentionally author under the same `DatabaseFingerprint`. Such a clone is outside the supported lifecycle. If both sides contain different content for the same A sequence, the prefix condition fails and synchronization rejects the fork.

## Foreign writer suffixes

For writer B distinct from the receiver writer, R copies missing B records verbatim.

For example:

```text
source record B:73
    -> receiver stores B:73
```

Synchronization does not manufacture:

```text
receiver:912 = Adopt(B:73)
```

merely to acknowledge receipt.

Imported records retain their original causal contexts, authority times, payloads, writer IDs, and record IDs.

## Why one stable source snapshot is enough

A valid source snapshot is already prefix-complete and causally closed.

Therefore, after R imports every missing suffix up to `FS`, the union frontier:

```text
FU = join(FR, FS)
```

contains every causal dependency claimed by either input.

The transport may stream authors in any order into inactive scratch storage, so the staging area may be temporarily incomplete. It must not be exposed as a supported active journal until every required record through FU is present and validated.

No second mutable source read is permitted merely to fetch a payload: a `ValueEvent` already carries its immutable payload and timestamps.

## Information-level journal union

Let:

```text
J0 = union(JR, JS)
```

where overlapping IDs agree.

At the raw retained-information level, immutable prefix union is:

- idempotent;
- commutative;
- associative.

This is a strong simplification over state-summary synchronization: receiving the same record twice has no second semantic effect.

However, `J0` may still need receiver-authored semantic normalization before it is a publishable IncrementalGraph state. Journal union and graph normalization are therefore distinct phases.

## Pre-synchronization projection

Before import, record the receiver's committed projection:

```text
Pbefore = project(JR)
```

This projection is used only to determine which persistent receiver-side freshness transitions synchronization itself causes. It is not a second authority source; it is derived from JR.

## Normalization phase 1: dependency closure

First select the value/delete heads of J0 using ordinary Journal 3 authority.

The legacy IncrementalGraph cannot materialize K if any direct input is semantically absent. If J0 selects a `ValueEvent` for K while some `D in inputEdges(K)` has no selected value head, raw union is not publishable.

Let `RemovalClosure` be the complete structural dependent closure of every such absent dependency among selected present values.

For every K in that closure whose selected head is still a value, the receiver authors:

```text
DeleteEvent {
    node: K,
    reason: "sync"
}
```

These events:

- are causally after the complete imported frontier they normalize;
- use ordinary receiver HLC allocation after observing imported authority;
- are ordered cause-before-dependent in deterministic structural/topological order;
- make structural cache removal explicit history rather than silently hiding a selected value from the graph projection.

After adding these events, call the resulting history:

```text
J1
```

`J1` must have dependency-closed selected present heads.

### Why deletion, not latent omission

The existing graph contract removes a materialization when a required dependency is absent. Keeping K's selected `ValueEvent` as a hidden current cache and allowing it to reappear automatically later would create an `oldValue` path that the ordinary graph never preserved.

Therefore Journal 3 records the structural removal as an actual delete event.

## Tentative replay after closure

Compute:

```text
P1 = project(J1)
```

At this point structural presence is valid, but synchronization must still make receiver-side propagated staleness durable where ordinary IncrementalGraph semantics require it.

## Normalization phase 2: persistent fresh-to-stale transitions

The flag-based IncrementalGraph has an important property:

> Once a cached node is propagated from fresh to stale, it stays stale until that node itself is cache-revalidated or recomputed, even if an upstream stale input later revalidates unchanged.

Raw replay already makes a dependent tentatively stale when its current validation basis no longer matches selected inputs or when a direct input is stale. But for a receiver-only dependent, the imported source may contain no historical propagated invalidation record for that dependent.

Therefore, for every semantic node K satisfying all of:

```text
K is present in Pbefore
K is present in P1
Pbefore.valueId(K) == P1.valueId(K)
Pbefore.freshness(K) == "up-to-date"
P1.freshness(K) == "potentially-outdated"
```

synchronization must ensure that K's fresh-to-stale transition is durably represented.

If J1 already contains an uncovered current-K invalidation which itself keeps K stale, no duplicate local marker is required.

Otherwise the receiver authors:

```text
InvalidateEvent {
    node: K,
    scope: {
        kind: "value",
        value: P1.valueId(K)
    },
    reason: "sync"
}
```

This event records the same freshness-only propagation meaning as ordinary local invalidation propagation: it keeps the current cached occurrence stale without removing its incoming validity edges merely because an upstream node is stale.

Apply this rule to the complete transitive receiver affected set. In practice an implementation may discover it through a derived reverse structural-edge index rather than scanning every node; issue #1607 owns the future end-to-end time bound.

Let the resulting history be:

```text
Jfinal
```

No sync invalidation is authored solely because a node was already stale before synchronization.

No sync invalidation is needed merely because K's selected `ValueId` changed: the selected foreign/local value occurrence and its own validation/invalidation history directly determine the new cached occurrence's state.

## Final replay and validation

Compute:

```text
Pfinal = project(Jfinal)
```

Before cutover, verify at least:

- retained writer streams are contiguous;
- all overlapping IDs have one meaning;
- every event context is covered by the final frontier;
- selected present heads are dependency-closed;
- selected physical `NodeIdentifier`s are bijective across current materialized nodes;
- every selected certificate/basis is structurally well formed;
- all legacy graph invariants required by the IncrementalGraph specs hold in Pfinal;
- `oldValue` safety is not weakened;
- local writer state is at least as advanced as every retained local-writer record requires.

The target graph is exactly the lowering of Pfinal. The old mutable graph is not consulted to repair an inconsistency in Jfinal.

## Synchronization-authored events are real events

Imported history and receiver-authored normalization must remain distinguishable:

```text
imported B:73      -> remains B:73
sync Delete/Invalidate -> new receiver-authored records
```

A receiver-authored synchronization event:

1. observes the complete imported frontier on which it depends;
2. is allocated after the maximum observed authority high-water;
3. consumes the next receiver writer sequence;
4. participates in future ordinary synchronization exactly like any other semantic event.

No acknowledgement/adoption event is generated just for learning foreign history.

## Atomic publication

A synchronization operation may transfer and validate records over a long period into inactive scratch storage.

The active supported database changes only at the final publication boundary.

It must not expose either of these split states:

```text
new journal + old graph projection
old journal + new graph projection
```

The final retained journal, all receiver-authored normalization records, the matching materialized graph projection, and local writer allocator/high-water state become active together.

Failure before cutover leaves the previously active supported receiver unchanged, except for disposable staging data.

## No separate full-sync algorithm

For writer B:

```text
FR[B] = 0
FS[B] = 905
```

means transfer `B:1..905`.

Later:

```text
FR[B] = 900
FS[B] = 905
```

means transfer `B:901..905`.

Everything after record acquisition—validation, normalization, replay, and atomic publication—is the same algorithm.

Correctness therefore does not depend on an incremental cursor theorem distinct from full synchronization. The retained journal frontier itself is the progress state.

## Streamability

Synchronization must be implementable without loading the entire journal or entire missing suffix into RAM.

For each writer, missing records are consumed as an ordered `AsyncIterable` or equivalent stream from the fixed source snapshot.

The receiver may write them immediately to inactive durable staging and maintain only bounded decoding/validation buffers.

Semantic normalization may require derived graph indexes or scratch state. Journal 3 currently imposes no end-to-end asymptotic running-time requirement; issue #1607 owns the future performance contract. The lack of a time bound does not require unbounded in-memory materialization of journal history.

## Pairwise result law

Let:

```text
Sync(R,S)
```

be a successful synchronization result including required receiver-authored normalization.

Then:

1. it retains every immutable record retained by R or S;
2. it never changes the body of an imported record;
3. any additional semantic records are receiver-authored normalization justified by the rules above;
4. its materialized graph equals `project(resultJournal)`;
5. repeating synchronization against the same unchanged source after success is a semantic no-op unless another local/remote operation intervened.

The fifth law follows because all source suffixes are already retained and the normalization obligations produced by their first incorporation are already represented in history.

## Convergence

Assume a finite set of supported replicas and that ordinary graph-changing operations eventually stop.

Fair synchronization disseminates every immutable authored record. Receiver normalization may add finitely many records when newly learned history causes structural deletion or fresh-to-stale propagation.

Normalization is monotone with respect to the condition it repairs:

- a sync delete is causally after the absent dependency history which required structural removal;
- a sync value-scoped invalidation records a specific current occurrence's stale transition;
- receiving another copy of the same causal information does not require another equivalent record.

A conforming implementation must not author acknowledgement chains merely because it learns another receiver's normalization record.

Once all ordinary and normalization records have disseminated, every replica retains the same immutable history and deterministic replay yields observably equivalent IncrementalGraph state. Further synchronization is a semantic no-op.

## Delayed and absent replicas

Correctness does not depend on every host participating, acknowledging history, or returning.

A replica may be absent for an arbitrarily long interval and later synchronize by transferring the immutable suffixes it lacks.

No authoritative Journal 3 record is reclaimed merely because known replicas appear to have advanced past it.

## Multi-source synchronization

The core operation is pairwise against one stable source snapshot.

An outer synchronization procedure may process multiple sources sequentially. Each successful source may commit independently. Therefore if source 1 succeeds and source 2 fails, source 1's committed journal/projection changes may remain.

This preserves the existing lifecycle's partial-success model without weakening the atomicity of any individual source synchronization.

Order of temporary source processing must not determine the final converged result after fair repeated synchronization. The retained-history union is order-independent; any receiver-authored normalization events created in one order are themselves immutable history and must converge under the ordinary replay rules.

## Version boundary

Core Journal 3 synchronization operates only when both histories are interpretable under a compatible current database/schema version.

Cross-version synchronization is not a hidden migration operation. Journal-aware migration is specified separately by `incremental-graph-journal-migrations.md`.

A version mismatch is an incompatibility error for this synchronization attempt, not permission to reinterpret records using the receiver's schema.
