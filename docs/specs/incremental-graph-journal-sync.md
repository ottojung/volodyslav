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

A completely absent installation uses the receiver-less restoration lifecycle in `database-lifecycle.md` before ordinary synchronization.

## Semantic API

```text
synchronizeFrom(source: JournalSyncSource) -> SyncResult
```

`JournalSyncSource` is transport-neutral. It does not by itself prove that a snapshot is authoritative for resuming the receiver's own writer identity.

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

## Receiver-local writer must never be recovered from an ordinary sync source

Suppose receiver local writer is W.

If the ordinary source snapshot contains:

```text
FS[W] > FR[W]
```

then the receiver is demonstrably behind a surviving longer prefix of **its own writer stream**.

Ordinary synchronization MUST NOT simply import that suffix and continue authoring W. A peer that happens to retain `W:1..q` does not prove that q is the greatest durable W record which can later re-enter supported history. Continuing W after incomplete recovery could allocate an ID already used by an escaped record.

Therefore pairwise synchronization fails before publication or local normalization with:

```text
JournalWriterBehindError
```

and requires the lifecycle's authoritative same-writer recovery transition first.

The authoritative recovery source is the configured `InstallationRecoverySource` from `database-lifecycle.md` / `incremental-graph-journal-api.md`. It may authorize continuation only when it can provide a stable snapshot whose W head is complete for the continuing installation under that source's contract. If completeness is indeterminate, recovery fails rather than guessing a continuation point.

After authoritative recovery advances the receiver to the complete recovered W head and reconstructs allocator/high-water/projection state, ordinary synchronization may be retried.

This is distinct from:

- a foreign writer suffix, which ordinary synchronization may import normally;
- an absent installation, which uses receiver-less restore; and
- pre-Journal creator-resume, which uses the frozen canonical bootstrap artifact.

## Immutable overlap law

For every record ID retained on both sides, canonical current-format meaning must agree exactly. Disagreement is `JournalForkError`; it is not repaired using payload equality, event authority, source preference, Git ancestry, or record-ID remapping.

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

If selected current value K has a required direct input D whose selected head is absent, K cannot remain materialized.

Compute the selected dependent-removal closure and author:

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

Compute:

```text
P1 = project(J1)
```

For each present K let C be its replay-selected certificate. Replay selects certificates using:

```text
1. effectiveBasisMatchCount
2. coversValueInvalidations (true > false)
3. authority
```

where proof-edge barriers may remove individual basis matches.

Define:

```text
selfProofReady(K) iff
    C exists
    and effectiveBasisMatchCount(K,C) == numberOfDirectInputs(K)
    and coversValueInvalidations(K,C)
```

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

Before cutover require:

- held source version/schema exactly matched receiver metadata;
- every retained writer stream is contiguous;
- overlaps have one meaning;
- contexts have exact own prefix and transitive closure;
- happened-before implies increasing authority;
- ValueId references satisfy reference causality;
- validation bases are canonical and duplicate-free;
- selected-present heads are dependency-closed;
- selected NodeIdentifiers are bijective;
- replay-selected certificates obey current schema and proof-edge barriers;
- every occurrence stale solely through stale direct inputs has persistent current-value stale history;
- local writer allocator/high-water state remains consistent with its retained local stream; and
- all IncrementalGraph invariants and `oldValue` safety hold.

The target graph is exactly `project(Jfinal)` lowered to existing storage.

## Synchronization-authored allocation

A sync-authored Delete/Invalidate event:

1. observes the complete imported/receiver closed frontier;
2. receives exact own-prefix/transitively closed context;
3. receives authority after observed semantic high-water;
4. consumes the next receiver writer sequence; and
5. participates in future synchronization normally.

No such event may be allocated while the receiver has detected unrecovered later history for its own writer.

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

Missing foreign suffixes must be streamable without retaining the full history/suffix in RAM. Normalization may use graph-sized derived state where correctness requires it.

## Pairwise result law

Successful `Sync(R,S)`:

1. checked compatibility from the held snapshot;
2. retained every compatible imported foreign record unchanged;
3. did not infer own-writer completeness from an ordinary peer snapshot;
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

## Delayed/absent replicas

Correctness never requires every peer to acknowledge or return. A delayed supported replica can later provide/import immutable foreign suffixes.

Resuming **this installation's own writer after local history loss** is different: continuation requires the authoritative installation-recovery contract above so old local sequence numbers cannot be reused.

## Multi-source execution

The core operation is pairwise against one held source snapshot. An outer procedure may process multiple sources sequentially; successful earlier sources may commit even if a later source fails.

If any source reveals the receiver is behind its own writer, that pairwise operation stops with `JournalWriterBehindError` and no normalization is authored for that failed operation. Lifecycle recovery must happen before retry.

## Version boundary

Ordinary synchronization operates only across exactly compatible current version/schema interpretations. Cross-version transition belongs to migration; synchronization does not rewrite source records.
