# IncrementalGraph Journal 3 Testing Strategy

## Purpose

Journal 3 correctness depends on interleavings, causal relationships, migration identity, and replay equivalence which are easy to under-test with only example integration tests.

This document specifies minimum verification categories. Exact framework/tooling is implementation-defined.

## Reference replay oracle

Maintain one deliberately straightforward streaming `project(J)` model. Optimized replay/index code is checked against this oracle over generated/bounded histories. Test fixtures themselves may be bounded/in-memory, but the oracle algorithm should consume ordered records incrementally rather than rely on grouping the complete Journal by node in RAM.

## Local operation differential tests

For each ordinary graph operation:

1. begin from a supported graph+Journal pair;
2. execute existing graph transition;
3. capture emitted records;
4. independently replay resulting Journal;
5. compare replay projection with committed graph state.

Cover first materialization, changed value, `Unchanged`, cache revalidation, explicit invalidation, transitive stale propagation, deletion, and concurrent transaction finalization.

Ordinary ValidateEvents use exactly current distinct direct input NodeKeys, no `"unknown"`, finalized current input ValueIds, and canonical NodeKeyString order.

### Skewed value-timestamp regression

Ordinary recompute must accept and persist a value occurrence with `createdAt > modifiedAt`.

Fixture: materialize/synchronize K with persisted `createdAt = Tfuture`, then recompute K on a writer whose current wall clock produces `modifiedAt = Tnow < Tfuture`. Require the new ValueEvent to preserve `createdAt = Tfuture` and exact committed `modifiedAt = Tnow` without rejection or timestamp normalization. Conflict authority remains governed by `AuthorityTime`, not by ordering the two persisted timestamps.

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
- `proof(V,D)` suppresses only the D basis edge of certificates targeting V unless the certificate causally observes that barrier and explicitly re-proves D.

A proof-edge barrier for `(V,D)` MUST NOT suppress another input edge E of the same certificate, and MUST NOT affect an otherwise-valid certificate for concurrent/later V2 merely because V2 has the same NodeKey.

Multiple proof-edge barriers for the same V compose negatively: barriers naming different inputs remove the union of those edges from the selected certificate's effective basis.

A `value` or `proof` scope which references concurrent/future/wrong-node ValueEvent is rejected. Proof scope also validates its canonical input NodeKey shape.

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

Generate small DAGs and short histories across 2–3 writers. Explore concurrent value changes, causal chains, validation/invalidation concurrency, proof-edge barriers, partial bases, delete/value conflicts, propagated staleness, and replacement occurrences.

For every supported generated history assert deterministic replay and the laws in `incremental-graph-journal-theorems.md`.

## Prefix-union and fork-impossibility property tests

Generate states only through supported lifecycle transitions and, for every pair which may coexist or later combine, assert `incremental-graph-journal-theorems.md` Laws 8 and 8a:

- for every writer A, the two retained A histories are prefix-comparable;
- every coordinate below both frontiers has identical canonical meaning;
- no generated pair can agree through A:1..k and diverge at A:k+1;
- immutable prefix union is therefore idempotent, commutative, and associative without rescanning historical overlap.

Separately inject an explicitly unsupported/corrupt same-ID disagreement and require explicit rebuild/maintenance validation to report `JournalForkError`. This corruption fixture is not a supported pairwise-sync/reset state and does not authorize O(H) historical overlap scanning in those operations.

## Stable source compatibility tests

A `JournalSnapshot` binds exact persisted version/schema, localWriter, frontier, and records to one immutable source cut. Earlier mutable metadata cannot authorize a later incompatible snapshot.

## Routine-open history-independence tests

For an already-current supported database, open through an instrumented Journal/index storage interface which fails the test if routine startup requests:

- full retained-Journal iteration;
- per-writer historical range scans beyond constant-size committed head metadata;
- history-proportional Journal-index validation; or
- replay of retained history.

Routine open must still succeed using current version/schema, committed active-pair metadata, local writer head, allocator watermark, authority high-water, and graph-bounded current-state metadata.

Vary retained historical length H while holding current graph/graph-bounded metadata size G fixed and require the Journal-specific routine-open operation count/I/O shape to remain independent of H, as required by `$id-7429043816351276`.

Run the same fixture through **explicit projection rebuild** and allow/require retained-history iteration there. This verifies that the history-sized validation path still exists at the explicit maintenance boundary rather than leaking into ordinary startup.

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

Separately test the host-count bounded settling construction. For each generated quiescent compatible state with H participants:

1. choose each participant in turn as collector C;
2. hold all non-collector participants idle while C synchronizes from each of them once;
3. hold C fixed while every other participant synchronizes from C once;
4. count only successful synchronizations which import at least one new retained record or author at least one normalization record;
5. require the count to be at most `2(H-1)`, and therefore at most `H^2` for H >= 2;
6. require equal retained synchronized Journal closure/equivalent projection across participants; and
7. require another complete synchronization round to be semantic no-op.

The test must vary gather order. The operation-count assertion applies to this deliberate settling construction, not to arbitrary fair schedules, which are tested only for eventual convergence.

## Lifecycle fault-model tests

The reference lifecycle state generator MUST be closed under supported Volodyslav transitions plus complete disappearance of the local database. It MUST NOT generate partial external rollback/damage as an ordinary recoverable input.

Cover:

- supported ordinary/migration/sync/reset transitions preserve a valid database or fail without exposing an invalid target;
- injected process crashes at supported publication/cutover boundaries expose only states explicitly permitted by those transition rules;
- complete deletion of the local database yields `Absent` and enters absent-state restore/fresh creation;
- partial deletion of Journal/graph state, replacement with an older local snapshot, mixed old/new persistent state, and direct external mutation are corrupted/unsupported, not new lifecycle states;
- an existing local writer A at 900 plus surviving supported A history through 905 is rejected as `JournalWriterBehindError` and never repaired by importing 901..905 into the existing receiver.

## Absent-installation restoration tests

With no local database:

1. continuation-safe installation recovery source exists -> restore/adopt `snapshot.localWriter`;
2. source definitely absent -> only then generate fresh fingerprint;
3. query/read fails or continuation safety cannot be guaranteed -> fail without fresh fallback.

Absent restoration must not accept an existing but damaged/truncated database as though it were absent.

Critical continuation-safety regression:

```text
complete local database is gone
recovery snapshot contains A:1..900
some supported surviving state can later reintroduce A:901..905
```

The recovery source MUST NOT return continuation-safe `Exists`; absent restore fails indeterminate rather than resuming at A:901.

This is the `$id-2567281946348705` regression: restoration must not permit a new A:901 record when the old A:901 can later coexist with, or be combined with, that restored continuation.

If A:901..905 existed only on the completely lost local database and no supported state can reintroduce them, their loss does not by itself make A:900 unsafe. The test oracle is future re-entry after complete local loss, not whether a coordinate was once locally committed.

Allocator companion regression: let the recoverable A:1..900 prefix reconstruct `last_node_index = n`, while lost A:901..905 had advanced the destroyed local database to `m > n`. When the suffix cannot later re-enter supported retained history, absent restore reconstructs n and may allocate n+1 again even if that index was used only in the lost suffix. If supported retained history containing any allocation from that suffix can later re-enter, A:900 is not continuation-safe and the restore MUST be rejected. At no supported retained state may one physical NodeIdentifier denote incompatible semantic nodes.

This regression is the concrete recovery boundary for `$id-4173361406347342`: the test oracle is whether both meanings can coexist in, or later join, supported retained history—not whether the identifier bit pattern was ever physically allocated before.

Establishing continuation safety must not require contacting/discovering every possible peer; exercise a recovery-source implementation whose transport-level invariant can make the guarantee locally, consistent with `$id-4719065396881648`.

This does not substitute for pre-Journal creator-resume.

## Reset tests

Generated reset tests cover held-snapshot compatibility, old-history retention, repeat no-op, preservation of the matching raw-union selected ValueId, exact target absence, partial validity, stale persistence, and unseen later concurrency.

### Reset own-writer-behind rejection

Fixture:

```text
receiver localWriter A frontier[A] = 900
held reset JournalSyncSource frontier[A] = 905
```

Expected:

- `resetTo()` fails `JournalWriterBehindError` before importing any source record or authoring any reset event;
- active receiver Journal/projection remain unchanged;
- receiver is classified corrupted/unsupported under the lifecycle fault model;
- no `recoverExistingWriterFrom(...)` or equivalent same-writer recovery path is invoked;
- reset is not retried merely to repair the local rollback;
- the supported fixture assumes the shared A prefix is identical by Laws 8/8a; a separately injected historical same-ID disagreement belongs to explicit corruption-validation tests rather than this change-bounded reset path.

### Reset projection-neutral import still reports changed

Let receiver R already have the same projected graph as source snapshot S, and let S contain at least one compatible foreign Journal record beyond R's retained frontier which does not alter that projection.

Reset imports the missing source record(s), Passes 1–3 author no receiver semantic records, and final projection remains unchanged.

Require:

- the missing source record(s) become durably retained;
- `ResetResult.changed == true`;
- outer persistence/publication logic is therefore not allowed to skip the committed Journal advance;
- repeating reset against the now-covered same source frontier authors/imports nothing and returns `changed == false`.

### Reset preserves matching raw-union occurrence despite split bootstrap ValueIds

Exercise the accepted `$id-1635227135166767` identity split.

Let source S and receiver R contain the same non-canonical legacy semantic occurrence for K with identical:

```text
NodeIdentifier
payload
createdAt
modifiedAt
```

but independent late bootstrap assigned:

```text
PS.valueId(K) = Vs
receiver/raw-union winner H0.valueId(K) = Vr
Vr != Vs
```

Choose authority so Vr is the ValueEvent selected by `selectedHeads(J0)`.

Reset MUST:

- recognize H0's selected occurrence as already matching the source target's immutable occurrence state;
- preserve `resetValueId(K) = Vr`;
- author no replacement ValueEvent merely to force `Vr == Vs`;
- establish source-equivalent payload/identifier/timestamp/freshness/validity semantics;
- permit final `Preset.valueId(K) != PS.valueId(K)`.

This verifies that source ValueId equality is not a reset postcondition.

### Reset raw-union dependency-closure regression

Use schema `D -> K`.

Source S is individually valid and dependency-closed:

```text
D Value authority 10
K Value authority 100
```

Receiver R is individually valid and dependency-closed:

```text
D Delete authority 50
K Delete authority 51
```

The compatible raw union selects:

```text
D -> Delete(50)   // absent
K -> Value(100)   // present
```

so `project(union(R,S))` would reject the selected heads as non-dependency-closed.

Reset MUST NOT attempt that projection before repair. It computes `H0 = selectedHeads(J0)`, observes that D does not match the source target, authors a causally-later reset ValueEvent for D, preserves K's matching source occurrence, and only then computes `P1 = project(J1)`.

Require:

- no temporary sync-style Delete(K) is authored;
- Pass 1 selected presence equals the source target;
- the first full projection of the union path succeeds only after Pass 1;
- K's matching ValueId is preserved;
- final reset projection equals PS.

### Reset timestamp adoption

Let receiver R and source S both materialize semantic node K but select different materialization lineages/occurrences:

```text
receiver: NodeIdentifier Ir, createdAt Cr, modifiedAt Mr
source:   NodeIdentifier Is, createdAt Cs, modifiedAt Ms
```

with at least one immutable occurrence field different so reset must establish the source occurrence.

Require reset to author the replacement ValueEvent with exactly `Is/Cs/Ms` from the held source projection. The observable `getCreationTime(K)` / `getModificationTime(K)` after reset become `Cs/Ms`, even if they differ from the receiver's previous timestamps or are not numerically ordered. Reset MUST NOT substitute reset execution/finalization time for either timestamp.

### Reset proof weakening

```text
A -> B
receiver/current: A=a1, B=b1, selected B certificate={A:a1}
source target: same occurrences, no A->B validity, B stale
```

Expected:

- B keeps ValueId;
- reset authors `Invalidate(B,scope=proof(B1,A),reason=reset)` for the removed A->B edge;
- old full B1 certificate's A edge is ineffective;
- final replay has no A->B validity edge.

Add a second input C and assert a barrier for `(B1,A)` does not remove an unrelated valid C->B edge.

Add a concurrent/later B2 certificate not observing the B1 barrier and assert the barrier does **not** affect B2.

### Concurrent same-ValueId proof weakening

Fixture:

```text
A ----\
       -> B
C ----/
shared V = b1
old certificate = {A:a1,C:c1}
```

Two replicas independently migrate/reset to the same partial proof `{A:a1,C:unknown}`. Each authors its own `proof(b1,C)` barrier and target validation. After union:

- at least one target certificate remains selected;
- A->B remains valid;
- C->B is invalid;
- the two concurrent barriers do not erase A proof.

Variant: one replica removes A and the other removes C. After union both edges are invalid: negative edge evidence composes as the union of removed edges.

Concurrent same-ValueId revalidation regression: let another replica validate the same `b1` with full proof for a barriered edge without observing the reset/migration barrier. After union, that concurrent validation MUST NOT re-establish the barriered edge. Exercise this with both `reason="reset"` and `reason="migration"`. A new validation causally after the barrier which explicitly proves the edge MUST restore it. A certificate for replacement ValueId `b2` remains unaffected.

### Reset losing-certificate proof exposure regression

Construct preserved occurrence V of K with current inputs A1/B1 and two eligible certificates:

```text
C1 higher authority: {A:A1, B:B0} -> effective {A}
C2 lower authority:  {A:A0, B:B1} -> effective {B}
target validity: {}
```

C1 initially wins. Reset MUST compute `eligibleEffectiveProofUnion_P1(K)={A,B}` across all eligible certificates, author `proof(V,A)` and `proof(V,B)` barriers, and finish with zero incoming validity. It MUST NOT barrier only A and allow C2 to expose B. Positive replay proof still comes from one certificate; the union is used only for negative barrier selection.

Repeat the same reset against the unchanged source and require no new proof barrier or ValidateEvent.

### Reset persistent propagated stale

Target has A stale and B stale with full B proof `{A:a1}`. Reset ensures final B ValueId has uncovered value-scoped reset invalidation. Later `A -> Unchanged` cannot freshen B.

## Canonical bootstrap source decision tests

Test query behavior:

1. compatible immutable artifact exists -> creator-resume or join by local fingerprint;
2. definite absence -> stage a deterministic candidate and attempt conditional publication;
3. indeterminate/read failure -> fail without canonical publication.

`DefinitelyAbsent` alone MUST NOT authorize local Journal cutover.

### Concurrent canonical creators

Start pre-Journal installations X and Y in the same cohort. Arrange that both query before either publishes and both receive `DefinitelyAbsent`. Each stages its own deterministic canonical candidate, then race:

```text
publishCanonicalBootstrapIfAbsent(Xcandidate)
publishCanonicalBootstrapIfAbsent(Ycandidate)
```

Require:

- exactly one distinct candidate receives `Published`;
- the loser receives `AlreadyExists(B)` naming the same durable winner;
- the winner may creator-cut-over only after `Published`;
- the loser discards its staged candidate and ordinary-joins B unless B has its own fingerprint, in which case it creator-resumes;
- the canonical source contains exactly one accepted artifact;
- no second canonical history is made durable or locally active.

This is the regression for `$id-1847369205416728`.

### Unknown publication outcome

Before the publication-outcome cases, stage the canonical candidate twice from byte-identical persisted legacy state, with different process/start times. Require the two candidates to be byte-identical: same record IDs/order, contexts, AuthorityTimes, bootstrap frontier, writer-state record, and encoded artifact bytes. In particular, canonical C2/C3 authority must not depend on upgrade/publication wall clock.

If conditional publication returns `IndeterminateOrError`, require no local cutover and keep the supported legacy database active. On retry/restart:

- re-query `Exists(B)` with local creator writer -> creator-resume;
- re-query `Exists(B)` with another creator -> discard local staging and join;
- re-query `DefinitelyAbsent` -> reconstruct/stage the same byte-identical candidate from unchanged persisted legacy state and retry that candidate conditionally;
- re-query indeterminate/error -> fail again without cutover.

Distinct canonical artifacts discovered despite the conditional-publication contract remain unsupported.

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

Regression: configure a would-be legacy -> bootstrap path which would require fresh allocator identity plus execution-time timestamps. Startup must fail `JournalVersionCompatibilityError` before bootstrap history is authored. It must not generate the target state and then compare it.

Likewise reject any pre-bootstrap path requiring semantic create/invalidate/delete, schema-semantic transformation, randomness, wall clock, or allocator-dependent graph output. Those transformations belong before the supported source state or after bootstrap as Journal-aware migration.

### Bootstrap skewed timestamp preservation

Canonical bootstrap: construct valid persisted legacy state containing K with `createdAt > modifiedAt`. Bootstrap MUST succeed and C1 must preserve both legacy timestamps exactly in the bootstrap ValueEvent.

Joining bootstrap: construct a joining legacy occurrence with `createdAt > modifiedAt` which differs from the canonical occurrence. J1 MUST author the historical joining ValueEvent with both joining legacy timestamps preserved exactly.

Neither path may reject, reorder, clamp, or synthesize these timestamps merely to impose chronological ordering between the two persisted fields.

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

### Canonical creator writer-order regression

Create canonical legacy occurrences with distinct/equal `modifiedAt` values and NodeKeys deliberately supplied in a different traversal order. Stage the canonical bootstrap candidate.

Require:

- canonical C1 ValueEvents are allocated in nondecreasing `(modifiedAt, canonical NodeKey)` order;
- equal-`modifiedAt` ties use canonical NodeKey order;
- writer sequence therefore agrees with the bootstrap authority order;
- repeating staging from the same persisted legacy state produces the same C1 record order and IDs.

### Joining bootstrap writer-order regression

Create two joining-only/different legacy occurrences with `modifiedAt` 10 and 5 and intentionally attempt to allocate the 10 record first. The resulting same-writer stream is authority-inconsistent and MUST be rejected.

The supported bootstrap constructor instead sorts all joining historical ValueEvents by nondecreasing `(modifiedAt, canonical NodeKey)` before allocating writer sequences. All of them precede joining proof/stale records whose contexts include the canonical bootstrap cut.

### Mixed conflict winners must not rewrite proof provenance

Fixture:

```text
D -> K

canonical:
    D = Dc, modifiedAt=20
    K = Kc, modifiedAt=10

joining legacy:
    D = Dj, modifiedAt=10
    K = Kj, modifiedAt=30
    D -> K valid
    K fresh
```

After J1:

```text
selected D = Dc
selected K = Kj
```

Expected J2 certificate:

```text
Validate(Kj, basis={D:Dj})
```

not `{D:Dc}`. `joiningOccurrenceValueId(D)` names Dj even though Dj lost conflict selection. Replay therefore sees a basis mismatch against current Dc, `D -> Kj` is not valid, and Kj is hard stale until K itself revalidates/recomputes. Bootstrap MUST NOT manufacture freshness for a cross-replica combination no legacy replica possessed.

### Joining writer identity and allocator regression

Fixture: canonical artifact was created by writer C with fingerprint `Fc` and canonical writer-state watermark `Nc`. A distinct legacy installation J joins with fingerprint `Fj != Fc` and persisted legacy `last_node_index = Nj`.

Require:

- every Journal record newly authored by J uses `JournalAuthor = Fj`;
- J's joining `WriterStateRecord` records `lastNodeIndex = Nj`;
- J does not adopt Fc as its local writer identity;
- J does not adopt Nc as its local allocator watermark;
- canonical records retain their original C/Fc authorship unchanged.

### Exact shared proof intersection

Fixture:

```text
D -> K
canonical: exact V fresh, D->K valid
joining: exact same V but K was explicitly invalidated, so D->K absent and K stale
```

Expected:

- V is reused;
- `canonicalValid ∩ joiningValid` is the maximum admissible edge set; final replay validity also requires the retained certificate's basis ValueId to match the selected input occurrence;
- here D->K is invalid because joining lacks the edge;
- join authors `proof(V,D)` bootstrap barrier rather than a strengthening validation;
- joined V is persistently stale;
- `pull(K)` cannot take cache-revalidation solely from the canonical proof; K must recompute/revalidate according to the remaining effective proof.

Also test a joining-only proof edge when canonical lacks it: join does not strengthen canonical proof, so the edge remains absent.

### Exact shared K with changed input and legacy Unchanged

Fixture:

```text
D -> K

canonical:
    D = D0
    K = V, fresh, valid against D0

joining legacy:
    D = D1, newer than D0
    K = exact same immutable occurrence V
    K was recomputed against D1 and returned Unchanged
    K fresh, D -> K valid
```

Both legacy graphs contain D -> K and both mark K fresh, but their proof provenance names different D occurrences.

Require:

- K reuses the canonical ValueId V;
- D1 wins current D selection by ordinary bootstrap authority;
- `SharedAdmissibleValid(K)` contains D -> K because both legacy edge sets contain it;
- bootstrap does not retarget V's canonical certificate from D0 to D1 and authors no joining strengthening validation for exact-shared V;
- final replay sees canonical basis D0 mismatch selected D1, so D -> K is invalid and K is hard stale;
- `joinedSharedStaleEvidence(K)` is false because neither legacy side stored direct stale state, demonstrating that final replay staleness can arise in addition to the stale-OR marker rule.

This preserves actual input-occurrence provenance rather than manufacturing proof for a cross-occurrence combination.

### Exact shared stale is symmetric

Case A:

```text
canonical exact V fresh
joining exact V stale
```

joined V is persistently stale.

Case B:

```text
canonical exact V stale
joining exact V fresh with complete local proof
```

Expected:

- joining proof cannot strengthen/replace canonical proof;
- joined V remains persistently stale;
- an uncovered value-scoped bootstrap invalidation applies after proof-edge barriers;
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
2. canonical K remains selected and has complete own effective proof;
3. J2b detects K stale solely through D and authors `Invalidate(K,scope=value(Kc),reason=bootstrap)`;
4. later `pull(D) -> Unchanged` may freshen D but MUST NOT freshen K;
5. K becomes fresh only when K validates/recomputes.

Run this over longer chains/branching DAGs and require one deterministic topological propagation pass to persist every recursive stale transition.

### Late join versus unseen post-bootstrap validation

Fixture:

1. canonical bootstrap cut contains exact occurrence V;
2. cohort later validates V after the cut;
3. a still-legacy host joins from the frozen cut and contributes `proof(V,D)` and/or `value(V)` negative evidence without having observed that post-bootstrap validation;
4. ordinary sync later imports the cohort validation.

Expected: the earlier cohort validation is concurrent with the late-join negative evidence and does not clear it. V remains correspondingly stale/proof-weakened until a validation causally after the late-join evidence re-proves/revalidates it. This is the intentional conservative late-join trade-off; freshness must not be inferred from an ordering the legacy state cannot establish.

### Non-canonical identity-split trade-off

Two late joiners may independently assign different bootstrap ValueIds to the same occurrence which differs from canonical cut. After union one wins and dependent certificates naming the loser may stale/recompute. This is accepted by `$id-1635227135166767`.

## Journal-aware migration tests

Every migration verifies deterministic whole-history format rewrite, one target format, failure-before-cutover safety, replay target equality, and self-describing historical certificates.

Identity-specific cases:

- `keep` preserves selected ValueId;
- `keep` preserves source proof/freshness only where §11a occurrence provenance remains valid; changing a required target input occurrence makes the kept dependent stale even without an explicit freshness decision;
- a recursively stale `keep` preserves unaffected source-replay incoming validity where the relevant target input occurrences are preserved;
- stale `keep` alone does not author proof barriers or force recomputation;
- representation-only rewrite uses `keep` plus the canonical codec;
- explicit `invalidate()` preserves cached occurrence ValueId and authors a true node-scoped invalidation;
- schema/proof/freshness-only changes preserve ValueId and author no replacement ValueEvent unless the semantic occurrence itself is genuinely replaced/created;
- exercise the explicit `replace` decision according to `incremental-graph-journal-migrations.md` §11 and require the M1–M3/postcondition behavior defined there;
- independent true replacements may later stale dependents naming losing occurrence.

### Canonical migration-chain regression

Start replicas X and Y with the same shared v1 Journal history, including at least one immutable record R with the same `JournalRecordId` and body.

- X upgrades through the supported canonical sequence v1 -> v2 -> v3.
- Y remains offline while v2 is current, then later starts under v3 from stored v1.

Y MUST still execute Journal migration semantics v1 -> v2 -> v3, even though it skipped the v2 application release. Once both replicas are at v3:

- every pre-existing shared record ID has a byte-identical v3 body on X and Y;
- any intermediate migration-authored records required by Y's canonical chain are retained normally under Y's writer;
- ordinary synchronization succeeds without `JournalForkError`;
- Y executes the frozen v1 -> v2 edge and then the frozen v2 -> v3 edge; there is no supported direct v1 -> v3 migration path.

Also model a later release that changes the historical v1 -> v2 codec/semantic migration definition while still claiming v1 support. That release MUST be rejected as violating the canonical edge contract; the supported implementation must carry the frozen v1 -> v2 semantics used by earlier replicas. If it cannot, v1 must be unsupported.

Also test that a source version with no complete canonical chain to the running version fails `JournalVersionCompatibilityError`.

### Journal migration target-construction regressions

#### Delete closure and decision conflict

Use target schema `A -> B` with both nodes materialized in the transported source state.

- `delete(A)` with B left undecided propagates delete to B and produces a dependency-closed target absence.
- `delete(A); keep(B)` fails `DecisionConflictError`; migration MUST NOT retain B with a missing required input.
- if the **target schema removes** edge `A -> B`, then `delete(A); keep(B)` is structurally allowed and B is evaluated normally under its remaining target inputs/provenance.

Also leave one unrelated source materialization undecided after delete closure and require `UndecidedNodesError`.

#### Create freshness

For `create(K,value,"up-to-date")` with all required target inputs present/fresh, require a new NodeIdentifier/ValueId, `createdAt == modifiedAt ==` migration finalization time, full target proof against the selected target input ValueIds, and target freshness.

With any required target input stale, the same `"up-to-date"` create fails `InvalidMigrationDecisionError`.

For `create(K,value,"potentially-outdated")`, require a new occurrence which is target-stale and asserts no positive incoming validity edges. For a zero-input K it remains explicitly stale and is represented accordingly by M2/M3.

#### Replace timestamps and clean production

Start with existing K carrying NodeIdentifier I, `createdAt=C`, and `modifiedAt=M0`. `replace(K,newValue)` must create a new ValueId while preserving I and C and setting `modifiedAt` to migration publication/finalization time M1. When all target inputs are fresh, the replacement carries full target proof and is target-fresh. The timestamp change is a semantic replacement under REQ-IFACE-08, not a format rewrite.

### Migration replacement invalidates preserved dependent proof

Fixture:

```text
A -> B
source:
    A = 1 fresh
    B = 2 fresh
    B proof = { A:a1 }
    semantic relation: B = 2 * A

migration decisions:
    replace(A, 2)
    keep(B)
```

Require target-state construction under §11a before M1–M3:

- A receives a new migration ValueId `a2`;
- B preserves its old ValueId and payload 2;
- B's carried A -> B proof edge is absent from `TargetValid(B)` because its source proof named a1 while target A is a2;
- B is hard stale; migration does not claim B=2 is fresh for A=2;
- M2 does not author a validation for old B with basis `{A:a2}` merely to make target replay fresh;
- if migration intends a fresh B=4 under A=2, it must explicitly `replace(B,4)` or use a separately specified future revalidation operation which semantically establishes that proof.

Also cover a multi-input B where only one input is replaced: unaffected provenance-valid edges remain usable as partial proof while the replaced-input edge is lost.

### Migration proof weakening

For maintenance-only weakening of preserved V:

```text
before: selected full certificate for V
migration target: same V with fewer/no validity edges
```

Expected one `proof(V,D)` barrier for every D in `eligibleEffectiveProofUnion(K) - TargetValid(K)` before/with target validation. Old proof may continue to prove unaffected inputs; every non-target edge any eligible retained certificate could expose is barriered. A concurrent/later replacement V2 certificate remains unaffected.

For explicit `invalidate(K)`, expected event remains node-scoped; do not replace actual invalidation semantics with proof barriers.

Add the same two-certificate fixture to maintenance-only migration proof weakening. With target validity empty, migration MUST barrier every edge in `eligibleEffectiveProofUnion(K)`, not merely edges exposed by the initially selected certificate, and final replay must exactly match target validity.

### Migration propagated stale

```text
A -> B
initial: both fresh, B proof {A:a1}
migration: explicit invalidate(A); keep(B)
target: A stale; B persistently stale, proof retained
```

Migration persists value-scoped stale B marker even though replay at cut is already recursively stale. Later `A -> Unchanged` does not freshen B.

### Historical migration callbacks are not replay behavior

Use a migration callback instrumented to fail if invoked after successful migration cutover. Open/replay/synchronize the migrated Journal and rebuild its projection from retained history.

Require:

- replay obtains all historical value/proof state from retained Journal records;
- the historical migration callback is never invoked;
- projection rebuild and later synchronization remain correct without access to that callback.

## Canonical per-record rewrite regressions

Replicas X/Y retain historical V, selected only on X. Same migration must rewrite V identically on both. Representation-only migration uses `keep` for selected semantic state and the canonical codec for every retained V. Later sync must not report `JournalForkError` for V.

The codec MUST be total over retained source history. Include a historical ValueEvent and validation-basis NodeKey for a node family removed from target schema; migration still rewrites/retains those historical records deterministically. If the version migration cannot define that rewrite, it fails `JournalVersionCompatibilityError` before cutover rather than dropping or guessing history.

Add a NodeKey-format transition where source canonical order differs from target canonical order. Assert `rewriteNodeKey` is applied to record node keys, validation-basis inputs, and proof-scope inputs, and that every rewritten ValidationBasis is re-sorted by **target** canonical NodeKeyString order before encoding.

Add the combined selected-occurrence regression:

```text
source selected key Ks has ValueId V
rewriteNodeKey(Ks) = Kt
Ks != Kt
migration decision on id(Ks) = keep
```

Require:

- `keep(id(Ks))` performs schema compatibility against Kt, not Ks, so a codec functor/arity rename succeeds when Kt is valid in the target schema even if Ks is not;
- the conceptual `GconvertedBefore` contains Kt with ValueId V and does not expose Ks as a semantic-repair key;
- final selected node is Kt;
- final ValueId is still V;
- no replacement ValueEvent is authored;
- no DeleteEvent is authored merely because Ks differs from Kt;
- source proof/dependency endpoints are rewritten to target NodeKeys;
- `project(Jafter,targetSchema) == Gtarget`.

Add the complementary create-collision regression: with materialized source Ks and non-identity `rewriteNodeKey(Ks)=Kt`, a Journal-aware callback call `create(Kt,...)` MUST throw `CreateExistingNodeError`. The collision check is against the transported target-key view of all materialized source keys, not the literal source-key lookup table.

Also generate two distinct retained source NodeKeys Ks1/Ks2 whose codec maps both to one Kt. If one replica retains both, migration MUST fail `JournalVersionCompatibilityError` before cutover as a defensive observed-collision check.

More importantly, add the distributed disjoint-history regression. Define a source NodeKey semantic domain containing distinct K1/K2 and a deliberately invalid codec with:

```text
rewriteNodeKey(K1) = T
rewriteNodeKey(K2) = T
```

Replica A retains only history for K1; replica B retains only history for K2. Verify that each replica-local retained-set scan by itself would see no collision, but the migration definition still violates the codec contract before those independent migrations are considered valid. The test/model MUST NOT accept both migrations merely because their local subsets are individually injective. This regression establishes that injectivity belongs to the source->target codec over the complete supported source semantic domain, not to one replica's retained set.

When the source NodeKey domain is finite/enumerable in a test model, exhaustively check the injectivity law. For production domains which are too large or infinite to enumerate, injectivity remains a required property of the codec construction/specification rather than something inferred from local data.

Assert `rewriteComputedValue(sourceKey,payload)` runs for selected and non-selected retained ValueEvents. Codec functions are synchronous, deterministic, and receive no mutable capabilities; a Promise/async transform is rejected as an invalid codec definition. A thrown transform, invalid target representation, or locally observed NodeKey collision fails `JournalVersionCompatibilityError` before cutover.

## Current-format codec tests

For each current database version test golden fixtures, round trip, malformed-field rejection, no per-record version discriminator, mixed-format rejection, and complete explicit format rewrite.

## Corruption tests

At the supported boundary which newly admits/constructs offending records—ordinary local publication for its new batch, synchronization/reset import for newly admitted records, bootstrap construction/join, or Journal-aware migration—reject structural/causal defects in that newly affected state: stream gaps, missing/transitively-open context, wrong own-prefix, authority not extending causality, bad validation references/bases, illegal ordinary `"unknown"`, invalid value/proof scope references, NodeIdentifier collision, decreasing writer-state watermark, mixed record formats, and evidence that an existing local writer has lost a surviving suffix.

Same-ID body disagreement across historical overlap is different: Laws 8/8a prove it impossible for compatible supported lifecycle states. Ordinary sync/reset do not rescan old overlap to rediscover it. An explicitly injected/corrupt fork fixture is rejected when explicit rebuild/maintenance validation actually reads the conflicting history.

Routine open and ordinary absent restoration of an already-committed trusted snapshot are not required to rediscover these conditions by rescanning retained history; their source/committed-state contracts must already hold.

## Transaction failure tests

Inject failures before/during publication and assert no half graph/Journal commit, no durable sequence consumed by failed ordinary operation, volatile state does not outrun disk, and failed maintenance before cutover leaves old active pair selected.

Special cases:
- conditional artifact publication succeeds but its response is lost -> re-query; if the durable artifact belongs to the local creator, creator-resume rather than duplicate creation;
- publication succeeds but creator local cutover fails -> creator-resume;
- publication outcome is indeterminate -> no local cutover until re-query resolves the canonical artifact.

## Streaming correctness tests

Streaming is a correctness requirement under `$id-4924739474925738`, separate from issue #1607's running-time goals.

At minimum:

- replay the same retained Journal with iterator chunk sizes 1, small N, and large N; all projections must be identical;
- use an instrumented Journal/index interface which rejects any request to obtain the complete retained history or all per-node histories as one collection; replay must still succeed;
- include one node with certificate/invalidation history larger than the configured iterator buffer and require correct head/certificate/barrier folding without whole-history materialization;
- synchronize a foreign suffix and dependency/staleness closure larger than the in-memory work-queue threshold; require an iterator/durable-index-backed normalization path and the same final Journal/projection as the reference model;
- reset a domain whose Pass 2 eligible-certificate population and Pass 3 propagation work exceed the in-memory work-queue threshold; require incremental/durable-indexed processing and the same target projection;
- assert every committed state produced by ordinary emission, sync, bootstrap, reset, and migration satisfies `selfProofReady(K) => fresh(K)`;
- separately exercise a pre-marker cut with `selfProofReady(K)` true and a stale direct input, then require the authoring path to add the current-value marker before commit, making the committed implication hold.

These tests verify processing shape and semantic equivalence, not asymptotic elapsed-time bounds.

## Counted eligible-proof summary tests

For one current occurrence V of K and input D, retain two independently eligible/effective certificates which both prove D. The derived summary must report:

```text
eligibleProofEdgeCount(K,V,D) == 2
```

Apply a new invalidation/barrier/input-head change which makes exactly one certificate ineligible or its D entry ineffective. After incremental index maintenance, require count 1 and require D to remain in `eligibleEffectiveProofUnion(K)`. Apply another change which removes the second contribution; require count 0 and D absent from the union.

Run the same transitions through ordinary publication and through staged synchronization/reset cutover. No case may recompute the count by scanning retained certificate history. Explicit rebuild may reconstruct the summary from history and must reproduce the same counts.

## Change-bounded historical validation tests

Validation-cost behavior is a correctness requirement under `$id-6845129073418625`, distinct from the deferred end-to-end synchronization runtime work in `$id-3572255392439745`.

Construct fixtures with a very large unrelated retained-history prefix H and a small affected set C. Through an instrumented Journal/index interface:

- synchronization may read/validate only imported source suffix records, receiver-authored normalization records, retained summaries/index entries they reference, and the affected projection/index closure; a request to rescan unrelated old records fails the test;
- reset reads its target from the same-cut committed source projection, may iterate graph-sized projection state as non-validation work, and may read source Journal records only from missing imported ranges; requesting old source history merely to compute PS fails the test;
- reset derives its current/target domain from current-head/projection state rather than historical Value/Delete scans, and obtains `eligibleEffectiveProofUnion_P1` from the maintained counted proof summary; any fallback which folds unrelated certificate/invalidation history fails the test;
- reset otherwise has the same constraint for imported source records, reset-authored records, and its affected closure;
- ordinary local publication validates only its new batch/projection delta and must not request unrelated retained history;
- bootstrap publication/cutover and absent restoration validate their own source/artifact/cutover contract without adding a full retained-history pass;
- Journal-aware migration and explicit rebuild are the only paths in this fixture permitted to iterate/validate the complete retained Journal.

Vary H while holding the newly admitted/affected set C fixed and require synchronization/reset historical-validation work to remain unchanged with respect to H. The test may still observe graph-sized **non-validation** work permitted by `$id-3572255392439745`; that work must not be misclassified as historical revalidation.

## Performance tests are separate from correctness

Issue #1607 owns future synchronization performance bounds. Whole-journal migration cost is separately accepted. Correctness/property tests must not be weakened for optimization.