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
4. independently replay the resulting journal;
5. compare replay projection with committed graph state.

Cover first materialization, changed value, `Unchanged`, cache revalidation, explicit invalidation, transitive stale propagation, deletion, and concurrent transaction finalization.

Every ordinary ValidateEvent test asserts that the basis contains exactly one entry per current distinct direct input NodeKey, uses no `"unknown"`, names finalized current input ValueIds, and is serialized in canonical persisted NodeKeyString order.

## Causal-context closure tests

Reject this malformed chain:

```text
A:1
B:1 context={A:1}
C:1 context={B:1,A:0}
```

Also reject same-writer omission:

```text
A:1 context={X:1}
A:2 context={A:0,X:0}
```

Generated tests assert transitivity of `happenedBefore` and that happened-before implies increasing authority.

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

Cover exact empty->prefix restoration of an already-known writer, shorter->longer exact catch-up, allocator/high-water reconstruction, continued authoring after recovered head, overlap disagreement failure, and no re-authored duplicates.

## Absent-installation restoration tests

Startup with no local database tests:

1. configured installation recovery source exists -> restore and adopt `snapshot.localWriter`;
2. source definitely absent -> only then generate fresh fingerprint;
3. query/read fails -> startup fails and MUST NOT fall back to fresh creation.

## Reset tests

For generated receiver/source projections assert compatibility from one held snapshot, old history retention, repeated no-op behavior, ValueId preservation when occurrence is unchanged, proof/freshness-only repair without ValueEvent, exact target absence deletion, stale/partial validity reconstruction, and normal treatment of unseen later concurrent history.

Also assert reset remains causally-later target repair; bootstrap join must never call/reset-reuse this rule for pre-existing divergent legacy values.

## Canonical bootstrap source decision tests

Test the three outcomes of the configured transport-neutral cohort bootstrap source:

1. immutable canonical bootstrap artifact exists -> join;
2. source definitively absent -> create canonical bootstrap and freeze the artifact before ordinary authoring;
3. query/read failed or indeterminate -> migration fails and authors no canonical history.

A source which cannot arbitrate concurrent first creation must return indeterminate rather than definite absence. If two distinct canonical artifacts are presented for the same cohort, reject the state as unsupported instead of payload-merging them.

## Canonical bootstrap artifact tests

For a created artifact assert:

- `bootstrapFrontier` is exactly the creator frontier immediately after bootstrap publication;
- reads are bounded to that frontier and do not expose later records;
- `databaseVersion` and `graphSchemeString` are the original bootstrap target compatibility metadata;
- ordinary Journal authoring cannot begin before the artifact is durably established;
- the artifact remains immutable/usable after the creator later changes graph state or migrates its active database.

A normal current `JournalSnapshot` containing the bootstrap prefix must be rejected as a substitute for the canonical artifact.

### Post-bootstrap rollback regression

Fixture:

```text
T0 canonical artifact:
    K=v1

later on creator C:
    K=v2
    create N

late legacy J:
    K=v1
    N absent
```

Expected bootstrap join:

- J sees only the frozen T0 artifact;
- J reuses canonical ValueId for K=v1 and authors no replacement for K;
- J authors no delete for N because N is not in the bootstrap cut at all;
- after J reaches the current compatible version, ordinary synchronization imports C's post-bootstrap K=v2 and N;
- v2 remains selected; the late host cannot roll the cohort back to v1.

## Canonical bootstrap legacy-conflict tests

Bootstrap join is a legacy merge, not `project(Jjoined)==Glegacy` reset.

Case 1 — canonical newer value wins:

```text
canonical K: modifiedAt=T2, value=c2
late local K: modifiedAt=T1, value=l1
T2 > T1
```

Expected:

- J authors a local historical bootstrap ValueEvent for l1;
- the local ValueEvent context does **not** include canonical K merely because migration read the artifact;
- canonical and local K occurrences are concurrent;
- authority is seeded from their respective legacy modifiedAt values;
- canonical c2 remains selected.

Case 2 — late local newer value wins:

```text
canonical K: modifiedAt=T1
late local K: modifiedAt=T2
T2 > T1
```

Expected the local historical occurrence wins normally; it does not win merely because bootstrap happened later.

Case 3 — equal occurrence:

Expected no local ValueEvent and canonical ValueId is reused.

Case 4 — canonical present / local absent:

Expected no bootstrap DeleteEvent; the canonical materialization survives.

Case 5 — local present / canonical absent:

Expected one local historical ValueEvent; the local-only materialization survives.

For a shared exact occurrence which is stale on either legacy side, test conservative stale preservation without manufacturing another ValueId.

## Canonical bootstrap version-chain tests

Let the canonical artifact be at bootstrap target version N while the running cohort/software is at N+1 or later.

Expected:

1. late legacy host joins the frozen artifact at N;
2. artifact version/schema mismatch with the configured bootstrap target fails with `JournalVersionCompatibilityError` before history is authored;
3. after successful join, ordinary supported Journal-aware migrations N->...->current run locally;
4. only after reaching a compatible current version may ordinary synchronization import current cohort history.

The implementation must not reinterpret a current N+1 snapshot as the N bootstrap artifact and must not mix N/N+1 record formats in one active replica.

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
- `create` or genuine semantic replacement creates a new ValueEvent/ValueId;
- two replicas may independently create different ValueIds for a genuine replacement; after later sync one wins and dependents naming a losing replacement may become stale/recompute.

## Canonical per-record rewrite and `override()` regressions

Start two replicas X and Y which both retain historical ValueEvent:

```text
V=(A,5) for K
payload=oldEncoding(x)
```

but only X currently selects V; Y has a later replacement for K.

Run the same Journal-aware migration on both.

Expected:

- the pure per-record codec rewrites V to exactly the same target body on X and Y;
- selection of V on X and non-selection on Y does not affect V's rewritten payload;
- if X calls `override(K, ...)`, its callback result must equal the codec output for V;
- Y need not call override for historical V for V still to be rewritten identically;
- after later synchronization there is no `JournalForkError` for V.

Also test two synchronized replicas both selecting V and independently performing the same valid representation-only `override()`: both retain ValueId V and no dependent becomes stale merely because representation changed.

Test an `override()` callback which depends on differing replica-local state and returns a value unequal to the pure codec output: migration fails on that replica before cutover; it does **not** activate a divergent body for V.

Test semantic-changing use of `override()` is rejected rather than silently preserving identity.

## Current-format codec tests

For each current database version test golden fixtures, round-trip semantic equality, malformed-field rejection, no per-record version discriminator, rejection of mixed old/new bytes by ordinary replay, and complete explicit format rewrite.

## Corruption tests

Explicitly reject writer gaps, conflicting same-ID bodies, missing context coordinates, transitive context omission, wrong own-writer context, authority not extending causality, bad validation references/bases, illegal ordinary `"unknown"`, future/concurrent value invalidation references, NodeIdentifier collision, decreasing writer-state watermark, graph/journal mismatch, and mixed record formats.

A historical certificate whose explicit input set differs from current schema is not corrupt solely for that reason; it simply is not current-shape-compatible proof.

## Transaction failure tests

Inject failures before/during publication and assert no half graph/journal commit, no durable sequence consumed by failed operation, volatile allocator/cache state does not advance past disk, and failed sync/reset/migration/bootstrap before cutover leaves old active pair selected.

## Performance tests are separate from correctness

Issue #1607 owns future synchronization performance bounds.

Whole-journal representation migration cost is separately accepted. Do not weaken correctness/property tests to achieve an optimization.
