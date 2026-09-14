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
2. stop ordinary changes;
3. repeatedly synchronize replicas in varying fair orders;
4. permit generated sync normalization;
5. continue until no operation changes state;
6. assert observable graph equivalence and retained-history convergence.

Run multiple source-order schedules over the same initial histories.

## Same-writer recovery tests

Cover:

- exact empty->prefix restoration;
- shorter exact prefix->longer prefix catch-up;
- local allocator/high-water restoration;
- new local authoring starts after recovered head;
- same-ID body disagreement fails;
- no duplicate/re-authored local records during recovery.

## Reset tests

For generated receiver/source projections:

- reset result matches source semantic graph;
- old receiver/source history retained;
- receiver local watermark semantics preserved;
- stale/partial validity target reconstructed;
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

## Migration tests

For every implemented Journal-3-aware migration:

- run migration target construction;
- record migration baseline;
- discard target graph;
- replay from retained old+journal migration history under target schema;
- assert target equivalence;
- assert old record IDs/bodies unchanged;
- assert old migration callback is not needed during replay.

## Codec/version tests

For every supported `recordVersion`:

- golden serialized fixtures;
- round-trip semantic equality;
- malformed-field rejection;
- historical decoder/upcaster determinism;
- cross-version record ID meaning preservation.

## Corruption tests

Explicitly verify rejection of:

- writer gaps;
- conflicting same-ID bodies;
- causal-context frontier holes;
- validation target wrong node;
- basis ValueId wrong input node;
- basis reference concurrent/future to certificate;
- value-scoped invalidation referencing future/concurrent value;
- selected NodeIdentifier collision;
- decreasing WriterStateRecord watermark;
- known graph/journal projection mismatch.

## Transaction failure tests

Inject failures before/during durable publication and assert:

- no half graph/journal commit;
- failed ordinary operation consumes no durable journal sequence;
- volatile journal caches do not advance past disk;
- failed sync/reset/migration before cutover leaves old active supported pair selected.

## Performance tests are separate from correctness

Issue #1607 may later add asymptotic/performance acceptance tests.

Do not weaken correctness/property tests to achieve an optimization. Optimized code should remain differential-testable against the clear reference replay model.
