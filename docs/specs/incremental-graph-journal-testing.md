# IncrementalGraph Journal 3 Testing Strategy

## Purpose

Journal 3 correctness depends on interleavings, causal relationships, migration identity, and replay equivalence which are easy to under-test with only example integration tests.

This document specifies the minimum verification categories expected from an implementation. Exact framework/tooling is implementation-defined.

## Reference replay oracle

Maintain one deliberately straightforward implementation/model of `project(J)` which favors clarity over production performance. Optimized projection/index code is checked against this reference over generated/bounded histories.

## Local operation differential tests

For each ordinary graph operation:

1. begin from a supported graph+journal pair;
2. execute the existing graph transition;
3. capture emitted journal records;
4. independently replay resulting journal;
5. compare replay projection with committed graph state.

Cover first materialization, changed value, `Unchanged`, cache revalidation, explicit invalidation, transitive stale propagation, deletion, and concurrent transaction finalization.

Every ordinary ValidateEvent test asserts the basis contains exactly one entry per current distinct direct input NodeKey, uses no `"unknown"`, names finalized current input ValueIds, and is serialized in canonical persisted NodeKeyString order.

## Causal-context closure tests

Reject:

```text
A:1
B:1 context={A:1}
C:1 context={B:1,A:0}
```

and same-writer omission:

```text
A:1 context={X:1}
A:2 context={A:0,X:0}
```

Generated tests assert transitivity of `happenedBefore` and happened-before implies increasing authority.

The bootstrap historical-conversion exception is tested separately: a joining legacy ValueEvent may omit canonical foreign coordinates, but its actual context must still have exact own-prefix and be transitively closed over every coordinate it includes.

## Interleaving/model exploration

Generate small acyclic schemas and short histories across 2–3 writers. Explore concurrent value changes, causal chains, validation concurrent with invalidation, multiple validations, partial bases, value-scoped invalidation with covering/concurrent validations, remote delete/value conflicts, and propagated stale transitions.

For every supported generated journal assert deterministic replay and `incremental-graph-journal-theorems.md`.

## Certificate-selection regression

Fixture:

```text
current occurrence V of K
inputs unchanged

R2: I = Invalidate(K,scope=value(V))
R2: C2 = Validate(K,value=V,full current basis), causally after I

R1 concurrently:
    C1 = Validate(K,value=V,same full basis)
    C1 has greater authority than C2
    C1 does not observe I
```

Expected C2 wins because `coversValueInvalidations` is consulted before authority.

## Prefix-union property tests

For compatible generated writer histories assert idempotence, commutativity, and associativity of immutable prefix union. Overlap conflicts are rejected rather than semantically merged.

## Stable source compatibility tests

A `JournalSnapshot` binds compatibility metadata to the same frozen source state as frontier/records.

Tests assert exact persisted version/schema, snapshot stability, mismatch failure before cutover, and that an earlier mutable metadata read cannot authorize a later incompatible snapshot.

## Synchronization fixed-point tests

For generated receiver/source pairs, synchronize twice against unchanged source and assert the second operation authors no records and changes no projection.

Include the critical newly-selected-remote-occurrence case:

```text
A -> B
common: A=a1 fresh
source Y: B=b2 fresh, validated against A=a1
receiver X: A=a1 stale
```

After sync B=b2 remains persistently stale even if A later revalidates `Unchanged`, until B itself validates/recomputes.

## Synchronization convergence tests

For 2–4 replicas, generate disconnected local changes, stop non-normalization changes, synchronize in varying fair orders, and continue to fixed point. Each actual schedule must converge internally; counterfactual schedules need not author identical normalization histories.

## Same-writer recovery tests

Cover exact empty->prefix restoration of an already-known Journal writer, shorter->longer exact catch-up, allocator/high-water reconstruction, continued authoring after recovered head, overlap disagreement failure, and no re-authored duplicates.

This suite does not substitute for canonical-bootstrap creator-resume, where local state is still pre-Journal and no active Journal prefix exists.

## Absent-installation restoration tests

Startup with no local database tests:

1. configured installation recovery source exists -> restore and adopt `snapshot.localWriter`;
2. source definitely absent -> only then generate fresh fingerprint;
3. query/read fails -> startup fails and MUST NOT fall back to fresh creation.

## Reset tests

For generated receiver/source projections assert compatibility from one held snapshot, old history retention, repeated no-op behavior, ValueId preservation when occurrence is unchanged, proof/freshness-only repair without ValueEvent, exact target absence deletion, stale/partial validity reconstruction, and normal treatment of unseen later concurrent history.

### Reset proof-weakening regression

Fixture:

```text
A -> B
receiver/current:
    A=a1
    B=b1
    selected B certificate = {A:a1}

source target:
    same A and B occurrences
    no A->B validity edge
    B stale
```

Expected:

- B keeps its ValueId;
- reset authors node-scoped `Invalidate(B,reason=reset)` before target proof;
- target partial/all-unknown ValidateEvent is after that barrier;
- the old full certificate is ineligible despite greater `basisMatchCount`;
- final replay contains no A->B validity edge.

### Reset persistent propagated-staleness regression

Fixture source target has A stale and B stale with full B proof `{A:a1}`. Receiver reset must preserve B as persistently stale even if B is replaced during Pass 1 and the source's own B marker therefore names another ValueId.

After reset:

1. B has complete own proof;
2. B has an uncovered value-scoped reset invalidation for its final `resetValueId(B)`;
3. later `pull(A) -> Unchanged` may freshen A but MUST NOT freshen B;
4. B becomes fresh only after B validates/recomputes.

Reset remains causally-later target repair; bootstrap join must never reuse this rule for pre-existing divergent legacy values.

## Canonical bootstrap source decision tests

Test three outcomes of configured cohort bootstrap source:

1. immutable compatible artifact exists -> creator-resume or join depending on local fingerprint;
2. source definitely absent -> create canonical bootstrap and freeze artifact before ordinary authoring;
3. query/read failed or indeterminate -> migration fails and authors no canonical history.

A source which cannot arbitrate concurrent first creation must return indeterminate rather than definite absence. Distinct canonical artifacts for one cohort are unsupported.

## Canonical bootstrap artifact tests

For a created artifact assert:

- `bootstrapFrontier` is exactly creator frontier immediately after bootstrap publication;
- reads are bounded to that frontier and do not expose later records;
- `databaseVersion` and `graphSchemeString` are bootstrap target compatibility metadata;
- ordinary Journal authoring cannot begin before artifact is durably established;
- artifact bytes/meaning are immutable while this software release claims support for that target;
- a normal current `JournalSnapshot` containing the prefix is rejected as substitute.

The spec does **not** require a future release to retain this old bootstrap target indefinitely. If artifact version/schema differs from the running release's configured expected bootstrap target, startup fails with `JournalVersionCompatibilityError` before authoring history.

### Creator-resume crash regression

Fixture:

1. legacy creator C receives `DefinitelyAbsent`;
2. C publishes canonical artifact durably;
3. C crashes before local Journal cutover;
4. restart still sees C's pre-Journal database and source now returns `Exists(artifact)`.

Expected when `artifact.creatorWriter == C.fingerprint` and semantic legacy target still equals artifact projection:

- install exactly artifact records as C's local Journal stream;
- author no duplicate bootstrap records;
- reconstruct writer head, `last_node_index`, authority high-water, projection/indexes;
- atomically cut over successfully.

If local legacy target differs, fail `JournalBootstrapForkError` and author nothing. A different fingerprint cannot use creator-resume.

### Post-bootstrap rollback regression

Fixture:

```text
canonical artifact:
    K=v1
creator later:
    K=v2
    create N
late legacy J:
    K=v1
    N absent
```

Expected join against supported frozen artifact:

- J sees only bootstrap cut;
- J reuses canonical ValueId for K=v1;
- J does not create deletion evidence for N;
- post-bootstrap v2/N can enter only through later ordinary compatible synchronization;
- stale upgrade time never makes v1 causally newer than v2.

## Canonical bootstrap legacy-conflict tests

Bootstrap join is a legacy merge, not `project(Jjoined)==Glegacy` reset.

Case 1 — canonical newer value wins:

```text
canonical K: modifiedAt=T2, value=c2
late local K: modifiedAt=T1, value=l1
```

Expected local historical ValueEvent is concurrent with canonical K and canonical c2 remains selected.

Case 2 — late local newer value wins:

```text
canonical K: modifiedAt=T1
late local K: modifiedAt=T2
```

Expected local historical occurrence wins normally.

Case 3 — equal occurrence: no local ValueEvent; canonical ValueId reused.

Case 4 — canonical present/local absent: no bootstrap DeleteEvent; canonical materialization survives.

Case 5 — local present/canonical absent: one local historical ValueEvent; local-only materialization survives.

For a shared exact occurrence stale on either legacy side, test conservative stale preservation without manufacturing another ValueId.

### Non-canonical identity-split trade-off

Canonical C has older K. Late joiners J1 and J2 previously synchronized with each other and both hold the same newer legacy K occurrence, identical in NodeIdentifier/payload/timestamps, but different from canonical K.

Expected:

- J1 and J2 may independently author distinct bootstrap ValueIds for that non-canonical K;
- after their histories synchronize, normal authority chooses one;
- dependent certificates naming the losing bootstrap ValueId may stop matching and those dependents may become stale/recompute;
- this is accepted by `$id-1635227135166767`, not repaired by payload-derived identity or mandatory joiner coordination.

## Bounded bootstrap compatibility tests

A canonical artifact is joinable only if its version/schema exactly equals the running release's configured expected bootstrap target.

Test mismatch fails with `JournalVersionCompatibilityError` before any bootstrap history is authored.

There is no test requiring arbitrary future software to retain an old artifact format or migration chain forever. Recovery of an unsupported historical target belongs to explicitly compatible software/operator lifecycle, not implicit current-version upcasting.

## Migration tests

For every Journal-aware migration:

- rewrite every pre-existing record deterministically into target format preserving IDs and semantic/causal/reference meaning;
- target contains no mixed formats/per-record version tags;
- failure before cutover leaves source active;
- replay target equals migration target;
- historical certificates remain self-describing.

Identity-specific tests:

- `keep` preserves selected ValueId;
- `invalidate` preserves selected cached occurrence ValueId while changing freshness/proof as specified;
- schema/proof/freshness-only migration preserves selected ValueId;
- `create` or genuine semantic replacement creates new ValueEvent/ValueId;
- independently created replacement ValueIds may later stale dependents naming losing occurrence.

### Migration proof-weakening barrier regressions

Case 1:

```text
A -> B
before: B=b1, selected certificate {A:a1}
migration: invalidate(B)
target: B keeps b1, stale, no A->B validity
```

Expected migration authors node-scoped B proof barrier before target partial/all-unknown certificate. Old full certificate becomes ineligible and final replay removes A->B.

Case 2: stale `keep` or `override` whose existing migration semantics discard incoming proofs. The old full certificate must not survive merely because it has larger `basisMatchCount`.

Generated proof-weakening cases assert every removed target validity edge is actually absent from replay.

### Migration propagated-staleness regression

```text
A -> B
initial: A fresh; B fresh with complete {A:a1}
migration: invalidate(A)
target: A stale; B stale by propagated persistent flag; B retains {A:a1}
```

Expected migration authors persistent value-scoped invalidation for B because B's own proof is complete even though replay at migration cut is already stale recursively through A.

After migration, `pull(A) -> Unchanged` freshens A but B MUST remain stale until B validates/recomputes.

## Canonical per-record rewrite and `override()` regressions

Start replicas X and Y which both retain historical V=(A,5) for K, but only X currently selects V; Y has a later replacement.

Run same Journal-aware migration on both.

Expected:

- pure per-record codec rewrites V identically on X and Y;
- selection/non-selection does not affect V's rewritten payload;
- if X calls `override(K, ...)`, callback result equals codec output;
- Y need not call override for historical V for V to be rewritten identically;
- later synchronization produces no `JournalForkError` for V.

Also test two synchronized replicas both selecting V and performing same valid representation-only `override()`: both retain ValueId V and no dependent becomes stale merely because representation changed.

An override callback returning value unequal to pure codec output fails before cutover and never activates divergent V body.

Semantic-changing use of `override()` is rejected.

## Current-format codec tests

For each current database version test golden fixtures, round-trip semantic equality, malformed-field rejection, no per-record version discriminator, rejection of mixed old/new bytes by ordinary replay, and complete explicit format rewrite.

## Corruption tests

Explicitly reject writer gaps, conflicting same-ID bodies, missing context coordinates, transitive context omission, wrong own-writer context, authority not extending causality, bad validation references/bases, illegal ordinary `"unknown"`, future/concurrent value invalidation references, NodeIdentifier collision, decreasing writer-state watermark, graph/journal mismatch, and mixed record formats.

A historical certificate whose explicit input set differs from current schema is not corrupt solely for that reason; it simply is not current-shape-compatible proof.

## Transaction failure tests

Inject failures before/during publication and assert no half graph/journal commit, no durable sequence consumed by failed operation, volatile allocator/cache state does not advance past disk, and failed sync/reset/migration/bootstrap before cutover leaves old active pair selected.

Include the special bootstrap case where artifact publication succeeds but local cutover fails; retry must use creator-resume rather than duplicate canonical creation.

## Performance tests are separate from correctness

Issue #1607 owns future synchronization performance bounds.

Whole-journal representation migration cost is separately accepted. Do not weaken correctness/property tests to achieve an optimization.
