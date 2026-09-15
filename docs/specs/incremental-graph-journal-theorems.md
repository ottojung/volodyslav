# IncrementalGraph Journal 3 Correctness Laws

## Purpose

This document collects proof obligations for implementations, tests, bounded models, and code review.

The laws are semantic. Optimized indexes/checkpoints/incremental folds are allowed only when observationally equivalent to these rules.

## Law 1: deterministic replay

For one supported well-formed causally closed journal J under one compatible current database/schema interpretation, `project(J)` has one unique semantic result.

Replay does not depend on arrival order, wall time, randomness, computor execution, transport ancestry, or mutable graph bytes used as a second authority.

## Law 2: graph/journal equality at supported commit boundaries

For every supported committed database C:

```text
semanticGraph(C.graph) == semanticGraph(project(C.journal))
```

including after ordinary operations, synchronization, reset, bootstrap/migration, and projection rebuild.

## Law 3: local emission preservation

For every supported ordinary graph transition `G -> G'`, if emission appends the required records yielding J', then `project(J') == G'`.

## Law 4: no-event no-change

If an API operation produces no persisted semantic graph transition and emits no semantic records, journal and projection are unchanged.

## Law 5: event contexts are causally closed cuts

For semantic event F=(W,q):

```text
F.context[W] == q - 1
```

and every context coordinate is retained.

For every semantic event E included by F's context, every coordinate of `E.context` is <= the corresponding coordinate of `F.context`.

Therefore `happenedBefore` is transitive. A journal violating this transitive-closure property is unsupported.

## Law 6: authority extends causality

```text
happenedBefore(E,F) => authorityCompare(E,F) < 0
```

## Law 7: reference causality

Every ValueId reference denotes historical evidence in the referencing event's causal past. Validation target/basis references and value-scoped invalidation references must all satisfy happened-before and the expected node identity.

## Law 8: compatible prefix union

For mutually compatible same-version causally closed prefix journals, immutable prefix union is idempotent, commutative, and associative. Overlap disagreement is a fork, not a graph merge conflict.

## Law 9: exact-prefix same-writer recovery

If local A is `A:1..p` and source A is agreeing `A:1..q`, q>=p, importing `A:(p+1)..q` is valid restoration. New A records begin strictly after q. Any overlapping disagreement fails.

## Law 10: absent-state restore preserves continuing writer identity

When no local database exists and the configured installation recovery source supplies stable snapshot S:

```text
localWriter_after_restore == S.localWriter
```

Writer head/allocator/projection/history are reconstructed before new local authoring. Failure to query/read known synchronized state must not fall back to fresh identity generation.

## Law 11: synchronization compatibility comes from one held snapshot

Ordinary synchronization with held source S requires exact version/schema equality, with compatibility fields, frontier, and records belonging to the same immutable source state.

## Law 12: synchronization projection law

After compatible prefix union and required normalization produce Jfinal, successful sync commits:

```text
receiverJournal = Jfinal
receiverGraph   = project(Jfinal)
```

Imported source records retain exact identity/body.

## Law 13: repeat synchronization no-op

With no intervening state change, resynchronizing against the same incorporated source authors no semantic records and changes no projection.

## Law 14: full sync is zero-frontier sync

An already-established receiver with frontier zero uses the same suffix-transfer/validation/normalization/replay algorithm. A fully absent installation is a different receiver-less lifecycle case.

## Law 15: dependency-closure normalization

A supported published projection is dependency-closed under the current schema. If union selects a value whose required input is absent, synchronization authors explicit semantic absence authority over the required dependent closure.

## Law 16: certificate selection prefers causal invalidation coverage

Replay selects one eligible certificate maximizing lexicographically:

```text
1. basisMatchCount
2. coversValueInvalidations (true > false)
3. authority
```

Thus a concurrent greater-clock certificate cannot beat an equally matching certificate which causally covers the current occurrence's invalidation.

## Law 17: one-certificate proof soundness

Every current validity edge comes from the one selected current certificate; replay never combines edges from multiple certificates into synthetic proof.

## Law 18: node invalidation clearing is causal

A node-scoped invalidation remains effective unless a validation causally follows it. Total authority alone never clears an invalidation.

## Law 19: value-scoped invalidation follows one occurrence

A value-scoped invalidation affects only its named ValueId while that occurrence is selected. Changing selected ValueId ends its current effect but does not delete history.

## Law 20: persistent input-staleness normalization

After raw sync union/dependency closure, if selected K has a certificate whose basis exactly matches every selected direct input ValueId, covers its value invalidations, but some direct input is stale, final sync history contains an uncovered value-scoped invalidation for current `valueId(K)`.

This applies whether K's ValueId was already local or newly selected from source.

## Law 21: canonical bootstrap source decision

Before pre-Journal bootstrap, the configured cohort bootstrap source yields exactly one of:

```text
Exists(canonicalSnapshot)
DefinitelyAbsent
IndeterminateOrError
```

`Exists` requires join, `DefinitelyAbsent` permits first canonical creation, and `IndeterminateOrError` fails without creation.

The source may report `DefinitelyAbsent` only when that result is suitable for first-creator arbitration. Distinct accepted canonical bootstrap histories for one cohort are unsupported.

## Law 22: bootstrap join preserves shared identity and local delta

Let canonical history be Jc, joining fingerprint W, canonical projection `Pc = project(Jc,W)`, and joining supported legacy graph Glegacy.

Join retains Jc verbatim and appends only W-authored minimal bootstrap records needed to transform Pc into Glegacy using reset-style Pass 1–3 semantics.

Therefore:

- an occurrence equal between Pc and Glegacy retains its canonical ValueId;
- a locally changed occurrence receives a joining-writer replacement ValueEvent;
- proof/freshness-only differences do not replace equal occurrences;
- `project(Jjoined,W) == Glegacy`.

No other host is required to reconcile, acknowledge, or return.

## Law 23: bootstrap creator projection equivalence

For canonical accepted legacy graph G:

```text
semanticGraph(project(bootstrap(G))) == semanticGraph(G)
```

including materialization, identifiers, payloads, timestamps, freshness, and validity.

## Law 24: migration preserves occurrence identity for occurrence-preserving decisions

For Journal-aware migration, `keep`, `invalidate`, schema/proof/freshness-only change, and semantic-preserving `override()` preserve the selected ValueId when the semantic occurrence survives.

A new ValueEvent is reserved for actual semantic create/replace occurrence changes.

## Law 25: `override()` preserves ValueId across representation rewrite

Suppose source selected occurrence V represents semantic value x using source representation `oldEncoding(x)`, and migration validly applies:

```text
override(K, () => newEncoding(x))
```

Then after deterministic whole-history target-format rewrite:

```text
targetValueId(K) == V
semanticValue(target V) == x
```

while target-format payload representation may differ.

The rewritten V preserves NodeIdentifier, createdAt, modifiedAt, causal identity, and references. No migration ValueEvent is authored merely because representation bytes changed.

## Law 26: independent genuine replacement migrations are allowed

If migration genuinely creates/replaces an occurrence, replicas may independently author different new ValueIds.

After later synchronization ordinary authority selects the current occurrence. Dependents whose certificates name a losing replacement may become stale until revalidated/recomputed.

This is accepted and does not require one canonical migration participant.

## Law 27: migration proof/freshness may change independently of ValueId

Migration may author Validate/Invalidate history targeting a preserved ValueId. Therefore proof/freshness change does not imply valueId change.

## Law 28: migration equivalence and representation preservation

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

## Law 29: reset is minimal semantic rebaselining

Let `J0 = union(receiver,source)`, `P0 = project(J0)`, and `PS = project(sourceSnapshot)`.

Reset preserves P0's selected ValueId when P0 already has the same target semantic occurrence, creates ValueEvent only when occurrence must change, authors DeleteEvent exactly when P0 is present and target absent, and repairs proof/freshness without unnecessary value replacement.

After reset `semanticGraph(project(Jreset)) == semanticGraph(PS)`.

## Law 30: writer sequence contiguity and writer-state monotonicity

For writer A with head q, records are exactly A:1..q with no durable holes. Failed transactions consume no durable coordinate. Local writer-state watermark is nondecreasing; foreign writer-state records never replace local allocator watermark.

## Law 31: replay rebuild safety

Valid authoritative Journal rebuilds observationally equivalent derived state without changing history. Invalid authoritative history causes rebuild failure rather than mutation to match damaged graph bytes.

## Law 32: one current format per active replica

Every active replica contains only the representation selected by current `global/version`. Format migration deterministically rewrites old records preserving ID/meaning before target cutover. Ordinary replay/sync performs no mixed-version conversion.

## Law 33: fair-execution synchronization convergence

For finitely many supported replicas and finite schema DAG, after non-normalization graph-changing operations stop, fair synchronization eventually reaches finite normalization fixed point, disseminates all actually authored records, yields equivalent projections, and makes further sync a semantic no-op.

The law is per actual execution; counterfactual schedules which authored different real normalization records need not end identically.

## Suggested implementation verification

At minimum exercise/model:

- every ordinary emission case;
- context transitivity, own-prefix closure, authority extension;
- concurrent values and causal overwrite;
- node invalidation concurrent with validation;
- competing certificates where only one covers current-value invalidation;
- partial-basis certificate selection;
- selected-remote-occurrence stale propagation followed by upstream `Unchanged`;
- dependency deletion closure and repeat sync;
- stable snapshot version/schema race;
- exact same-writer recovery and fork rejection;
- absent-state restore vs fresh creation decision;
- cohort bootstrap source three-way decision;
- canonical bootstrap join-with-delta with one local changed node;
- `override()` preserving ValueId while representation changes;
- independently migrated genuine replacement occurrences causing allowed downstream staleness;
- minimal reset preserving unchanged occurrences;
- deterministic whole-journal format rewrite;
- rebuild from Journal only;
- malformed future/concurrent references;
- malformed transitive contexts.

A bounded executable model is strongly encouraged because these laws quantify over causal/event interleavings.