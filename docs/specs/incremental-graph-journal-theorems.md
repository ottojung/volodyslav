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

Pre-Journal legacy-value conversion may deliberately omit canonical foreign coordinates so a historical legacy value remains concurrent with a canonical bootstrap value. This does not weaken the law: the context actually stored on that event must still be a closed cut over every coordinate it includes.

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
Exists(CanonicalBootstrapSnapshot)
DefinitelyAbsent
IndeterminateOrError
```

`Exists` requires join, `DefinitelyAbsent` permits first canonical creation, and `IndeterminateOrError` fails without creation.

The source may report `DefinitelyAbsent` only when that result is suitable for first-creator arbitration. Distinct accepted canonical bootstrap artifacts for one cohort are unsupported.

## Law 22: canonical bootstrap artifact is the original cut

If canonical creator C finishes bootstrap at frontier Fbootstrap, the cohort artifact contains exactly the records through Fbootstrap with the bootstrap target version/schema.

Later ordinary Journal events or later database migrations do not change that artifact.

For every late bootstrap join:

```text
Jc = records through Fbootstrap
```

and no record causally after Fbootstrap may affect bootstrap comparison, local bootstrap ValueEvent context, or bootstrap value conflict authority.

A current JournalSnapshot containing Jc as a prefix is not equivalent to the canonical artifact.

## Law 23: bootstrap join does not invent causal succession

Let Vc be a canonical bootstrap ValueEvent for K and Vl be a genuinely different legacy occurrence for K on a joining installation which did not observe Vc in legacy time.

The converted local bootstrap ValueEvent Vl must not include Vc solely because migration code read the canonical artifact.

Therefore, absent genuine pre-Journal causal evidence:

```text
not happenedBefore(Vc,Vl)
not happenedBefore(Vl,Vc)
```

and conflict authority is the concurrent-value policy seeded by each legacy `modifiedAt` rather than upgrade execution time.

In particular, an older late-host legacy occurrence cannot beat a newer canonical occurrence merely because its conversion was executed later.

## Law 24: bootstrap join preserves shared identity without treating absence as deletion

For an exact equal legacy occurrence on canonical and joining state, join reuses the canonical ValueId and creates no joining ValueEvent.

A local-only legacy materialization may be represented by a joining bootstrap ValueEvent.

A canonical-only materialization is not removed merely because the joining legacy cache lacks it: local absence is not a timestamped DeleteEvent and bootstrap join authors no delete solely for that asymmetry.

The resulting projection need not equal the joining legacy graph where the two legacy states genuinely conflict; normal Journal authority determines the selected occurrence.

## Law 25: bootstrap creator projection equivalence

For canonical accepted legacy graph G:

```text
semanticGraph(project(bootstrap(G))) == semanticGraph(G)
```

including materialization, identifiers, payloads, timestamps, freshness, and validity.

The creator freezes the resulting frontier as the canonical artifact before ordinary Journal authoring begins.

## Law 26: late bootstrap joins at bootstrap target version

A canonical artifact's `databaseVersion` / `graphSchemeString` equal the configured bootstrap target compatibility metadata.

A late legacy host first joins that artifact at the bootstrap target version. If running software requires later versions, it then follows supported Journal-aware migrations in order before ordinary synchronization with current peers.

An artifact with mismatched target compatibility fails before bootstrap history is authored.

## Law 27: migration preserves occurrence identity for occurrence-preserving decisions

For Journal-aware migration, `keep`, `invalidate`, schema/proof/freshness-only change, and semantic-preserving `override()` preserve the selected ValueId when the semantic occurrence survives.

A new ValueEvent is reserved for actual semantic create/replace occurrence changes.

## Law 28: record-format rewrite is replica-independent

For every retained source record R and one source->target database migration definition:

```text
rewriteJournalRecord(R)
```

is a deterministic function of R and that migration definition, independent of whether R is selected, which other records the replica retains, callback order, and mutable replica-local state.

Thus replicas which retain the same historical `JournalRecordId` produce the same target-format body for that ID.

For affected ValueEvents, the payload rewrite is one pure per-record codec applied to selected and historical occurrences alike.

## Law 29: `override()` preserves ValueId but cannot redefine immutable history locally

Suppose source selected occurrence V represents semantic value x using source representation `oldEncoding(x)` and the canonical per-record migration codec maps V to `newEncoding(x)`.

A valid Journal-aware:

```text
override(K, () => newEncoding(x))
```

asserts agreement with that canonical rewrite. Then:

```text
targetValueId(K) == V
semanticValue(target V) == x
```

and V preserves NodeIdentifier, createdAt, modifiedAt, causal identity, authority meaning, and references.

If the override callback result differs from the canonical codec output, migration fails before cutover. It never activates a different body for V.

## Law 30: independent genuine replacement migrations are allowed

If migration genuinely creates/replaces an occurrence, replicas may independently author different new ValueIds.

After later synchronization ordinary authority selects the current occurrence. Dependents whose certificates name a losing replacement may become stale until revalidated/recomputed.

This is accepted and does not require one canonical migration participant.

## Law 31: migration proof/freshness may change independently of ValueId

Migration may author Validate/Invalidate history targeting a preserved ValueId. Therefore proof/freshness change does not imply valueId change.

## Law 32: migration equivalence and representation preservation

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

## Law 33: reset is minimal semantic rebaselining

Let `J0 = union(receiver,source)`, `P0 = project(J0)`, and `PS = project(sourceSnapshot)`.

Reset preserves P0's selected ValueId when P0 already has the same target semantic occurrence, creates ValueEvent only when occurrence must change, authors DeleteEvent exactly when P0 is present and target absent, and repairs proof/freshness without unnecessary value replacement.

After reset `semanticGraph(project(Jreset)) == semanticGraph(PS)`.

This causal-later target-repair law applies to reset and MUST NOT be reused for pre-Journal bootstrap value conflict conversion.

## Law 34: writer sequence contiguity and writer-state monotonicity

For writer A with head q, records are exactly A:1..q with no durable holes. Failed transactions consume no durable coordinate. Local writer-state watermark is nondecreasing; foreign writer-state records never replace local allocator watermark.

## Law 35: replay rebuild safety

Valid authoritative Journal rebuilds observationally equivalent derived state without changing history. Invalid authoritative history causes rebuild failure rather than mutation to match damaged graph bytes.

## Law 36: one current format per active replica

Every active replica contains only the representation selected by current `global/version`. Format migration deterministically rewrites old records preserving ID/meaning before target cutover. Ordinary replay/sync performs no mixed-version conversion.

The frozen canonical bootstrap artifact is not an active replica and may remain in its original bootstrap target representation for late joins.

## Law 37: fair-execution synchronization convergence

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
- frozen canonical bootstrap cut excluding later creator history;
- late bootstrap conflict where newer legacy `modifiedAt` wins without synthetic causality;
- canonical-only materialization not deleted by late-host cache absence;
- bootstrap-target-version join followed by ordinary migration chain;
- pure per-record Journal rewrite independent of selected/non-selected status;
- `override()` assertion against canonical codec output;
- independently migrated genuine replacement occurrences causing allowed downstream staleness;
- minimal reset preserving unchanged occurrences;
- deterministic whole-journal format rewrite;
- rebuild from Journal only;
- malformed future/concurrent references;
- malformed transitive contexts.

A bounded executable model is strongly encouraged because these laws quantify over causal/event interleavings.
