# IncrementalGraph Journal 3 Testing Strategy

## Purpose

Journal 3 correctness depends on interleavings, causal relationships, and replay equivalence which are easy to under-test with only example-based integration tests.

This document specifies the minimum categories of verification expected from an implementation. Exact framework/tooling is implementation-defined.

## Reference replay oracle

Maintain one deliberately straightforward implementation/model of:

```text
project(J)
```

which favors clarity over production performance.

Optimized incremental projection/index code should be checked against this reference behavior over generated/bounded histories.

## Local operation differential tests

For each ordinary graph operation:

1. begin from a supported graph+journal pair;
2. execute the existing graph transition;
3. capture emitted journal records;
4. independently replay the resulting journal;
5. compare replay projection with committed graph state.

Cover first materialization, changed value, `Unchanged`, cache revalidation, explicit invalidation, transitive stale propagation, deletion, and concurrent transaction finalization.

Every ordinary ValidateEvent test also asserts that the basis:

- contains exactly one entry per current distinct direct input NodeKey;
- uses no `"unknown"` values;
- names the finalized current ValueId for each input; and
- is serialized in canonical persisted `NodeKeyString` order.

Include fixtures where typed `compareNodeKey()` ordering differs from lexicographic serialized NodeKeyString ordering, and assert that the persisted-basis rule follows the latter.

## Interleaving/model exploration

Generate small acyclic graph schemes and short histories across 2–3 writers.

Explore interleavings of:

- concurrent value changes;
- observe-then-change causal chains;
- validation concurrent with node invalidation;
- multiple validations for one current ValueId;
- partial multi-input basis matches;
- remote delete/value conflicts;
- propagated stale transitions.

For every supported generated journal assert deterministic replay and the laws in `incremental-graph-journal-theorems.md`.

## Prefix-union property tests

For compatible generated writer histories assert:

```text
J join J == J
J join K == K join J
(J join K) join L == J join (K join L)
```

and verify all overlap conflicts are rejected rather than semantically merged.

## Synchronization fixed-point tests

For generated compatible receiver/source pairs:

1. run pairwise synchronization;
2. record final journal/projection;
3. synchronize again against the unchanged source;
4. assert no new semantic records and no projected change.

Include receiver-only dependent graphs specifically to exercise sync-authored persistent stale invalidations.

## Synchronization convergence tests

For 2–4 small replicas:

1. generate local changes while disconnected;
2. stop ordinary/reset/migration graph-changing operations;
3. repeatedly synchronize replicas in varying fair orders;
4. permit generated sync normalization;
5. continue until no operation changes state;
6. assert observable graph equivalence and retained-history convergence for that execution.

Run multiple source-order schedules over the same initial positive histories, but interpret them correctly: different schedules may legitimately author different real sync-normalization histories. Each schedule must converge internally; the test must not require counterfactual schedules with different authored normalization events to finish in identical projections.

Also assert that once one schedule reaches its normalization fixed point, redelivery of the same facts creates no acknowledgement/delete/invalidation chain.

## Same-writer recovery tests

Cover:

- exact empty->prefix restoration;
- shorter exact prefix->longer prefix catch-up;
- local allocator/high-water restoration;
- new local authoring starts after recovered head;
- same-ID body disagreement fails;
- no duplicate/re-authored local records during recovery.

For NodeIdentifier allocation, verify that restoration recovers a watermark high enough that the continuing fingerprint namespace never reuses a retired local allocation index.

## Reset tests

For generated receiver/source projections:

- reset result matches source semantic graph;
- old receiver/source history retained;
- receiver local watermark semantics preserved;
- stale/partial validity target reconstructed;
- reset certificate bases use explicit input NodeKeys in canonical order;
- repeated already-satisfied reset can no-op;
- unseen third-writer concurrent event learned later participates in ordinary conflict semantics.

## Bootstrap tests

Construct supported legacy graph states covering:

- fresh zero-input node;
- stale zero-input node;
- fresh dependency chain;
- stale chain with complete validity;
- stale node with partial validity;
- multiple equal modifiedAt values on unrelated nodes;
- nonzero/gapped last_node_index.

Bootstrap then assert exact replay equivalence to the original legacy graph.

Bootstrap basis tests also cover canonical NodeKeyString ordering and `"unknown"` only for missing legacy proof.

## Migration tests

For every implemented Journal-3-aware migration:

- start from a source replica containing only the source `global/version` representation;
- run the journal representation rewrite into inactive target storage;
- assert every pre-existing `(author,sequence)` still exists exactly once in the target and no existing coordinate was renumbered;
- assert semantic causal/reference meaning of every pre-existing record is preserved;
- migrate the same source record/history independently twice and assert byte/canonical target-record equality;
- assert the target contains only target-version journal representations and no per-record version fields;
- run semantic migration target construction and record the migration baseline;
- discard target graph materialization;
- replay from the rewritten retained history + migration baseline under target schema;
- assert target equivalence;
- assert historical certificates remain self-describing after input order/set changes;
- assert target certificates use target input keys in canonical NodeKeyString order;
- assert old migration callback is not needed during replay;
- inject failure before cutover and assert the source-format active replica remains selected.

Include a migration with enough retained records to exercise streaming whole-journal rewrite rather than assuming only current graph state must be visited.

## Current-format codec tests

For each current database version supported by a migration boundary:

- golden serialized fixtures for that version's one journal representation;
- round-trip semantic equality;
- malformed-field rejection;
- no `recordVersion`/per-record format discriminator in journal records;
- ordinary current-version replay rejects old-format/mixed-format record bytes rather than invoking an upcaster;
- explicit source-version migration accepts the old representation only through the migration path and rewrites it completely into target format.

For validation records include fixtures proving that basis canonicalization does not require a historical graph schema.

## Corruption tests

Explicitly verify rejection of:

- writer gaps;
- conflicting same-ID bodies under one current database version;
- causal-context frontier holes;
- validation target wrong node;
- duplicate basis input NodeKeys;
- noncanonical basis entry ordering;
- basis ValueId whose ValueEvent belongs to another input NodeKey;
- basis reference concurrent/future to certificate;
- ordinary validation containing `"unknown"`;
- value-scoped invalidation referencing future/concurrent value;
- selected NodeIdentifier collision;
- decreasing WriterStateRecord watermark;
- known graph/journal projection mismatch;
- mixed old/new journal record representations inside one active replica.

A historical certificate whose explicit input-key set differs from the **current** schema is not corrupt solely for that reason; it is retained history and simply is not current-shape-compatible proof.

## Transaction failure tests

Inject failures before/during durable publication and assert:

- no half graph/journal commit;
- failed ordinary operation consumes no durable journal sequence;
- volatile journal caches do not advance past disk;
- failed sync/reset/migration before cutover leaves old active supported pair selected.

For a format-changing migration, partial inactive-target rewrite is discardable staging and must never become the active current database.

## Performance tests are separate from correctness

Issue #1607 may later add asymptotic/performance acceptance tests for synchronization.

Separately, whole-journal time/I/O for a format-changing migration is an explicit accepted trade-off. Migration tests should not require change-sensitive migration time, though they should verify streaming/bounded-memory behavior where implemented.

Do not weaken correctness/property tests to achieve an optimization. Optimized code should remain differential-testable against the clear reference replay model.