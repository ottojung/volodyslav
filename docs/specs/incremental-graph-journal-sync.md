# IncrementalGraph Journal 3 Synchronization

## Purpose

Journal 3 synchronization replicates immutable Journal history and materializes deterministic replay. Mutable graph sublevels are not independent synchronization authority.

For an already-established writable receiver the conceptual operation is:

```text
open one stable compatible JournalSnapshot
copy every missing foreign-writer suffix
validate immutable history and causal closure
normalize only required IncrementalGraph semantic transitions
project final Journal
atomically publish Journal + projection
```

A completely absent installation uses the receiver-less restoration lifecycle in `incremental-graph-journal-lifecycle.md` before ordinary synchronization.

## Semantic API

```text
synchronizeFrom(source: JournalSyncSource) -> SyncResult
```

`JournalSyncSource` is transport-neutral. It does not repair or redefine the receiver's own writer history.

## Preconditions

Synchronization requires:

- a valid writable receiver with established `localWriter`;
- one stable source `JournalSnapshot`;
- exact compatible `databaseVersion` and `graphSchemeString` from that same snapshot;
- contiguous receiver/source writer prefixes;
- transitively closed semantic-event contexts;
- a valid receiver Journal/projection pair;
- exclusive receiver maintenance ownership for staging/normalization/cutover; and
- no conflicting canonical content under one `JournalRecordId`.

## Snapshot compatibility cut

The held source snapshot supplies one immutable committed state:

```text
S.databaseVersion
S.graphSchemeString
S.localWriter
S.frontier
S.records
```

Before interpreting source history require exact equality with the receiver's active version/schema. Earlier mutable metadata is not sufficient. Mismatch is `JournalVersionCompatibilityError`; synchronization never performs implicit migration.

## Missing foreign-writer suffixes

Let receiver/source frontiers be `FR` and `FS`.

For every writer A where:

```text
A != receiver.localWriter
FS[A] > FR[A]
```

import exactly:

```text
A:(FR[A]+1) .. FS[A]
```

in ascending writer-local sequence order.

No node summary substitutes for missing authoritative history.

## Receiver-local writer ahead in the source is unsupported state

Suppose receiver local writer is W.

If the ordinary source snapshot contains:

```text
FS[W] > FR[W]
```

then the receiver is demonstrably behind a surviving longer prefix of **its own writer stream**.

Under the lifecycle fault model, an existing supported local database does not lose or roll back part of its own writer history. Complete local loss produces the `Absent` state and uses absent restoration; partial rollback/truncation is outside the supported lifecycle model.

Therefore pairwise synchronization fails before publication or local normalization with:

```text
JournalWriterBehindError
```

This error is diagnostic evidence of corrupted/unsupported lifecycle state, such as partial local rollback/loss, unsupported cloning, or externally manipulated persistence. Ordinary synchronization MUST NOT import the missing own-writer suffix and MUST NOT invoke a same-writer recovery transition, because no such supported transition exists.

This is distinct from:

- a foreign writer suffix, which ordinary synchronization may import normally;
- an absent installation, which uses receiver-less restore; and
- pre-Journal creator-resume, which uses the frozen canonical bootstrap artifact as part of its explicitly defined controlled transition.

## Immutable overlap law

For every record ID retained on both sides, canonical current-format meaning must agree exactly. This enforces `$id-2567281946348705` when supported states are combined. Disagreement is `JournalForkError`; it is not repaired using payload equality, event authority, source preference, Git ancestry, or record-ID remapping.

## Foreign records remain foreign

Imported foreign records preserve original writer/sequence, context, authority, payload/timestamps, and references. Receipt creates no acknowledgement/adoption semantic event.

## Imported causal closure

For semantic event `F=(W,q)`:

```text
F.context[W] == q - 1
```

and if F includes semantic event E, then componentwise:

```text
E.context <= F.context
```

All claimed context coordinates must be retained. Staging may temporarily be incomplete, but malformed immutable context is rejected rather than repaired.

## Stable snapshot union

After foreign suffix acquisition:

```text
J0 = union(JR, imported foreign suffixes)
```

with agreeing overlaps.

Compatible immutable prefix union is idempotent, commutative, and associative at the retained-information level. A partially streamed staging target is not publishable until required records are present and validated.

## Normalization versus raw union

Raw union may select a graph state that neither input separately materialized. Journal 3 may therefore append receiver-authored semantic normalization before cutover. These are real semantic records, not transport acknowledgements.

## Phase 1: dependency-closure removal

Let:

```text
H0 = selectedHeads(J0)
```

using the raw maintenance view from `incremental-graph-journal-replay.md` §Raw selected-head view. Synchronization does not require `project(J0)` before structural normalization.

If H0 selects a ValueEvent for K and a required direct input D is absent under H0, K cannot remain materialized.

Compute that raw selected dependent-removal closure and author:

```text
DeleteEvent {
    node: K,
    reason: "sync"
}
```

for every selected-present K in that closure, ordered cause-before-dependent. The records observe the complete imported closed frontier and use ordinary authority allocation after observed high-water.

Call the result `J1`. Its selected present values must be dependency-closed.

This is the ordinary synchronization case which destroys a cached dependent because merged state makes it structurally non-materializable. By contrast, input-version disagreement with all required inputs still present does **not** delete the cache: the selected cached value remains a legitimate `oldValue`; proof/freshness determine whether it is fresh, soft-stale, or hard-stale.

## Phase 2: persist staleness caused only by stale direct inputs

Denotationally compute:

```text
P1 = project(J1)
```

A conforming implementation derives the needed P1 state incrementally over the affected dependency closure using retained projection/index state; this notation does not authorize a full retained-history replay during synchronization (`$id-6845129073418625`).

Use `selfProofReady(K)` as defined in `incremental-graph-journal-replay.md` §Persistent propagated staleness, evaluated at this pass's replay cut.

Node invalidation affects certificate eligibility; `proof(value,input)` barriers reduce effective proof edge-by-edge.

If:

```text
selfProofReady(K)
and some direct input D is stale in P1
```

then K is stale solely through recursive input freshness. Synchronization must ensure an uncovered marker exists:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: P1.valueId(K) },
    reason: "sync"
}
```

unless one already applies.

This includes a newly selected imported ValueId. Later upstream `Unchanged` may freshen the input but must not silently freshen K.

No duplicate sync marker is required when K already has a persistent own-state reason for staleness, including:

- an effective basis deficit (basis mismatch or proof-edge barrier);
- an uncovered node invalidation; or
- an uncovered current-value invalidation.

Apply this rule through the affected dependency closure. Issue #1607 owns any future tighter running-time bound.

Call the result `Jfinal`.

## Final replay and validation

The checks below apply to newly imported records, receiver-authored normalization records, and the affected projection/index closure. Unrelated retained history is not rescanned or revalidated, as required by `$id-6845129073418625`.

Before cutover require:

- held source version/schema exactly matched receiver metadata;
- newly admitted writer suffixes are contiguous with their retained prefixes and contain no conflicting overlap;
- contexts of newly admitted/authored records have exact own prefix and transitive closure against retained context summaries/indexes;
- authority of newly admitted/authored records extends happened-before using persisted/derived high-water and causal indexes;
- ValueId references introduced by newly admitted/authored records satisfy reference causality;
- newly admitted/authored validation bases are canonical and duplicate-free;
- affected selected-present heads are dependency-closed;
- affected selected NodeIdentifiers remain bijective;
- replay-selected certificates for affected nodes obey current schema and proof-edge barriers;
- the committed projection satisfies `selfProofReady(K) => fresh(K)` (`incremental-graph-journal-replay.md` §Persistent propagated staleness);
- local writer allocator/high-water metadata remains consistent after this cutover; and
- affected IncrementalGraph invariants and `oldValue` safety hold.

Denotationally, the target graph is exactly `project(Jfinal)` lowered to existing storage. A conforming implementation establishes that result by validating/updating the affected closure and durable indexes/checkpoints; it does not obtain the result by rescanning unrelated retained history.

## Synchronization-authored allocation

A sync-authored Delete/Invalidate event:

1. observes the complete imported/receiver closed frontier;
2. receives exact own-prefix/transitively closed context;
3. receives authority after observed semantic high-water;
4. consumes the next receiver writer sequence; and
5. participates in future synchronization normally.

No such event may be allocated after synchronization has detected a surviving longer prefix of the receiver's own writer; that operation has already failed as unsupported state.

## Atomic publication

Transfer may stream into inactive durable staging. Active state changes only at final cutover, which publishes together:

```text
Jfinal
project(Jfinal)
local writer allocator/high-water state
derived indexes/caches required by the implementation
```

Failure before cutover leaves the previous active supported state selected.

## Zero-frontier synchronization

An already-established fresh receiver may have frontier zero and import foreign writer histories using the same algorithm. That is not absent-installation restoration and does not authorize adopting a foreign writer as `localWriter`.

## Streamability

Synchronization processing MUST satisfy `$id-4924739474925738`.

Missing foreign suffixes are consumed incrementally and must not require the full retained Journal or complete transferred suffix in RAM.

Normalization may use graph-sized derived graph/index state where IncrementalGraph correctness independently requires it, but Journal-derived work such as the dependency-removal closure, stale-propagation worklist, or complete changed-node set must be incrementally iterable. It may live in durable/indexed staging or an equivalent bounded-memory work-queue representation; the algorithm MUST NOT require the complete closure/change set to exist as one in-RAM collection.

This streamability requirement is independent of the deferred end-to-end running-time bound in `$id-3572255392439745`. Synchronization may still perform graph-sized whole-replica **non-validation** work where correctness requires it, but historical validation/replay work attributable to the synchronization remains bounded by newly admitted/affected state C under `$id-6845129073418625`; unrelated retained Journal history is not rescanned.

## Pairwise result law

Successful `Sync(R,S)`:

1. checked compatibility from the held snapshot;
2. retained every compatible imported foreign record unchanged;
3. observed no source evidence that the receiver had lost part of its own writer history;
4. added only justified receiver normalization;
5. committed `receiverGraph = project(receiverJournal)`; and
6. becomes a semantic no-op when repeated against the same incorporated source without intervening changes.

## Convergence and termination

After non-normalization graph-changing operations stop, synchronization may author only:

```text
DeleteEvent(reason="sync")
InvalidateEvent(reason="sync", scope=value(...))
```

It creates no ValueEvent or ValidateEvent.

A sync delete defeats an already-observed selected positive occurrence that violates structural closure. Another can become necessary only when previously unseen finite positive history selects another occurrence.

A sync value invalidation makes one exact occurrence persistently stale; sync normalization cannot clear it because clearing requires a later validation.

With finite pre-existing positive history and a finite schema DAG, only finitely many normalization obligations arise after quiescence. Fair synchronization eventually disseminates actual authored records, participating replicas reach equivalent projections, and further synchronization is a semantic no-op.

This is convergence of each actual fair execution, not counterfactual confluence between schedules that genuinely authored different normalization history.

### Host-count bounded settling schedule

The stronger operation-count requirement in `$id-5631842079463518` is an achievable-schedule property, not a bound on every arbitrary fair ordering.

Call a successful pairwise synchronization **state-advancing** when it imports at least one retained record not already present at the receiver or authors at least one receiver normalization record.

For a quiescent compatible participation epoch with H >= 1 replicas, choose any participating replica C as a collector and keep the other replicas idle except when they are the source or receiver of the following operations:

1. **Gather.** For each other replica R, run `Sync(C,R)` once. After at most H-1 state-advancing operations, C contains every record present on every participant at the start of the settling schedule. Each gather operation computes the complete dependency-removal closure and propagated-staleness closure before publishing, so after the final gather C is normalized for the complete gathered history.
2. **Broadcast.** Keep C unchanged and, for each other replica R, run `Sync(R,C)` once. R has authored no history during the gather, and C already imported R's complete starting history, so R's retained Journal is a subset of C's final Journal. The raw union is therefore exactly C's Journal. Because C is already fully normalized for that history, the broadcast requires no new semantic normalization; R adopts the same retained closure and projection.

After the broadcast every participant has the same retained synchronized Journal closure and equivalent projection, and further synchronization is a semantic no-op.

Thus settling is achievable within at most:

```text
2 * (H - 1)
```

state-advancing successful pairwise synchronizations. For H >= 2 this is at most H^2; for H = 1 it is zero.

This bound is independent of the number of retained records and the size/depth of the schema DAG. Those quantities may affect the CPU, I/O, memory, and bytes transferred by each synchronization, but not this operation-count construction.

Arbitrary fair schedules remain governed by the eventual-convergence rule above and are not claimed to satisfy the H^2 operation-count bound.

## Delayed/absent replicas

Correctness never requires every peer to acknowledge or return. A delayed supported replica can later provide/import immutable foreign suffixes.

Complete loss of this installation's local database is handled by the absent-state restoration lifecycle. Partial loss of this installation's own writer history while an existing local database remains is outside the supported lifecycle model and is not repaired by synchronization.

## Multi-source execution

The core operation is pairwise against one held source snapshot. An outer procedure may process multiple sources sequentially; successful earlier sources may commit even if a later source fails.

If any source reveals the receiver is behind its own writer, that pairwise operation stops with `JournalWriterBehindError` and no normalization is authored for that failed operation. The receiver is then corrupted/unsupported for ordinary lifecycle use until handled by an explicitly defined future recovery process outside the current model.

## Version boundary

Ordinary synchronization operates only across exactly compatible current version/schema interpretations. Cross-version transition belongs to migration; synchronization does not rewrite source records.
