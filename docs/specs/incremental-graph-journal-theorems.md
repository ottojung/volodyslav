# IncrementalGraph Journal 3 Correctness Laws

## Purpose

This document collects the proof obligations an implementation must satisfy.

The other Journal 3 specifications define the model and algorithms. This document states the laws which should drive implementation tests, bounded-model verification, and code review.

The laws are semantic: an optimized implementation may use indexes/checkpoints/incremental folds as long as it is equivalent to the model.

## Law 1: deterministic replay

For one compatible current database version/schema interpretation and one supported well-formed causally closed journal J:

```text
project(J) = P
```

has one unique semantic result.

In particular, replay cannot depend on:

- record arrival order across writers;
- synchronization source enumeration order used to obtain that same final J;
- current wall time;
- random choices;
- computor execution;
- transport ancestry; or
- mutable graph bytes used as a second authority.

Every record in J is already in the one canonical format selected by the replica's current `global/version`; replay does not choose per-record decoders/upcasters.

This law is about replay of a fixed retained history. It does not claim that two counterfactual synchronization executions which authored different normalization records have the same J.

## Law 2: graph/journal isomorphism at commit boundaries

For every supported observable committed database C:

```text
semanticGraph(C.graph) == semanticGraph(project(C.journal))
```

This must hold after:

- ordinary pull/recompute publication;
- `Unchanged`/cache revalidation publication;
- explicit invalidation;
- synchronization cutover;
- reset cutover;
- migration/bootstrap cutover;
- projection rebuild.

No supported committed intermediate state violates this equality.

## Law 3: local emission preservation

Let J be a supported journal with graph projection G.

Run one ordinary graph operation according to the existing IncrementalGraph semantics, producing committed graph G'.

Let `emit(J, G -> G')` append the Journal 3 records required by `incremental-graph-journal-emission.md`, yielding J'.

Then:

```text
project(J') == G'
```

This law must be checked separately for at least:

- fresh pull no-op;
- first materialization;
- changed recomputation;
- `Unchanged`;
- stale cache revalidation;
- explicit invalidation;
- propagated invalidation;
- deletion/materialization removal;
- local identifier-watermark advancement.

## Law 4: no-event no-change

If a public graph call produces no persisted semantic graph transition, it need not append a semantic journal event.

If it appends none, then:

```text
J' == J
project(J') == project(J)
```

API invocation count is not part of semantic history unless an operation record is separately introduced for diagnostics.

## Law 5: authority extends causality

For supported semantic events E and F:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

This includes:

- same-writer stream order;
- cross-writer observation through event context;
- same-publication value-before-validation ordering;
- sync/reset/migration events causally after the imported/observed frontier they normalize.

The initial bootstrap authority exception must still satisfy this law.

## Law 6: reference causality

Every persisted ValueId reference is historical evidence, not a pointer chosen after the fact.

For every ValidateEvent C:

```text
happenedBefore(valueEvent(C.value), C)
```

and for every basis entry B whose `B.value` is not `"unknown"`:

```text
happenedBefore(valueEvent(B.value), C)
valueEvent(B.value).node == B.input
```

For every value-scoped InvalidateEvent I:

```text
happenedBefore(valueEvent(I.scope.value), I)
```

A journal violating these conditions is unsupported rather than replayed with guessed references.

## Law 7: compatible prefix union

For causally closed current-format journals J1 and J2 whose overlapping record IDs agree, define:

```text
U = union(J1,J2)
```

Then retained-information union is:

```text
union(J,J) = J
union(J1,J2) = union(J2,J1)
union(union(J1,J2),J3)
    = union(J1,union(J2,J3))
```

when all overlaps are compatible.

U retains every record from both inputs and remains causally closed once all suffix ranges through the joined frontier are present.

Cross-version peers must migrate before ordinary union/synchronization; union does not reinterpret record formats.

## Law 8: exact-prefix same-writer recovery

If Jlocal's A stream is exactly:

```text
A:1..p
```

and a source contains the agreeing extension:

```text
A:1..q, q >= p
```

then importing `A:(p+1)..q` does not create a writer fork.

After recovery, new local A records start strictly after q and local writer allocator state is reconstructed from the recovered prefix.

If any overlapping A record differs, recovery must fail.

## Law 9: synchronization projection law

Let R and S be compatible supported journals at one current database version.

Let J0 be their compatible prefix union, and let `normalizeSync(R,J0)` append exactly the receiver-authored normalization required by the sync specification, producing Jfinal.

A successful synchronization commits:

```text
receiverJournal = Jfinal
receiverGraph   = project(Jfinal)
```

and retains every source/receiver historical record unchanged by synchronization.

No imported record body is modified by sync.

## Law 10: repeat synchronization no-op

After successful `Sync(R,S)` with no intervening history change on either side, repeating synchronization against the same source snapshot/history yields:

```text
changed = false
no new semantic receiver records
same projected graph
```

This specifically forbids acknowledgement chains and duplicate normalization merely because an existing sync-authored record is observed again.

## Law 11: full sync is zero-frontier sync

An empty receiver frontier is not a distinct semantic algorithm.

For source S:

```text
Sync(empty,S)
```

uses the same suffix import, validation, normalization, and replay rules as a receiver missing only a later suffix.

Any optimization for initial transfer must be observationally equivalent to this rule.

## Law 12: dependency-closure normalization

After successful synchronization/reset/migration projection, current materialization is dependency-closed.

If retained union would select a current cached value K while some direct required input is absent, the final publishable journal must contain causally sufficient explicit absence authority for K and every selected materialized dependent which ordinary IncrementalGraph closure rules require to be removed.

A value must not merely be hidden from the materialized graph while remaining the selected current semantic head in a way that would allow it to reappear automatically later.

## Law 13: persistent propagated staleness

Suppose receiver node K has current ValueId V and is fresh before synchronization.

If synchronization keeps V selected but causes K to become stale, then the final journal contains an uncovered value-scoped invalidation of V (imported or receiver-authored) sufficient to keep K stale until K itself revalidates/recomputes.

Consequently, later revalidation of an upstream input without value change must not automatically make K fresh.

This reproduces the existing flag-based invalidation contract.

## Law 14: validation proof soundness

Every replayed legacy validity edge:

```text
D -> K
```

is justified by one selected eligible ValidateEvent C for K containing exactly one basis entry:

```text
{ input: D, value: currentValueId(D) }
```

Replay must never synthesize one certificate by taking different input edges from unrelated ValidateEvents.

The selected certificate policy may prefer the eligible certificate with the greatest number of current-basis matches, but the resulting validity relation always comes from that one certificate.

For a certificate to be current-schema eligible, its explicit set of `basis[*].input` NodeKeys must equal the current distinct direct-input set for K. Historical certificates for an old schema remain intelligible history but cannot silently become proof for a different current input set.

Every persisted basis has unique input NodeKeys serialized by the current canonical persisted NodeKeyString order, so record decoding/canonical comparison does not require historical schema input ordering.

## Law 15: explicit invalidation is causal

A node-scoped invalidation I for K remains effective against a certificate C unless:

```text
happenedBefore(I,C)
```

A concurrent validation does not clear I merely because its total authority compares later.

This separates proof coverage from value-head conflict ordering.

## Law 16: value-scoped invalidation follows the occurrence

A value-scoped invalidation applies only while its named ValueId is selected for that node.

If another ValueId becomes current, the old occurrence's value-scoped stale marker does not stale the new occurrence.

The historical invalidation remains retained for replay/debugging.

## Law 17: reset target theorem

Let S be the stable reset source and:

```text
PS = project(S)
```

Let reset observe/import the defined receiver+source history and append its reset baseline Jreset.

Then after successful reset:

```text
semanticGraph(project(Jreset))
    == semanticGraph(PS)
```

for present keys, payloads, timestamps, freshness, and validity.

Current ValueIds may differ because reset creates new baseline occurrences. Receiver-local allocator state remains receiver-local.

Unseen third-party history remains concurrent and may affect later synchronization normally.

## Law 18: repeat reset may be a no-op

If the receiver semantic projection already equals the requested unchanged reset target and there is no outstanding reset normalization obligation, reset may return no change without authoring another baseline.

Journal 3 must not require an infinite chain of semantically identical reset events merely because reset was called repeatedly.

## Law 19: bootstrap equivalence

For every supported pre-Journal-3 legacy graph G accepted by the bootstrap migration:

```text
project(bootstrap(G)) == G
```

including current materialization, identifiers, payloads, timestamps, freshness, validity, and local allocation watermark.

Missing historical proof provenance is represented only by the controlled `"unknown"` basis-value sentinel; bootstrap must not invent historical ValueIds.

Bootstrap writes records directly in the target database's one current format.

## Law 20: migration equivalence

For a Journal-3-aware migration:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
Jafter = Jconverted + semantic migration baseline
```

The format rewrite preserves every pre-existing `(author,sequence)`, causal/reference identity, and historical semantic fact. The semantic baseline then establishes target graph Gtarget such that:

```text
project(Jafter, targetSchema) == Gtarget
```

Future replay does not execute the old migration callback and does not need source-format record decoders.

Historical certificates retain their semantic input NodeKeys after representation rewrite even when the current schema has changed.

## Law 21: writer sequence contiguity

For every committed writer A with head q:

```text
records(A) == A:1..q
```

with no missing durable coordinate.

Failed local transactions consume no durable journal position.

One successful atomic publication allocates one contiguous block after the latest committed/recovered local head.

Database-format migration may rewrite bodies but must not insert, remove, or renumber pre-existing writer coordinates.

## Law 22: writer-state monotonicity

Within one writer stream, `WriterStateRecord.lastNodeIndex` is nondecreasing.

Replay of writer A's local projection uses the latest retained A writer-state record (or the defined initial value).

Foreign writer-state records never advance another writer's local allocator watermark.

Together with the accepted collision resistance of `DatabaseFingerprint`, monotone non-reuse of the local allocation index is the NodeIdentifier uniqueness basis for continuing local allocation.

## Law 23: replay rebuild safety

If authoritative current-format journal J is valid, rebuilding all derived graph/index state from J yields a graph observationally equivalent to the pre-rebuild supported graph:

```text
rebuild(project(J)) == project(J)
```

A rebuild may fix derived-state damage; it may not mutate J to hide journal corruption. Journal representation changes belong only to the explicit database migration path.

## Law 24: single-format migration preservation

For a supported source->target database migration, define the canonical record transformation:

```text
migrateRecord(sourceVersion, targetVersion, R) = R'
```

For every pre-existing source record R:

```text
R'.id == R.id
historicalMeaning(R') == historicalMeaning(R)
```

and the transformation is deterministic:

```text
same source record + same migration definition
    => same canonical target record
```

It may change representation fields but not journal identity, writer position, causal fact, authority fact, or reference identity.

After successful migration, every retained record in the target replica is in the target `global/version` format. There are no per-record version stamps and ordinary replay/synchronization has no mixed-version upcast/downcast semantics.

Whole-journal time/I/O for satisfying this law is an accepted trade-off.

## Law 25: fair-execution synchronization convergence

Consider one actual execution with finitely many supported replicas and a finite current schema DAG.

Assume that after time T all **non-normalization graph-changing operations stop**. In particular, after T there are no new ordinary ValueEvent/ValidateEvent-producing graph changes, resets, or migrations; synchronization may continue and may author only its defined normalization records.

Under fair synchronization after T:

1. only finitely many `DeleteEvent(reason="sync")` and value-scoped `InvalidateEvent(reason="sync")` records are required;
2. normalization eventually reaches a fixed point;
3. every actually authored immutable historical record is eventually disseminated to every connected participating replica;
4. every such replica eventually has an observably equivalent projection; and
5. further synchronization without new non-normalization history is a semantic no-op.

The finiteness argument is:

- normalization creates no new ValueEvent or ValidateEvent;
- a sync delete defeats the already-observed positive head which required structural repair, and another repair for that node can require only some previously unseen finite positive history;
- a sync value-scoped invalidation fixes one exact ValueId stale and normalization cannot clear it because it creates no validation;
- each newly learned finite fact has only a finite dependent closure in the finite DAG.

This law does **not** require counterfactual confluence. Two different synchronization schedules may have committed different real normalization events before all concurrent facts were observed, and therefore may define different histories/results. Each actual fair execution must converge relative to the events it actually authored.

## Suggested implementation verification

At minimum, implementation work should include tests/models which exercise:

- every local emission case from Law 3;
- concurrent independent writers changing the same node;
- causal overwrite after observing a remote value;
- node invalidation concurrent with validation;
- multi-input certificates with competing partial basis matches;
- canonical self-describing basis encoding and current-schema eligibility;
- receiver-only dependent stale propagation;
- dependency deletion closure;
- repeat synchronization;
- fair-execution normalization termination with multiple source orders;
- same-writer exact-prefix recovery and fork rejection;
- bootstrap of stale nodes with partial validity;
- reset target equivalence;
- migration target equivalence;
- deterministic whole-journal format rewrite preserving IDs;
- rebuild from journal only;
- malformed future/concurrent ValueId references.

A bounded executable model is strongly encouraged for conflict/replay/synchronization laws because many of these properties quantify over event-order interleavings rather than one hand-written happy path.