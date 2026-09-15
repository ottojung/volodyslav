# IncrementalGraph Journal 3 Synchronization

## Purpose

Journal 3 synchronization replicates immutable journal history and then materializes the deterministic replay projection.

It does not synchronize by rendering the mutable current graph and does not define a second semantic merge algorithm for a special "full sync" case.

The core operation is always:

```text
open one stable source journal snapshot
verify source compatibility metadata from that same snapshot
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
- a stable, causally closed source snapshot whose compatibility metadata and journal records belong to the same committed source state;
- a valid receiver journal/projection pair;
- exclusive receiver maintenance ownership for the final import/replay/cutover;
- no conflicting content under one `JournalRecordId`.

Participating state is non-adversarial but may be old, interrupted, partially replicated, or offline for arbitrarily long periods.

## Snapshot compatibility cut

The source snapshot carries the exact durable compatibility metadata defined by `incremental-graph-journal-api.md`:

```text
S.databaseVersion
S.graphSchemeString
```

These are the source snapshot's exact `global/version` value and exact persisted `global/graph_scheme` string.

The receiver compares them against its own active committed metadata before interpreting/importing source journal records:

```text
S.databaseVersion == R.databaseVersion
S.graphSchemeString == R.graphSchemeString
```

Both comparisons are exact. In particular, graph-scheme JSON which parses to an equivalent object but differs textually is not compatible because the existing database contract treats the persisted scheme string itself as durable versioned metadata.

The compatibility metadata is frozen together with the snapshot frontier and records. It must not be read before `openSnapshot()` from some independently mutable source state. This prevents a source migration between a compatibility check and the later journal reads from causing the receiver to interpret one database version's journal under another version/schema decision.

A mismatch fails with `JournalVersionCompatibilityError` before active import/cutover. Ordinary synchronization does not migrate or rewrite the source representation.

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

A later unseen/concurrent higher-authority positive history may cause another real graph transition after it is learned. Journal 3 does not retroactively erase a structural deletion which was correctly authored from the receiver's then-observed supported state.

## Tentative replay after closure

Compute:

```text
P1 = project(J1)
```

At this point structural presence is valid, but synchronization must still make propagated staleness durable where ordinary IncrementalGraph semantics require it.

## Normalization phase 2: persist staleness caused by stale inputs

The flag-based IncrementalGraph has an important property:

> Once a cached node is propagated from fresh to stale because a direct input is stale, it stays stale until that node itself is cache-revalidated or recomputed, even if the upstream input later revalidates unchanged.

Raw replay by itself is recursive. A current occurrence can therefore be tentatively stale solely because a direct input is stale, and then become fresh automatically if that input later becomes fresh again. That is not sufficient to reproduce the existing persistent flag transition.

This rule applies to the **selected current occurrence after union/closure**, regardless of whether that `ValueId` was selected on the receiver before synchronization or was newly selected from imported history.

For a present K in P1, let C be its selected current certificate. Define:

```text
selfProofReady(K) iff
    C exists
    and C is eligible under the current schema
    and for every direct input D:
        basisValue(C,D) == P1.valueId(D)
    and there is no uncovered value-scoped invalidation
        for P1.valueId(K) relative to C
```

Certificate eligibility already requires node-scoped invalidations to be causally covered. The exact-basis condition means K is not stale because of a basis mismatch. The no-current-value-invalidation condition means its own history does not already make this occurrence persistently stale.

Synchronization must author a persistent marker for every K satisfying:

```text
K is present in P1
selfProofReady(K)
there exists a direct input D with
    P1.freshness(D) == "potentially-outdated"
```

Such a K is stale **solely through recursive input freshness**. If no explicit marker were added, a later unchanged revalidation of those inputs could make K fresh without K itself being pulled.

The receiver therefore authors:

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

The rule is independent of `Pbefore` and independent of whether `P1.valueId(K)` changed during synchronization.

This directly covers, for example, a newly imported remote B occurrence whose certificate exactly names the receiver's current A occurrence while A is stale on the receiver. B must receive a value-scoped sync invalidation so that a later `Unchanged` validation of A does not make B fresh automatically.

No duplicate marker is authored when current K already has an uncovered applicable value-scoped invalidation: in that case `selfProofReady(K)` is false because the occurrence is already persistently stale in history.

No marker is required merely because K is stale from a basis mismatch or uncovered node-scoped invalidation. Those causes do not disappear merely because an input becomes fresh without K itself validating.

Apply the rule to the complete transitive affected set. P1 already computes freshness recursively, so a stale input may cause each otherwise-self-ready dependent along the current validity/basis chain to require its own marker. In practice an implementation may discover this set through a derived reverse structural-edge index rather than scanning every node; issue #1607 owns the future end-to-end time bound.

Let the resulting history be:

```text
Jfinal
```

## Final replay and validation

Compute:

```text
Pfinal = project(Jfinal)
```

Before cutover, verify at least:

- source snapshot compatibility metadata exactly matched the receiver's current `global/version` and `global/graph_scheme` values;
- retained writer streams are contiguous;
- all overlapping IDs have one meaning;
- every event context is covered by the final frontier;
- selected present heads are dependency-closed;
- selected physical `NodeIdentifier`s are bijective across current materialized nodes;
- every retained record satisfies cross-record/reference-causality rules;
- every validation basis has unique explicit input NodeKeys in canonical NodeKey order;
- every certificate selected as current proof has exactly the current direct-input NodeKey set;
- every selected current occurrence which would otherwise be stale solely through recursive direct-input freshness has an applicable persistent current-value invalidation in Jfinal;
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

Everything after record acquisition—compatibility validation, record validation, normalization, replay, and atomic publication—is the same algorithm.

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

1. the source compatibility metadata came from the same stable snapshot as the imported source records and exactly matched the receiver's active database version/schema metadata;
2. it retains every immutable record retained by R or S;
3. it never changes the body of an imported record;
4. any additional semantic records are receiver-authored normalization justified by the rules above;
5. its materialized graph equals `project(resultJournal)`;
6. repeating synchronization against the same unchanged source after success is a semantic no-op unless another local/remote operation intervened.

The sixth law follows because all source suffixes are already retained and the normalization obligations produced by their first incorporation are already represented in history.

## Convergence and termination

Journal 3 guarantees **convergence of an actual fair execution**, not counterfactual confluence between executions which authored different real normalization events.

Synchronization itself may author semantic `DeleteEvent(reason="sync")` and `InvalidateEvent(reason="sync")` records. Once such a record is committed it is history, just as a locally authored invalidation is history. A different ordering of earlier source observations might have avoided or changed which normalization records were needed; Journal 3 does not erase an already-correctly-authored event merely because later unseen concurrent history changes the current projection.

The required convergence claim is:

> For any finite set of supported replicas, once non-normalization graph-changing operations stop, every fair execution of Journal 3 synchronization eventually reaches a point where no new normalization record is required, all authored records disseminate, all replicas have observably equivalent projections, and further synchronization is a semantic no-op.

Here non-normalization graph-changing operations include ordinary pull/invalidate changes, reset, migration, and any other operation capable of authoring ValueEvent/ValidateEvent or explicit application semantic history.

### Why normalization is finite after quiescence

After that quiescence point, synchronization normalization can author only:

1. `DeleteEvent(reason="sync")`; and
2. value-scoped `InvalidateEvent(reason="sync")`.

It never authors a new `ValueEvent` or `ValidateEvent`.

For structural deletion:

- a sync delete is causally after the selected present head and absent-input history which required it;
- once that delete is retained, those already-observed facts cannot make the same value occurrence current again over that delete;
- another delete for the same node can become necessary only after learning some previously unseen higher-authority positive ValueEvent for that node (or another newly learned finite structural cause);
- after quiescence there are only finitely many such pre-existing positive records across finitely many replicas;
- sync deletes themselves create absence, never a new positive head.

For persistent staleness:

- a sync invalidation names one exact current ValueId, whether that occurrence was previously local or newly selected from imported history;
- once an uncovered value-scoped invalidation for that ValueId is retained, learning only normalization history cannot make that occurrence fresh again;
- clearing it requires a causally later `ValidateEvent`, and normalization never authors validations;
- therefore the same already-observed stale-through-inputs condition cannot generate an acknowledgement/invalidation chain for that occurrence.

Each newly learned finite ordinary record may expose a finite dependent closure in the finite current schema DAG. Consequently only finitely many normalization records can be required after quiescence.

Once that finite closure has been authored, fair synchronization disseminates a finite immutable record set. Every replica then retains the same compatible prefixes, deterministic replay yields the same observable IncrementalGraph projection, and further synchronization authors nothing.

## Delayed and absent replicas

Correctness does not depend on every host participating, acknowledging history, or returning.

A replica may be absent for an arbitrarily long interval and later synchronize by transferring the immutable suffixes it lacks.

No authoritative Journal 3 record is reclaimed merely because known replicas appear to have advanced past it.

## Multi-source synchronization

The core operation is pairwise against one stable source snapshot.

An outer synchronization procedure may process multiple sources sequentially. Each successful source may commit independently. Therefore if source 1 succeeds and source 2 fails, source 1's committed journal/projection changes may remain.

The immutable source-record union itself is independent of source processing order. However, synchronization-authored normalization is real semantic history, so different counterfactual source-processing schedules may author different normalization histories before all source facts are known.

Journal 3 requires every such supported fair execution to converge after its actually authored records disseminate; it does not require two counterfactual executions with different authored normalization records to end in byte-identical history or the same projection.

This distinction is intentional and matches the existing IncrementalGraph rule that a structural deletion or propagated stale transition, once actually committed, is a real state transition rather than a tentative acknowledgement to be retracted later.

## Version boundary

Core Journal 3 synchronization operates only when the source snapshot and receiver active database carry exactly compatible `global/version` and `global/graph_scheme` metadata as defined above.

Cross-version synchronization is not a hidden migration operation. Journal-aware migration is specified separately by `incremental-graph-journal-migrations.md`.

A version/schema mismatch is `JournalVersionCompatibilityError` for this synchronization attempt, not permission to reinterpret records using the receiver's schema.