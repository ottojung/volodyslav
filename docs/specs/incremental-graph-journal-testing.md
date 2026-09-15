# IncrementalGraph Journal 3 Testing Strategy

## Purpose

Journal 3 correctness depends on interleavings, causal relationships, migration identity, and replay equivalence which are easy to under-test with only example integration tests.

This document specifies the minimum verification categories expected from an implementation. Exact framework/tooling is implementation-defined.

## Reference replay oracle

Maintain one deliberately straightforward implementation/model of:

```text
project(J)
```

which favors clarity over production performance.

Optimized projection/index code is checked against this reference over generated/bounded histories.

## Local operation differential tests

For each ordinary graph operation:

1. begin from a supported graph+journal pair;
2. execute the existing graph transition;
3. capture emitted journal records;
4. independently replay the resulting journal;
5. compare replay projection with committed graph state.

Cover first materialization, changed value, `Unchanged`, cache revalidation, explicit invalidation, transitive stale propagation, deletion, and concurrent transaction finalization.

Every ordinary ValidateEvent test asserts that the basis:

- contains exactly one entry per current distinct direct input NodeKey;
- uses no `"unknown"` values;
- names the finalized current ValueId for each input; and
- is serialized in canonical persisted `NodeKeyString` order.

## Causal-context closure tests

Contexts must be genuine causally closed cuts, not merely in-range coordinates.

Reject exactly this malformed chain:

```text
A:1

B:1
context = { A:1 }

C:1
context = { B:1, A:0 }
```

Even though all named coordinates exist, C:1 includes B:1 while omitting B:1's causal predecessor A:1.

Also reject a same-writer omission:

```text
A:1 context = { X:1 }
A:2 context = { A:0, X:0 }
```

because every semantic event `(A,q)` must satisfy:

```text
context[A] == q - 1
```

and therefore A:2 must transitively include X:1.

Generated context tests must assert:

```text
happenedBefore(E,F) && happenedBefore(F,G)
    => happenedBefore(E,G)
```

and:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

for every supported generated history.

## Interleaving/model exploration

Generate small acyclic graph schemes and short histories across 2–3 writers.

Explore interleavings of:

- concurrent value changes;
- observe-then-change causal chains;
- validation concurrent with node invalidation;
- multiple validations for one current ValueId;
- partial multi-input basis matches;
- value-scoped invalidation followed by one covering and one concurrent validation;
- remote delete/value conflicts;
- propagated stale transitions.

For every supported generated journal assert deterministic replay and the laws in `incremental-graph-journal-theorems.md`.

## Certificate-selection regression

Explicitly test `coversValueInvalidations` as the second certificate-selection key.

Fixture:

```text
current occurrence V of K
inputs unchanged

R2: I = Invalidate(K, scope=value(V))
R2: C2 = Validate(K, value=V, full current basis), causally after I

R1 concurrently:
    C1 = Validate(K, value=V, same full basis)
    C1 has greater authority than C2
    C1 does not observe I
```

Expected:

```text
basisMatchCount(K,C1) == basisMatchCount(K,C2)
coversValueInvalidations(K,C1) == false
coversValueInvalidations(K,C2) == true
certificate(K) == C2
K fresh
```

The test must fail if authority is consulted before value-invalidation coverage.

## Prefix-union property tests

For compatible generated writer histories assert:

```text
J join J == J
J join K == K join J
(J join K) join L == J join (K join L)
```

and verify overlap conflicts are rejected rather than semantically merged.

## Stable source compatibility tests

A `JournalSnapshot` binds compatibility metadata to the same frozen source state as its frontier/records.

Tests assert:

- snapshot `databaseVersion` equals exact persisted source `global/version`;
- snapshot `graphSchemeString` equals exact persisted `global/graph_scheme`;
- fields remain stable for snapshot lifetime;
- version/schema mismatch fails sync/reset before active import/cutover;
- an external metadata read followed by source migration cannot authorize a later incompatible snapshot;
- unchanged compatible sources still use the held snapshot compatibility check.

## Synchronization fixed-point tests

For generated compatible receiver/source pairs:

1. run pairwise synchronization;
2. record final journal/projection;
3. synchronize again against unchanged source;
4. assert no new semantic records and no projected change.

Include the critical newly-selected-remote-occurrence regression:

```text
A -> B
common: A=a1 fresh
source Y: B=b2 fresh, validated against A=a1
receiver X: A=a1 stale
```

After sync B=b2 must be persistently stale even if B was absent/different before. Later `Unchanged` revalidation of A must not freshen B until B itself validates/recomputes.

Also cover stale-by-basis-mismatch and assert no extra value-scoped marker is required merely for that mismatch.

## Synchronization convergence tests

For 2–4 replicas:

1. generate local changes while disconnected;
2. stop non-normalization graph changes;
3. synchronize in varying fair orders;
4. permit sync normalization;
5. continue to fixed point;
6. assert observable graph equivalence for that actual execution.

Different schedules may author different real normalization history. Each schedule must converge internally; tests do not require counterfactual histories to end identically.

## Same-writer recovery tests

Cover:

- exact empty->prefix restoration of an already-known local writer;
- shorter exact prefix->longer prefix catch-up;
- allocator/high-water reconstruction;
- new authoring starts after recovered head;
- same-ID body disagreement fails;
- no re-authored duplicates.

## Absent-installation restoration tests

Startup with no local database must test the three-way absent-state decision:

1. configured installation recovery source exists -> restore it and adopt `snapshot.localWriter`;
2. source definitely absent -> and only then generate a fresh fingerprint;
3. recovery-source query/read fails -> startup fails and **MUST NOT fall back** to fresh creation.

After receiver-less restore, assert the local writer fingerprint, writer head, allocator watermark, graph projection, and retained history reconstruct the restored installation before new local allocation.

## Reset tests

For generated receiver/source projections assert:

- compatibility metadata comes from the same held source snapshot;
- reset result matches source semantic graph;
- old history remains retained;
- receiver local watermark remains local;
- repeated already-satisfied reset authors no semantic records;
- a target-present node whose P0 occurrence already has the same payload/identifier/timestamps preserves its current ValueId;
- changing only validity/freshness uses ValidateEvent/InvalidateEvent without manufacturing a new ValueEvent;
- a dependent whose input resetValueId changes may keep its own ValueId and receive only a new certificate;
- target-absent node gets exactly one DeleteEvent iff P0 currently selects a value;
- stale/partial validity target is reconstructed exactly;
- unseen later concurrent history participates normally.

## Canonical multi-host bootstrap tests

Create legacy replicas X and Y which previously synchronized.

Use a chain:

```text
A -> B
```

with the same legacy A occurrence on both hosts and a later B modification on X.

First demonstrate that **independent semantic bootstrap is forbidden**: the implementation must not let X and Y mint separate equivalent bootstrap ValueIds and later rely on ordinary Journal sync.

Then exercise the supported cohort path:

1. choose/reconcile one canonical legacy state;
2. canonical source bootstraps semantic history once;
3. joining host retains those exact ValueIds/certificates rather than re-authoring them;
4. joining host preserves its own `DatabaseFingerprint` as localWriter and records its own allocator watermark;
5. after both hosts are current, synchronization does not stale B merely because A came from a different host bootstrap.

If a joining legacy graph differs from the canonical bootstrap projection, automatic join must fail rather than minting a competing semantic baseline.

## Migration tests

For every Journal-aware migration:

- rewrite every pre-existing record deterministically into target format preserving IDs/meaning;
- target contains no mixed formats/per-record version tags;
- source failure before cutover leaves source active;
- replay target equals migration target;
- historical certificates remain self-describing.

Identity-specific tests must assert:

- a `keep`/proof-only/freshness-only migration preserves the selected ValueId;
- schema input-set change may create a new ValidateEvent for the preserved ValueId without a new ValueEvent;
- invalidating a preserved occurrence uses value-scoped invalidation rather than replacing it;
- create/replace/transform operations which genuinely change occurrence fields create a new ValueEvent;
- independently upgrading a synchronization cohort does not create duplicate equivalent new value occurrences: semantic migrations that create/replace occurrences use one canonical semantic migration history retained by the peers;
- two independently performed **representation-only / occurrence-preserving** migrations keep shared pre-migration ValueIds shared.

Include a multi-host trace where a version bump leaves A/B values semantically unchanged. After migration and sync, the old shared ValueIds must still be selected and B must not become stale merely because hosts migrated separately.

## Current-format codec tests

For each current database version:

- golden current-format fixtures;
- round-trip semantic equality;
- malformed-field rejection;
- no per-record format discriminator;
- ordinary replay rejects mixed old/new bytes;
- explicit migration rewrites old representation completely.

## Corruption tests

Explicitly reject:

- writer gaps;
- conflicting same-ID bodies;
- causal-context coordinates beyond retained frontier;
- context including an event while omitting that event's causal predecessors;
- semantic event with own-writer context not equal to sequence minus one;
- happened-before edge whose authority order does not increase;
- validation target wrong node;
- duplicate/noncanonical basis entries;
- basis ValueId from wrong input node;
- concurrent/future basis reference;
- illegal ordinary `"unknown"`;
- future/concurrent value-scoped invalidation reference;
- selected NodeIdentifier collision;
- decreasing WriterState watermark;
- known graph/journal mismatch;
- mixed record formats.

A historical certificate whose explicit input set differs from the current schema is not corrupt solely for that reason; it simply is not current-shape-compatible proof.

## Transaction failure tests

Inject failures before/during durable publication and assert:

- no half graph/journal commit;
- failed ordinary operation consumes no durable journal sequence;
- volatile allocator/cache state does not advance past disk;
- failed sync/reset/migration before cutover leaves old active pair selected.

## Performance tests are separate from correctness

Issue #1607 owns future synchronization performance bounds.

Whole-journal representation migration cost is separately accepted. Do not weaken correctness/property tests to achieve an optimization.