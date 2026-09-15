# IncrementalGraph Journal 3 Correctness Laws

## Purpose

This document collects proof obligations for implementations, tests, bounded models, and code review.

The laws are semantic. Optimized indexes/checkpoints/incremental folds are allowed only when observationally equivalent to these rules.

## Law 1: deterministic replay

For one supported well-formed causally closed journal J under one compatible current database/schema interpretation:

```text
project(J) = P
```

has one unique semantic result.

Replay does not depend on arrival order, wall time, randomness, computor execution, transport ancestry, or mutable graph bytes used as a second authority.

## Law 2: graph/journal equality at supported commit boundaries

For every supported committed database C:

```text
semanticGraph(C.graph)
    == semanticGraph(project(C.journal))
```

including after ordinary operations, synchronization, reset, bootstrap/migration, and projection rebuild.

## Law 3: local emission preservation

For every supported ordinary graph transition `G -> G'`, if emission appends the records required by the emission specification to J, yielding J', then:

```text
project(J') == G'
```

## Law 4: no-event no-change

If an API operation produces no persisted semantic graph transition and emits no semantic records:

```text
J' == J
project(J') == project(J)
```

## Law 5: event contexts are causally closed cuts

For semantic event F=(W,q):

```text
F.context[W] == q - 1
```

and every context coordinate is retained.

For every semantic event E included by F's context:

```text
E.id.sequence <= F.context[E.id.author]
```

F must include all of E's observations:

```text
for every writer A:
    E.context[A] <= F.context[A]
```

Therefore:

```text
happenedBefore(E,F) && happenedBefore(F,G)
    => happenedBefore(E,G)
```

A journal whose contexts violate this transitive-closure property is unsupported.

## Law 6: authority extends causality

For supported semantic events E and F:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

This covers same-writer order, cross-writer context observation, same-publication references, and maintenance events authored after observed frontiers.

## Law 7: reference causality

Every ValueId reference denotes historical evidence in the referencing event's causal past.

For ValidateEvent C:

```text
happenedBefore(valueEvent(C.value), C)
```

and for every known basis entry B:

```text
happenedBefore(valueEvent(B.value), C)
valueEvent(B.value).node == B.input
```

For value-scoped invalidation I:

```text
happenedBefore(valueEvent(I.scope.value), I)
```

## Law 8: compatible prefix union

For mutually compatible same-version causally closed prefix journals:

```text
union(J,J) = J
union(J,K) = union(K,J)
union(union(J,K),L) = union(J,union(K,L))
```

Overlap disagreement is a fork, not a graph merge conflict.

## Law 9: exact-prefix same-writer recovery

If local A is `A:1..p` and source A is agreeing `A:1..q`, q>=p, importing `A:(p+1)..q` is valid restoration. New A records begin strictly after q.

Any overlapping disagreement fails.

## Law 10: absent-state restore preserves continuing writer identity

When no local database exists and the configured installation recovery source supplies a stable snapshot S for this installation:

```text
localWriter_after_restore == S.localWriter
```

and restored writer head/allocator/projection/history are reconstructed before any new local authoring.

Failure to query/read known synchronized installation state must not fall back to generation of a fresh writer identity.

Fresh fingerprint generation is allowed only after the recovery source definitively reports absence.

## Law 11: synchronization compatibility comes from one held snapshot

Ordinary synchronization with held source S requires:

```text
S.databaseVersion == receiver.databaseVersion
S.graphSchemeString == receiver.graphSchemeString
```

where compatibility fields, frontier, and records belong to the same immutable source state.

A compatibility result from another mutable read is insufficient.

## Law 12: synchronization projection law

After compatible prefix union and required normalization produce Jfinal, successful sync commits:

```text
receiverJournal = Jfinal
receiverGraph   = project(Jfinal)
```

Imported source records retain exact identity/body.

## Law 13: repeat synchronization no-op

With no intervening state change, resynchronizing against the same incorporated source yields:

```text
changed = false
no new semantic records
same projection
```

## Law 14: full sync is zero-frontier sync

An already-established receiver whose retained frontier is zero uses the same suffix-transfer/validation/normalization/replay algorithm as any later synchronization. There is no distinct semantic full-sync merge algorithm.

A completely absent installation with no local writer identity is not this case; it first uses the receiver-less restoration/fresh-creation lifecycle.

## Law 15: dependency-closure normalization

A supported published projection is dependency-closed under the current schema.

If union selects a value whose required input is absent, synchronization authors explicit semantic absence authority over the required dependent closure rather than hiding the value as a latent current cache.

## Law 16: certificate selection prefers causal invalidation coverage

For current K and eligible certificate C define:

```text
basisMatchCount(K,C)
```

as usual and:

```text
coversValueInvalidations(K,C)
    = no current-ValueId value-scoped invalidation remains
      outside C's causal past
```

Replay selects exactly one eligible certificate maximizing lexicographically:

```text
1. basisMatchCount
2. coversValueInvalidations   (true > false)
3. authority
```

Thus a concurrent greater-clock certificate cannot beat an equally matching certificate which causally covers the current occurrence's invalidation.

## Law 17: one-certificate proof soundness

Every current validity edge `D -> K` comes from the one selected current certificate for K and a basis entry exactly naming current `valueId(D)`.

Replay never combines edges from multiple certificates into synthetic proof.

## Law 18: node invalidation clearing is causal

A node-scoped invalidation I remains effective against validation C unless:

```text
happenedBefore(I,C)
```

Total authority alone never clears an invalidation.

## Law 19: value-scoped invalidation follows one occurrence

A value-scoped invalidation affects only its named ValueId while that occurrence is selected.

Changing selected ValueId ends its current effect but does not delete the historical invalidation.

## Law 20: persistent input-staleness normalization

After raw sync union/dependency closure, suppose selected current K has selected certificate C such that:

```text
basis exactly matches every selected direct input ValueId
coversValueInvalidations(K,C) == true
some direct input is stale
```

Then final sync history contains an uncovered value-scoped invalidation for current `valueId(K)`.

This applies whether K's ValueId was already local or newly selected from the source.

Later unchanged revalidation of the input must not freshen K without K itself revalidating/recomputing.

## Law 21: canonical pre-Journal bootstrap identity

For a synchronization cohort crossing from legacy storage to Journal 3, equivalent shared legacy state is represented by one canonical semantic bootstrap history.

Other installations joining that cohort retain the canonical bootstrap ValueIds/certificates verbatim while preserving their own local writer fingerprint and local allocator watermark.

They must not independently mint semantically equivalent bootstrap ValueEvents and expect ordinary synchronization to reconstruct shared occurrence identity later.

If a joining legacy graph is not observationally equivalent to the canonical bootstrap target, automatic canonical join fails until an explicit legacy reconciliation/rebaseline/import decision is made.

## Law 22: bootstrap projection equivalence

For canonical accepted legacy graph G:

```text
semanticGraph(project(bootstrap(G)))
    == semanticGraph(G)
```

including materialization, identifiers, payloads, timestamps, freshness, and validity.

Each installation separately preserves/reconstructs its own local allocation watermark.

## Law 23: migration preserves unchanged value occurrences

For Journal-aware migration from Jbefore/Gbefore to Gtarget:

if migration keeps K's semantic value occurrence unchanged—same selected NodeIdentifier, payload, createdAt, and modifiedAt—then:

```text
targetValueId(K) == valueId_Gbefore(K)
```

Schema/proof/freshness change alone does not create a new ValueEvent.

New ValueEvents are reserved for actual create/replace/transform occurrence changes.

## Law 24: migration proof/freshness may change independently of ValueId

Migration may author a new ValidateEvent for a preserved ValueId when target schema/proof differs, and may author a value-scoped InvalidateEvent when target freshness requires it.

Therefore:

```text
proofChanged || freshnessChanged
```

does not imply:

```text
valueIdChanged
```

## Law 25: semantic migrations creating occurrences are canonical per cohort

If a source->target migration creates/replaces value occurrences, replicas expected to synchronize after migration must retain one canonical semantic migration history for their reconciled source state rather than independently minting equivalent new ValueIds.

Representation-only / occurrence-preserving migration may be independently performed because shared ValueIds remain shared.

## Law 26: migration equivalence and representation preservation

For:

```text
Jconverted = rewriteJournalFormat(Jbefore,...)
Jafter = Jconverted + required semantic migration records
```

pre-existing IDs/causal/reference meaning are preserved and:

```text
project(Jafter,targetSchema) == Gtarget
```

Future replay does not run historical migration callbacks.

## Law 27: reset is minimal semantic rebaselining

Let:

```text
J0 = union(receiver, source)
P0 = project(J0)
PS = project(sourceSnapshot)
```

Reset:

- preserves P0's selected ValueId for K when P0 already has the same observable immutable occurrence fields as PS;
- authors a new ValueEvent only when K's semantic value occurrence must change;
- authors a DeleteEvent exactly when P0 currently has a value but PS requires absence;
- repairs proof/freshness with ValidateEvent/InvalidateEvent without replacing values unnecessarily.

After reset:

```text
semanticGraph(project(Jreset)) == semanticGraph(PS)
```

and repeated already-satisfied reset may author nothing.

## Law 28: writer sequence contiguity and writer-state monotonicity

For writer A with head q:

```text
records(A) == A:1..q
```

with no durable holes.

Failed transactions consume no durable coordinate.

`WriterStateRecord.lastNodeIndex` is nondecreasing in one writer stream, and foreign writer-state records never replace the local writer's allocator watermark.

## Law 29: replay rebuild safety

If authoritative J is valid, rebuilding all derived graph/index state yields an observationally equivalent projection without changing J.

If J is invalid, rebuild fails rather than mutating history to match damaged graph bytes.

## Law 30: one current format per active replica

Every active replica contains only the record representation selected by its current `global/version`.

A format migration deterministically rewrites each old record preserving ID/meaning before target cutover. Ordinary replay/sync performs no mixed-version per-record conversion.

## Law 31: fair-execution synchronization convergence

For finitely many supported replicas and a finite schema DAG, after non-normalization graph-changing operations stop, fair synchronization eventually reaches a finite normalization fixed point, disseminates all actually authored records, yields equivalent projections, and makes further sync a semantic no-op.

The law is per actual execution; counterfactual schedules which authored different real normalization records need not have identical outcomes.

## Suggested implementation verification

At minimum exercise/model:

- every ordinary emission case;
- context transitivity, own-prefix closure, and authority extension;
- concurrent values and causal overwrite;
- node invalidation concurrent with validation;
- competing full-basis certificates where only one covers current-value invalidation;
- partial-basis certificate selection;
- selected-remote-occurrence stale propagation followed by upstream `Unchanged`;
- dependency deletion closure and repeat sync;
- stable snapshot version/schema race;
- exact same-writer recovery and fork rejection;
- absent-state restore vs fresh creation decision;
- canonical multi-host bootstrap with shared A->B ValueIds;
- migration preserving ValueIds for unchanged values;
- canonical semantic migration when new occurrences are created;
- minimal reset preserving unchanged occurrences and changing proof only where needed;
- deterministic whole-journal format rewrite;
- rebuild from Journal only;
- malformed future/concurrent references;
- malformed transitive contexts.

A bounded executable model is strongly encouraged because these laws quantify over causal/event interleavings.
