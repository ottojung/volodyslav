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

For every supported ordinary graph transition `G -> G'`, if emission appends required records yielding J', then `project(J') == G'`.

## Law 4: no-event no-change

If an API operation produces no persisted semantic graph transition and emits no semantic records, journal and projection are unchanged.

## Law 5: event contexts are causally closed cuts

For semantic event F=(W,q):

```text
F.context[W] == q - 1
```

and every context coordinate is retained. For every semantic event E included by F's context, every coordinate of `E.context` is <= corresponding coordinate of `F.context`.

Therefore `happenedBefore` is transitive.

Pre-Journal legacy-value conversion may deliberately omit canonical foreign coordinates so a historical legacy value remains concurrent with canonical bootstrap value. The context actually stored on that event must still be closed over every coordinate it includes.

## Law 6: authority extends causality

```text
happenedBefore(E,F) => authorityCompare(E,F) < 0
```

## Law 7: reference causality

Every ValueId reference denotes historical evidence in referencing event's causal past. Validation target/basis references and value-scoped invalidation references satisfy happened-before and expected node identity.

## Law 8: compatible prefix union

For mutually compatible same-version causally closed prefix journals, immutable prefix union is idempotent, commutative, and associative. Overlap disagreement is a fork, not graph merge conflict.

## Law 9: exact-prefix same-writer recovery

If local A is `A:1..p` and source A is agreeing `A:1..q`, q>=p, importing `A:(p+1)..q` is valid Journal restoration. New A records begin strictly after q. Overlap disagreement fails.

## Law 10: absent-state restore preserves continuing writer identity

When no local database exists and configured installation recovery source supplies stable snapshot S:

```text
localWriter_after_restore == S.localWriter
```

Writer head/allocator/projection/history are reconstructed before new local authoring. Failure to query/read known synchronized state must not fall back to fresh identity generation.

## Law 11: synchronization compatibility comes from one held snapshot

Ordinary synchronization with held source S requires exact version/schema equality, with compatibility fields, frontier, and records belonging to same immutable source state.

## Law 12: synchronization projection law

After compatible prefix union and required normalization produce Jfinal, successful sync commits:

```text
receiverJournal = Jfinal
receiverGraph   = project(Jfinal)
```

Imported source records retain exact identity/body.

## Law 13: repeat synchronization no-op

With no intervening state change, resynchronizing against same incorporated source authors no semantic records and changes no projection.

## Law 14: full sync is zero-frontier sync

An already-established receiver with frontier zero uses same suffix-transfer/validation/normalization/replay algorithm. A fully absent installation is a different receiver-less lifecycle case.

## Law 15: dependency-closure normalization

A supported published projection is dependency-closed under current schema. If union selects a value whose required input is absent, synchronization authors explicit semantic absence authority over required dependent closure.

## Law 16: certificate selection prefers causal invalidation coverage

Replay selects one eligible certificate maximizing lexicographically:

```text
1. basisMatchCount
2. coversValueInvalidations (true > false)
3. authority
```

Thus a concurrent greater-clock certificate cannot beat an equally matching certificate which causally covers current occurrence's invalidation.

## Law 17: one-certificate proof soundness

Every current validity edge comes from one selected current certificate; replay never combines edges from multiple certificates into synthetic proof.

## Law 18: node invalidation clearing is causal

A node-scoped invalidation remains effective unless a validation causally follows it. Total authority alone never clears an invalidation.

## Law 19: value-scoped invalidation follows one occurrence

A value-scoped invalidation affects only its named ValueId while that occurrence is selected. Changing selected ValueId ends its current effect but does not delete history.

## Law 20: persistent input-staleness normalization

After raw sync union/dependency closure, if selected K has a certificate whose basis exactly matches every selected direct input ValueId, covers its value invalidations, but some direct input is stale, final sync history contains an uncovered value-scoped invalidation for current `valueId(K)`.

This applies whether K's ValueId was already local or newly selected from source.

## Law 21: maintenance proof weakening requires an eligibility barrier

Let a maintenance transition preserve current ValueId V of K while changing target incoming validity from `CurrentValid(K)` to `TargetValid(K)`.

If:

```text
CurrentValid(K) - TargetValid(K) != empty
```

then appending only a weaker ValidateEvent is insufficient because certificate selection prefers greater `basisMatchCount` before authority.

Reset/migration MUST first author a node-scoped invalidation for K, then author target proof after it as needed.

Every older certificate predating that barrier is ineligible. Therefore a later partial/all-unknown target certificate can establish exactly the weakened target validity relation.

This law is required for migration `invalidate`, stale `keep`/`override` proof loss, and reset targets with fewer validity edges.

## Law 22: maintenance persistent staleness survives upstream Unchanged

After maintenance proof repair, define for target-present K:

```text
selfProofReady(K) iff
    selected certificate exists
    and basisMatchCount == numberOfDirectInputs
    and coversValueInvalidations
```

If target state stores K stale and `selfProofReady(K)` is true, final maintenance history contains an uncovered value-scoped invalidation for K's final ValueId unless one already exists.

This remains required even when current replay is already stale solely because a direct input is stale.

Therefore later `Unchanged` revalidation of an upstream input cannot make K fresh automatically; K itself must validate/recompute.

## Law 23: canonical bootstrap source decision

Before pre-Journal bootstrap, configured cohort source yields exactly one of:

```text
Exists(CanonicalBootstrapSnapshot)
DefinitelyAbsent
IndeterminateOrError
```

`DefinitelyAbsent` permits first canonical creation; `IndeterminateOrError` fails without creation.

For `Exists(B)`, exact target compatibility is checked first. If `B.creatorWriter` equals local pre-Journal fingerprint, lifecycle uses creator-resume; otherwise ordinary join.

Distinct accepted canonical artifacts for one cohort are unsupported.

## Law 24: canonical bootstrap artifact is original cut

If creator C finishes bootstrap at Fbootstrap, canonical artifact contains exactly records through Fbootstrap with bootstrap target version/schema.

Later ordinary Journal events do not enter that artifact. A current JournalSnapshot containing bootstrap prefix is not equivalent to artifact.

The artifact must remain immutable for software releases which claim support for that bootstrap target, but Journal 3 does not require all future releases to retain historical artifact compatibility forever.

## Law 25: bootstrap creator resume is exact and non-authoring

If pre-Journal local fingerprint W equals artifact.creatorWriter and artifact target is supported, creator-resume is allowed only when:

```text
semanticGraph(project(artifact,W))
    == semanticGraph(local legacy graph interpreted at artifact target)
```

On equality it installs exactly artifact records, reconstructs W head/watermark/high-water/projection, and cuts over without authoring another semantic record.

On inequality it fails `JournalBootstrapForkError` and changes no active state.

A different fingerprint may not use creator-resume.

## Law 26: bootstrap join does not invent causal succession

Let Vc be canonical bootstrap ValueEvent for K and Vl a different legacy occurrence on a joining installation which did not observe Vc in legacy time.

Converted Vl must not include Vc solely because migration code read artifact. Therefore absent genuine pre-Journal causal evidence Vc and Vl are concurrent and conflict authority is seeded by legacy `modifiedAt`, not upgrade time.

## Law 27: canonical identity guarantee is limited to canonical-equal occurrences

For an exact equal legacy occurrence on canonical and joining state, join reuses canonical ValueId and creates no joining ValueEvent.

A local-only materialization may be represented by joining bootstrap ValueEvent. Canonical-only materialization is not deleted merely because joining cache lacks it.

Two independent joiners carrying the same occurrence which differs from canonical cut may author distinct bootstrap ValueIds. Later synchronization may stale dependents naming losing occurrence. This is accepted by `$id-1635227135166767`.

## Law 28: bootstrap compatibility is bounded by running release

Canonical artifact may be used only when:

```text
artifact.databaseVersion   == expectedBootstrapTargetVersion
artifact.graphSchemeString == expectedBootstrapTargetGraphSchemeString
```

for running release.

Mismatch fails `JournalVersionCompatibilityError` before history is authored.

Journal 3 does not require arbitrary future releases to preserve old bootstrap artifact decoder, old legacy conversion, or complete migration chain from historical target. Operator recovery may first use software which explicitly supports that target.

## Law 29: bootstrap creator projection equivalence

For canonical accepted legacy graph G:

```text
semanticGraph(project(bootstrap(G))) == semanticGraph(G)
```

including materialization, identifiers, payloads, timestamps, freshness, and validity.

Creator freezes resulting frontier before ordinary Journal authoring begins.

## Law 30: migration preserves occurrence identity for occurrence-preserving decisions

For Journal-aware migration, `keep`, `invalidate`, schema/proof/freshness-only change, and semantic-preserving `override()` preserve selected ValueId when semantic occurrence survives.

A new ValueEvent is reserved for actual semantic create/replace occurrence changes.

## Law 31: record-format rewrite is replica-independent

For every retained source record R and one source->target migration definition:

```text
rewriteJournalRecord(R)
```

is deterministic function of R and migration definition, independent of whether R is selected, which other records replica retains, callback order, and mutable replica-local state.

Thus replicas retaining same historical JournalRecordId produce same target-format body.

## Law 32: `override()` preserves ValueId but cannot redefine immutable history locally

Suppose selected occurrence V represents semantic x and canonical per-record codec maps V to target representation `newEncoding(x)`.

A valid Journal-aware `override(K, ...)` asserts agreement with that rewrite. Target keeps ValueId V and semantic x. Callback disagreement fails before cutover; it never activates a different body for V.

## Law 33: independent genuine replacement migrations are allowed

If migration genuinely creates/replaces occurrence, replicas may independently author different new ValueIds.

After later synchronization ordinary authority selects current occurrence. Dependents whose certificates name losing replacement may become stale until revalidated/recomputed.

This is accepted and does not require one canonical migration participant.

## Law 34: migration equivalence and representation preservation

For:

```text
Jconverted = rewriteJournalFormat(Jbefore,...)
Jafter = Jconverted + required semantic migration records
```

pre-existing IDs/causal/reference meaning are preserved and:

```text
project(Jafter,targetSchema) == Gtarget
```

The equality includes exact target validity and freshness persistence, not merely current recursive freshness at cutover.

Future replay does not run historical migration callbacks.

## Law 35: reset is minimal semantic rebaselining

Let `J0 = union(receiver,source)`, `P0 = project(J0)`, and `PS = project(sourceSnapshot)`.

Reset preserves P0 selected ValueId when same target semantic occurrence is already selected, creates ValueEvent only when occurrence must change, authors DeleteEvent exactly when P0 present and target absent, and repairs proof/freshness without unnecessary value replacement.

Proof weakening follows Law 21 and persistent target staleness follows Law 22.

After reset:

```text
semanticGraph(project(Jreset)) == semanticGraph(PS)
```

and a target-stale dependent does not become fresh merely because an upstream input later revalidates `Unchanged`.

This causal-later target-repair law applies to reset and MUST NOT be reused for pre-Journal bootstrap value conflict conversion.

## Law 36: writer sequence contiguity and writer-state monotonicity

For writer A with head q, records are exactly A:1..q with no durable holes. Failed transactions consume no durable coordinate. Local writer-state watermark is nondecreasing; foreign writer-state records never replace local allocator watermark.

## Law 37: replay rebuild safety

Valid authoritative Journal rebuilds observationally equivalent derived state without changing history. Invalid authoritative history causes rebuild failure rather than mutation to match damaged graph bytes.

## Law 38: one current format per active replica

Every active replica contains only representation selected by current `global/version`. Format migration deterministically rewrites old records preserving ID/meaning before target cutover. Ordinary replay/sync performs no mixed-version conversion.

A bootstrap artifact is lifecycle source state rather than active replica; its historical representation is relevant only while running software explicitly supports that bootstrap target.

## Law 39: fair-execution synchronization convergence

For finitely many supported replicas and finite schema DAG, after non-normalization graph-changing operations stop, fair synchronization eventually reaches finite normalization fixed point, disseminates all actually authored records, yields equivalent projections, and makes further sync semantic no-op.

The law is per actual execution; counterfactual schedules which authored different real normalization records need not end identically.

## Suggested implementation verification

At minimum exercise/model:

- ordinary emission cases;
- context transitivity, own-prefix closure, authority extension;
- concurrent values and causal overwrite;
- invalidation-aware certificate selection;
- maintenance proof weakening with old stronger certificates;
- maintenance propagated staleness followed by upstream `Unchanged`;
- selected-remote stale persistence;
- dependency deletion closure and repeat sync;
- stable snapshot version/schema race;
- exact same-writer recovery and fork rejection;
- absent-state restore vs fresh creation;
- canonical bootstrap three-way decision;
- creator crash after artifact publication and exact resume;
- creator-resume mismatch rejection;
- frozen bootstrap cut excluding later creator history;
- late bootstrap conflict using legacy `modifiedAt` without synthetic causality;
- independent joiners splitting identical non-canonical occurrence identity;
- bounded bootstrap-version incompatibility;
- pure per-record rewrite independent of selected/non-selected status;
- `override()` assertion against canonical codec output;
- independently migrated genuine replacements causing allowed downstream staleness;
- minimal reset preserving occurrences while weakening proof correctly;
- rebuild from Journal only;
- malformed future/concurrent references and transitive contexts.

A bounded executable model is strongly encouraged because these laws quantify over causal/event interleavings.
