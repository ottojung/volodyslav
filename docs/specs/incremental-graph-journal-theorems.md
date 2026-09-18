# IncrementalGraph Journal 3 Correctness Laws

## Purpose

These are proof obligations for implementation, tests, bounded models, and review. Optimized replay/index/checkpoint implementations are valid only when observationally equivalent.

## Law 1: deterministic replay

For one supported well-formed Journal J under one compatible current schema/version, `project(J)` has one unique semantic result independent of arrival order, wall time, randomness, transport ancestry, computor execution, or mutable graph bytes.

## Law 2: graph/Journal equality

At every supported committed boundary:

```text
semanticGraph(database.graph) == semanticGraph(project(database.journal))
```

including ordinary operations, sync, reset, bootstrap/migration, absent restoration, and rebuild.

## Law 3: local emission preservation

For every supported ordinary graph transition `G -> G'`, emitted Journal records produce `project(J') == G'`.

## Law 4: no-event no-change

An operation with no persisted semantic transition and no semantic records leaves Journal/projection unchanged.

## Law 5: event contexts are causally closed cuts

For semantic `F=(W,q)`:

```text
F.context[W] == q - 1
```

and every included semantic predecessor E satisfies:

```text
E.context <= F.context
```

componentwise. Therefore `happenedBefore` is transitive.

The narrow pre-Journal historical-value conversion rule may omit canonical foreign coordinates so upgrade read order does not invent legacy causality; the context actually stored remains closed.

## Law 6: authority extends causality

```text
happenedBefore(E,F) => authorityCompare(E,F) < 0
```

## Law 7: reference causality

Every ValueId reference names a ValueEvent in the referencing event's causal past and for the expected semantic node. This includes validation targets/bases, `value(V)` invalidations, and `proof(V,D)` barriers.

## Law 8: compatible prefix union

For mutually compatible same-version causally closed prefix Journals, immutable prefix union is idempotent, commutative, and associative. Same-ID disagreement is a fork.

## Law 9: established local writer history does not roll back

The established-writer rollback boundary is defined normatively by `database-lifecycle.md` §5; ordinary synchronization behavior is defined by `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the source is unsupported state.

The proof obligation is that supported lifecycle transitions never decrease an established local writer head/allocator state and that operations obey those owned failure rules rather than inventing a same-writer rollback-recovery transition.

## Law 10: absent-state restore preserves continuing writer identity safely

When the local database is completely absent and the installation recovery source returns continuation-safe snapshot S:

```text
localWriter_after_restore == S.localWriter
```

The writer head, allocator watermark, authority high-water, Journal, and projection are restored before new authoring.

For `S.localWriter = A` and `S.frontier[A] = q`, continuation safety means no previously-authored `A:r`, `r > q`, can later enter supported retained history after the restore. Records lost only with the completely destroyed local database do not violate this when the supported backend model guarantees that no surviving copy can later reintroduce them.

Definite absence alone permits fresh identity generation. Read/continuation-safety uncertainty must not fall back to fresh creation.

## Law 11: synchronization compatibility comes from one held snapshot

Version/schema, frontier, and records used by synchronization/reset belong to one immutable `JournalSnapshot`. Earlier mutable metadata cannot authorize a later incompatible snapshot.

## Law 12: synchronization projection law

After compatible foreign-prefix union plus required normalization produces Jfinal:

```text
receiverJournal = Jfinal
receiverGraph   = project(Jfinal)
```

Imported records retain their exact identity/body.

## Law 13: repeat synchronization is a no-op

With no intervening state change, synchronization against an already incorporated unchanged source authors no new semantic records and changes no projection.

## Law 14: zero-frontier sync is not absent restore

An already-established receiver with frontier zero may use ordinary synchronization for foreign histories. A fully absent installation uses the receiver-less restoration lifecycle instead.

## Law 15: dependency-closure normalization

Every supported published projection is dependency-closed under current schema. If union selects value K while a required direct input is absent, synchronization authors explicit DeleteEvents over the selected dependent closure.

Input-version disagreement with all required inputs still present is not by itself deletion authority: cached K remains a legitimate `oldValue` and proof/freshness determine its stale state.

## Law 16: certificate selection uses effective proof

Certificate selection is defined normatively by `incremental-graph-journal-replay.md` §Certificate selection. The proof obligation here is that implementations choose exactly that deterministic replay-selected certificate, including the effective-proof and value-invalidation-coverage behavior defined there.

## Law 17: one-certificate positive proof

Every current positive validity edge comes from one selected current certificate. Replay never combines positive entries from different certificates into synthetic proof.

Negative proof-edge barriers may independently subtract edges from that selected certificate.

## Law 18: node invalidation clearing is causal

A node-scoped invalidation is genuine direct/explicit node invalidation. It remains effective against certificates that did not causally observe it, independent of ValueId. Total authority alone never clears it.

## Law 19: occurrence scopes are distinct

For occurrence V of node K:

- `value(V)` records persistent stale freshness for V without directly removing incoming proof;
- `proof(V,D)` retires only incoming proof edge `D -> K` for V until a validation causally observes that barrier and re-proves D.

Both stop applying when another ValueId becomes selected. Neither is interchangeable with node scope.

## Law 20: concurrent proof-edge barriers compose

Let the selected certificate for V contain proof edges E.

For every uncovered `proof(V,D)` barrier, D is removed from that certificate's effective basis. Therefore multiple concurrent barriers produce:

```text
effectiveEdges = E - union(barrieredInputs)
```

Consequences:

- two independent equivalent migrations weakening V to the same partial proof retain that partial proof after synchronization;
- independent removals of different edges compose to their intersection;
- unrelated edges are not destroyed;
- barriers for V never taint replacement V2.

## Law 21: maintenance proof weakening is edge-specific

If reset/migration/bootstrap preserves V but target validity removes edge `D -> K`, maintenance authors:

```text
Invalidate(K, scope=proof(V,D), reason=...)
```

unless another semantic operation already makes that edge impossible for an independent reason.

A weaker ValidateEvent alone is insufficient because older stronger positive proof could otherwise win.

True migration `invalidate(K)` remains node-scoped.

## Law 22: maintenance persistent staleness survives upstream Unchanged

For selected certificate C define:

```text
selfProofReady(K) iff
    C exists
    and effectiveBasisMatchCount(K,C) == numberOfDirectInputs(K)
    and coversValueInvalidations(K,C)
```

If target state stores K stale while `selfProofReady(K)` is true, final history contains an uncovered `value(currentValueId(K))` marker unless one already exists—even when K is currently stale only through an input.

Therefore a later upstream `Unchanged` cannot freshen K without K itself validating/recomputing.

## Law 23: canonical bootstrap source decision

Before pre-Journal bootstrap, the cohort source yields exactly:

```text
Exists(CanonicalBootstrapSnapshot)
DefinitelyAbsent
IndeterminateOrError
```

Definite absence permits first creation only under source arbitration semantics. Indeterminate/error fails without competing creation.

## Law 24: canonical bootstrap artifact is the original cut

The canonical artifact contains exactly records through the creator frontier immediately after bootstrap and before post-bootstrap Journal operations. A later current `JournalSnapshot` containing that prefix is not a substitute.

## Law 25: bootstrap is semantic identity over persisted legacy state

The supported pre-Journal -> Journal bootstrap journals the already-persisted graph without running ordinary semantic migration first. It preserves existing materialized NodeKeys, NodeIdentifiers, payloads, timestamps, freshness, validity, graph interpretation, and allocator watermark.

If reaching the proposed bootstrap target requires semantic/time/allocator-dependent migration, the automatic bootstrap transition is unsupported.

## Law 26: bootstrap creator resume is exact and non-authoring

When local pre-Journal fingerprint equals `artifact.creatorWriter`, creator-resume directly compares persisted legacy semantics with `project(artifact)`. Equality installs exactly artifact history and reconstructs writer state without new semantic records. Mismatch is `JournalBootstrapForkError`.

## Law 27: bootstrap join does not invent legacy causality

A joining legacy occurrence which did not observe the canonical occurrence remains concurrent with it even though bootstrap code reads the artifact. Its conflict authority derives from persisted legacy `modifiedAt`, not upgrade time.

## Law 28: exact-shared bootstrap validity is conservative intersection

For an exact occurrence V shared by canonical and joining legacy state:

```text
JoinedValid(K) = CanonicalValid(K) intersect JoiningValid(K)
```

Canonical certificate remains the positive basis. For every canonical edge D absent from joining proof, bootstrap authors `proof(V,D)`. Joining-only proof never strengthens the shared occurrence.

## Law 29: exact-shared bootstrap freshness is conservative union of stale evidence

For exact shared V:

```text
joinedStale(V) = canonicalStale(V) OR joiningStale(V)
```

An uncovered value-scoped bootstrap invalidation remains/gets authored after proof-edge barriers when required. A fresh joining copy cannot clear canonical stale evidence.

## Law 30: bootstrap persists recursive-only staleness

After direct bootstrap proof/stale roots, every selected K whose own effective proof is complete but which is stale through a direct input receives an uncovered current-value bootstrap invalidation. Later upstream `Unchanged` therefore cannot silently freshen K.

## Law 31: canonical identity guarantee is limited to canonical-equal occurrences

Exact canonical-equal occurrences reuse canonical ValueIds. Local-only occurrences may receive joining-writer bootstrap ValueIds; canonical-only materializations are not deleted merely because joining cache lacks them.

Independent late joiners may assign distinct ValueIds to the same non-canonical occurrence; `$id-1635227135166767` accepts the resulting possible dependent staleness.

## Law 32: bootstrap compatibility is bounded

A canonical artifact is usable only when its version/schema exactly equal the running release's supported bootstrap target. Journal 3 does not require arbitrary future releases to preserve every historical bootstrap decoder/entry path.

## Law 33: representation migration is total and replica-independent

For every retained source-format record R and fixed source->target migration definition:

```text
rewriteJournalRecord(R)
```

is deterministic from R and the migration definition, independent of selection, callback traversal, mutable replica state, or which other records happen to be retained.

The rewrite domain is **all retained source-version history**, including records for node families absent from target schema. If no deterministic target representation exists for some retained record, migration fails `JournalVersionCompatibilityError` before cutover.

## Law 33a: NodeKey transport preserves semantic-node identity

For a supported source->target format codec, let `SourceNodeKeyDomain(sourceVersion)` be every distinct valid canonical semantic NodeKey which may occur in supported source-version Journal history, including keys not retained by the replica currently migrating. For all `Ks1`, `Ks2` in that domain:

```text
Ks1 != Ks2
    => rewriteNodeKey(Ks1) != rewriteNodeKey(Ks2)
```

This injectivity law belongs to the codec definition itself and is independent of replica-local retained history. A local migration may detect an observed collision and fail `JournalVersionCompatibilityError`, but a successful local scan does not establish this distributed law. Without global injectivity, two independently migrated replicas could collapse different historical semantic nodes onto one target key and later merge them incorrectly.

Let `GconvertedBefore = transportProjectionThroughCodec(Gbefore,...)`. Semantic migration repair operates in this target-keyed view: if `Kt = rewriteNodeKey(Ks)`, an occurrence-preserving decision at Kt obtains the same ValueId that Gbefore selected at Ks. A pure key-representation change therefore creates neither a replacement ValueEvent nor a DeleteEvent for Ks.

## Law 34: Journal-aware representation-only change uses codec + keep

The whole-history codec is the sole source of target representation bytes. A selected occurrence whose semantic meaning survives uses `keep`, preserving ValueId. No second value-producing representation decision exists in the Journal-aware migration vocabulary. Semantic-repair bookkeeping is performed in the codec-transported target key space rather than by indexing source-keyed `Gbefore` with target NodeKeys.

## Law 35: migration preserves occurrence identity when occurrence survives

`keep`, `invalidate`, schema/proof/freshness-only changes, and representation-only format rewrite preserve selected ValueId when semantic occurrence survives.

A new ValueEvent is reserved for genuine create/replace occurrence changes.

## Law 36: independent genuine replacement migrations are allowed

Replicas may independently author distinct ValueIds for genuinely replaced occurrences. Later synchronization selects by normal authority and may stale dependents naming a losing replacement. This accepted behavior does not require one canonical migration participant.

## Law 37: migration equivalence

For:

```text
Jconverted = rewriteJournalFormat(Jbefore,...)
Jafter = Jconverted + required semantic migration records
```

all pre-existing IDs/causal/reference meaning are preserved and:

```text
project(Jafter,targetSchema) == Gtarget
```

including exact target validity and persistent freshness behavior.

## Law 38: reset is minimal semantic rebaselining

Let `J0 = union(receiver,source)`, `P0 = project(J0)`, and `PS = project(sourceSnapshot)`.

Reset preserves P0 ValueId when the requested occurrence already matches, creates ValueEvent only when the occurrence itself must change, uses DeleteEvent exactly when target requires absence, repairs removed validity with `proof(V,D)`, and persists target stale flags according to Law 22.

Reset's own-writer-ahead precondition is the one defined in `incremental-graph-journal-reset.md` and the lifecycle boundary in `database-lifecycle.md` §5.

After reset:

```text
semanticGraph(project(Jreset)) == semanticGraph(PS)
```

relative to the history reset observed.

## Law 39: writer stream and writer-state monotonicity

For writer A with head q, committed records are exactly `A:1..q`. Failed transactions consume no durable coordinate. Local writer-state watermark never decreases through supported lifecycle transitions; foreign writer-state records never replace local allocator state.

## Law 40: replay rebuild safety

Valid authoritative Journal rebuilds observationally equivalent derived state without semantic authoring. Invalid authoritative history causes rebuild failure rather than mutation to match damaged graph bytes.

## Law 41: one current format per active replica

Every active replica contains only the representation selected by current `global/version`. Migration rewrites complete retained history before target cutover; ordinary replay/sync performs no mixed-version conversion.

## Law 42: fair-execution synchronization convergence

For finitely many supported replicas and a finite schema DAG, after non-normalization graph-changing operations stop, fair synchronization eventually reaches a finite normalization fixed point, disseminates all actually authored records, yields equivalent projections, and makes further synchronization a semantic no-op.

The law is per actual execution; counterfactual schedules which genuinely authored different normalization histories need not be byte-identical.

## Law 43: host-count bounded settling schedule

The construction and operation-count definition are normative in `incremental-graph-journal-sync.md` §Host-count bounded settling schedule. That construction establishes that every quiescent compatible epoch of H >= 1 participating replicas admits settlement within at most `2(H-1)` state-advancing successful pairwise synchronizations, and therefore within the H^2 achievable bound required by `$id-5631842079463518`.

This law is a proof obligation for that owned synchronization rule; it does not restate the construction.

## Verification ownership

Concrete regression/property coverage is maintained in `incremental-graph-journal-testing.md`. This file states proof obligations only and is not a second regression inventory.
