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

## Canonical bootstrap source decision tests

Test the three outcomes of the configured transport-neutral cohort bootstrap source:

1. canonical snapshot exists -> join;
2. source definitively absent -> create canonical bootstrap;
3. query/read failed or indeterminate -> migration fails and authors no canonical history.

A source which cannot arbitrate concurrent first creation must return indeterminate rather than definite absence. If two distinct canonical histories are presented for the same cohort, reject the state as unsupported instead of payload-merging them.

## Canonical bootstrap join-with-delta tests

Create canonical host C and joining legacy host J with mostly equal state and one locally changed node K.

Expected:

- J retains C's canonical records verbatim;
- every unaffected node whose immutable semantic occurrence fields equal C's projection keeps C's ValueId;
- K gets one J-authored `ValueEvent(reason="bootstrap")` when its local legacy occurrence differs;
- proof/freshness-only local differences use J-authored Validate/Invalidate records without replacing equal occurrences;
- local-only absence/presence uses minimal Delete/Value records;
- J keeps its own `DatabaseFingerprint` and local allocator watermark;
- `project(Jjoined, localWriter=J) == Glegacy(J)`;
- startup succeeds rather than requiring legacy reconciliation with an already-upgraded peer.

Also test a late host that was offline during other hosts' upgrade and carries an unsynchronized local change; the change survives as local bootstrap delta.

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

### `override()` identity regression

Start two synchronized replicas A and B sharing current occurrence:

```text
K ValueId = V
payload = oldEncoding(x)
```

Both independently migrate with:

```text
override(K, () => newEncoding(x))
```

where the migration contract says the semantic value is unchanged.

Expected on both replicas:

```text
ValueId(K) == V
semanticValue(K) == x
payloadRepresentation(K) == newEncoding(x)
```

The selected `ValueEvent` is rewritten into the target database representation while retaining ID V, NodeIdentifier, createdAt, modifiedAt, causality, and semantic meaning. After both replicas synchronize, K still has shared ValueId V and no dependent becomes stale merely because the representation changed.

The test must fail if `override()` appends a new ValueEvent.

Also test that a semantic-changing use of `override()` is rejected by the migration contract rather than silently preserving identity.

## Current-format codec tests

For each current database version test golden fixtures, round-trip semantic equality, malformed-field rejection, no per-record version discriminator, rejection of mixed old/new bytes by ordinary replay, and complete explicit format rewrite.

## Corruption tests

Explicitly reject writer gaps, conflicting same-ID bodies, missing context coordinates, transitive context omission, wrong own-writer context, authority not extending causality, bad validation references/bases, illegal ordinary `"unknown"`, future/concurrent value invalidation references, NodeIdentifier collision, decreasing writer-state watermark, graph/journal mismatch, and mixed record formats.

A historical certificate whose explicit input set differs from current schema is not corrupt solely for that reason; it simply is not current-shape-compatible proof.

## Transaction failure tests

Inject failures before/during publication and assert no half graph/journal commit, no durable sequence consumed by failed operation, volatile allocator/cache state does not advance past disk, and failed sync/reset/migration before cutover leaves old active pair selected.

## Performance tests are separate from correctness

Issue #1607 owns future synchronization performance bounds.

Whole-journal representation migration cost is separately accepted. Do not weaken correctness/property tests to achieve an optimization.