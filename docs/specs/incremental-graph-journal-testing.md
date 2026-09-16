# IncrementalGraph Journal 3 Testing Strategy

## Purpose

Journal 3 correctness depends on interleavings, causal relationships, migration identity, and replay equivalence which are easy to under-test with only example integration tests.

This document specifies minimum verification categories. Exact framework/tooling is implementation-defined.

## Reference replay oracle

Maintain one deliberately straightforward `project(J)` model. Optimized replay/index code is checked against this oracle over generated/bounded histories.

## Local operation differential tests

For each ordinary graph operation:

1. begin from a supported graph+Journal pair;
2. execute existing graph transition;
3. capture emitted records;
4. independently replay resulting Journal;
5. compare replay projection with committed graph state.

Cover first materialization, changed value, `Unchanged`, cache revalidation, explicit invalidation, transitive stale propagation, deletion, and concurrent transaction finalization.

Ordinary ValidateEvents use exactly current distinct direct input NodeKeys, no `"unknown"`, finalized current input ValueIds, and canonical NodeKeyString order.

## Causal-context closure tests

Reject:

```text
A:1
B:1 context={A:1}
C:1 context={B:1,A:0}
```

and:

```text
A:1 context={X:1}
A:2 context={A:0,X:0}
```

Generated tests assert transitive `happenedBefore` and causality -> increasing authority.

The bootstrap historical-value exception is tested separately: a joining legacy ValueEvent may omit canonical foreign coordinates, but its actual context still has exact own-prefix and transitive closure over every coordinate included.

## Invalidation-scope tests

Exercise all three scopes independently:

- `node` scope makes every certificate for K which did not causally observe the invalidation ineligible, regardless of ValueId;
- `value(V)` affects persistent freshness of V but does not remove V's incoming validity proof;
- `proof(V)` makes only certificates targeting V which did not causally observe the barrier ineligible.

A proof barrier for V MUST NOT make an otherwise-valid certificate for concurrent/later V2 ineligible merely because V2 has the same NodeKey.

A `value` or `proof` scope which references concurrent/future/wrong-node ValueEvent is rejected.

## Certificate-selection regression

Fixture:

```text
current occurrence V of K
R2: I = Invalidate(K,scope=value(V))
R2: C2 = Validate(K,V,full basis), causally after I
R1 concurrently: C1 = Validate(K,V,same full basis), greater authority, does not observe I
```

Expected C2 wins because `coversValueInvalidations` precedes authority in certificate ordering.

## Interleaving/model exploration

Generate small DAGs and short histories across 2–3 writers. Explore concurrent value changes, causal chains, validation/invalidation concurrency, proof barriers, partial bases, delete/value conflicts, propagated staleness, and replacement occurrences.

For every supported generated history assert deterministic replay and the laws in `incremental-graph-journal-theorems.md`.

## Prefix-union property tests

For compatible generated writer histories assert immutable prefix union is idempotent, commutative, associative, and rejects overlapping body disagreement.

## Stable source compatibility tests

A `JournalSnapshot` binds exact persisted version/schema, localWriter, frontier, and records to one immutable source cut. Earlier mutable metadata cannot authorize a later incompatible snapshot.

## Synchronization fixed-point and stale-persistence tests

Synchronize generated receiver/source pairs twice against unchanged source and require second sync to author no records/change no projection.

Critical regression:

```text
A -> B
common: A=a1 fresh
source Y: B=b2 fresh, validated against A=a1
receiver X: A=a1 stale
```

After sync B=b2 is persistently stale. Later `A -> Unchanged` may freshen A but not B until B validates/recomputes.

## Synchronization convergence tests

For 2–4 replicas, stop non-normalization changes, synchronize in varying fair orders to fixed point, and require equivalent projections/no-op repeated sync within each actual schedule.

## Same-writer recovery tests

Cover shorter->longer agreeing exact prefix, allocator/high-water reconstruction, continued authoring after recovered head, overlap fork rejection, and no duplicate reauthoring.

This does not substitute for pre-Journal creator-resume.

## Absent-installation restoration tests

With no local database:

1. installation recovery source exists -> restore/adopt `snapshot.localWriter`;
2. source definitely absent -> only then generate fresh fingerprint;
3. query/read fails -> fail without fresh fallback.

## Reset tests

Generated reset tests cover held-snapshot compatibility, old-history retention, repeat no-op, ValueId preservation, exact target absence, partial validity, stale persistence, and unseen later concurrency.

### Reset proof weakening

```text
A -> B
receiver/current: A=a1, B=b1, selected B certificate={A:a1}
source target: same occurrences, no A->B validity, B stale
```

Expected:

- B keeps ValueId;
- reset authors `Invalidate(B,scope=proof(B1),reason=reset)` before target partial/all-unknown validation;
- old full B1 certificate is ineligible;
- final replay has no A->B validity edge.

Add a concurrent/later B2 certificate not observing the B1 barrier and assert the barrier does **not** make B2 ineligible.

### Reset persistent propagated stale

Target has A stale and B stale with full B proof `{A:a1}`. Reset ensures final B ValueId has uncovered value-scoped reset invalidation. Later `A -> Unchanged` cannot freshen B.

## Canonical bootstrap source decision tests

Test:

1. compatible immutable artifact exists -> creator-resume or join by local fingerprint;
2. definite absence -> create canonical artifact and freeze before ordinary authoring;
3. indeterminate/read failure -> fail without canonical creation.

If first-creator arbitration cannot establish definite absence, result is indeterminate. Distinct canonical artifacts are unsupported.

## Bootstrap semantic-identity compatibility tests

The pre-Journal -> bootstrap target transition journals **persisted legacy graph state directly**.

Assert bootstrap preserves exact:

```text
materialized NodeKeys
NodeIdentifiers
payloads
createdAt / modifiedAt
freshness
validity
last_node_index
graph interpretation
```

and does not invoke ordinary migration decisions before the canonical cut.

Regression: configure a would-be legacy -> bootstrap path which would require the current `MigrationStorage.create()` behavior (fresh allocator identity plus execution-time timestamps). Startup must fail `JournalVersionCompatibilityError` before bootstrap history is authored. It must not run create and then compare/generated state.

Likewise reject any pre-bootstrap path requiring semantic `override`/`invalidate`/`delete`, schema-semantic transformation, randomness, wall clock, or allocator-dependent graph output. Those transformations belong before the supported source state or after bootstrap as Journal-aware migration.

## Canonical bootstrap artifact tests

Assert artifact:

- captures exactly creator frontier immediately after bootstrap publication;
- exposes no later records;
- carries expected bootstrap version/schema;
- is immutable while supported;
- is durable before ordinary authoring;
- is not interchangeable with current JournalSnapshot containing same prefix.

Artifact target mismatch with running release fails `JournalVersionCompatibilityError`; indefinite historical support is not required.

### Creator-resume crash regression

Fixture:

1. legacy C receives definite absence;
2. C publishes canonical artifact;
3. C crashes before local Journal cutover;
4. restart source returns that artifact while local persisted legacy DB remains.

Expected when creator fingerprint and persisted legacy semantics match:

- no migration callback reruns;
- no execution-time timestamp/identifier is regenerated;
- install exactly artifact history;
- reconstruct writer head/allocator/high-water/projection;
- author no duplicate bootstrap history;
- cut over successfully.

Persisted legacy semantic mismatch -> `JournalBootstrapForkError`. Another fingerprint cannot use creator-resume.

### Frozen-cut rollback regression

```text
bootstrap artifact: K=v1
creator later: K=v2; create N
late legacy: K=v1; N absent
```

Join sees only frozen cut, reuses K=v1 identity, creates no delete for N, and later ordinary compatible sync imports v2/N. Upgrade time cannot turn stale v1 into newer write.

## Bootstrap legacy-conflict tests

- canonical newer `modifiedAt` beats older joining occurrence;
- joining newer `modifiedAt` beats older canonical occurrence;
- exact equal occurrence authors no joining ValueEvent;
- canonical-present/local-absent authors no delete;
- local-present/canonical-absent authors historical joining ValueEvent.

### Exact shared stale is symmetric

Case A:

```text
canonical exact V fresh
joining exact V stale
```

joined V is persistently stale.

Case B — the previous missing direction:

```text
canonical exact V stale
joining exact V fresh with complete local proof
```

Expected:

- no joining ValidateEvent is allowed merely to strengthen/replace canonical proof for exact V;
- joined V remains persistently stale;
- an uncovered value-scoped bootstrap invalidation applies after any bootstrap proof history;
- later input revalidation cannot freshen V without V itself validating/recomputing.

Thus stale on **either** legacy side is conservative for an exact shared occurrence.

### Bootstrap recursive-only stale propagation

Fixture:

```text
D -> K
canonical: D exact occurrence fresh; K fresh with full {D:Dc}
joining: same D occurrence stale; K absent or a losing different occurrence
```

Expected:

1. J2 makes shared Dc persistently stale;
2. canonical K remains selected and has complete own proof;
3. J2b detects K stale solely through D and authors `Invalidate(K,scope=value(Kc),reason=bootstrap)`;
4. later `pull(D) -> Unchanged` may freshen D but MUST NOT freshen K;
5. K becomes fresh only when K validates/recomputes.

Run this over longer chains/branching DAGs and require one deterministic topological propagation pass to persist every recursive stale transition.

### Non-canonical identity-split trade-off

Two late joiners may independently assign different bootstrap ValueIds to the same occurrence which differs from canonical cut. After union one wins and dependent certificates naming the loser may stale/recompute. This is accepted by `$id-1635227135166767`.

## Journal-aware migration tests

Every migration verifies deterministic whole-history format rewrite, one target format, failure-before-cutover safety, replay target equality, and self-describing historical certificates.

Identity-specific cases:

- `keep` preserves selected ValueId;
- semantic-preserving `override()` preserves ValueId and must agree with canonical per-record codec;
- explicit `invalidate()` preserves cached occurrence ValueId and authors a true node-scoped invalidation;
- schema/proof/freshness-only changes preserve ValueId;
- `create`/genuine semantic replacement creates new ValueId;
- independent true replacements may later stale dependents naming losing occurrence.

### Migration proof weakening

For maintenance-only weakening of preserved V:

```text
before: selected full certificate for V
migration target: same V with fewer/no validity edges
```

Expected occurrence-scoped `proof(V)` barrier before target validation. Old stronger V certificate is ineligible. A concurrent/later replacement V2 certificate not observing the V barrier remains eligible according to ordinary rules.

For explicit `invalidate(K)`, expected event remains node-scoped; do not replace actual invalidation semantics with a proof barrier.

### Migration propagated stale

```text
A -> B
initial: both fresh, B proof {A:a1}
migration: explicit invalidate(A)
target: A stale; B persistently stale, proof retained
```

Migration persists value-scoped stale B marker even though replay at cut is already recursively stale. Later `A -> Unchanged` does not freshen B.

## Canonical per-record rewrite and `override()` regressions

Replicas X/Y retain historical V, selected only on X. Same migration must rewrite V identically on both. X's `override()` callback is only an assertion against canonical codec; Y need not select/callback V. Later sync must not report JournalForkError for V.

Replica-local override output differing from codec fails before cutover. Semantic-changing use of override is rejected.

## Current-format codec tests

For each current database version test golden fixtures, round trip, malformed-field rejection, no per-record version discriminator, mixed-format rejection, and complete explicit format rewrite.

## Corruption tests

Reject stream gaps, same-ID disagreement, missing/transitively-open context, wrong own-prefix, authority not extending causality, bad validation references/bases, illegal ordinary `"unknown"`, invalid value/proof scope references, NodeIdentifier collision, decreasing writer-state watermark, graph/Journal mismatch, and mixed record formats.

## Transaction failure tests

Inject failures before/during publication and assert no half graph/Journal commit, no durable sequence consumed by failed ordinary operation, volatile state does not outrun disk, and failed maintenance before cutover leaves old active pair selected.

Special case: artifact publication succeeds but creator local cutover fails -> retry creator-resume, not duplicate creation.

## Performance tests are separate from correctness

Issue #1607 owns future synchronization performance bounds. Whole-journal migration cost is separately accepted. Correctness/property tests must not be weakened for optimization.