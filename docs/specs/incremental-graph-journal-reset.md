# IncrementalGraph Journal 2 Reset

## Purpose

This specification defines controlled reset-to-snapshot behavior for Journal 2 and distinguishes it from same-host restoration.

Reset is not ordinary synchronization. It intentionally replaces an already-established receiver's graph state with a chosen source snapshot and starts a new local journal incarnation.

Journal 2 reset does not import the source journal as receiver history and does not retain Journal 1-style historical reset anchors.

A same-host first-boot recovery of this database's own previously published synchronized state is a different lifecycle transition; see **Same-host restoration** below.

## Preconditions

Reset operates under the lifecycle's exclusive replacement boundary on stable receiver and source snapshots with compatible schema/database versions.

The source snapshot must itself satisfy the Journal 2/legacy graph consistency invariants when Journal 2 is present.

The receiver already has an established local Journal 2 writer identity/state. If no local database exists and the system is recovering this same host's own saved state, use restoration semantics instead of semantic reset.

## Resulting legacy graph

Reset constructs the target legacy graph according to the existing reset semantics for values, timestamps, freshness, validity, identifiers, graph scheme, and database version.

The representation of those sublevels is unchanged.

A reset implementation may avoid rewriting a receiver payload when:

```text
isEqual(receiverValue, sourceValue)
```

for the corresponding semantic node. This is the one Journal 2 synchronization/lifecycle operation allowed to use `ComputedValue` equality for this purpose.

Equality merely permits leaving already-equal payload bytes in place. It does not prove shared ValueId, provenance, causal history, validation history, journal identity, or authority time.

## New journal incarnation

A successful reset increments:

```text
journalIncarnation := journalIncarnation + 1
```

before issuing new cursors.

The local writer fingerprint remains the database's durable writer identity unless the broader database lifecycle explicitly creates a new database identity.

`localJournalCounter` remains monotone across reset and is writer-local; it is not reset to zero and is not raised to remote sequence magnitudes.

Before reset-authored events are allocated, the receiver observes the chosen source's current Journal 2 causal and authority high-water knowledge where available:

```text
causalSummary := componentwiseMax(causalSummary, source.causalSummary)
authorityClock := maxAuthorityTime(authorityClock, source.authorityClock)
```

and joins directly inspected source EventRefs as required.

Every reset baseline event is therefore causally after the semantic history which reset actually observed and advances from an HLC high-water mark at least as great as every observed authority time.

The receiver may retain its accumulated `causalSummary` and `authorityClock`; reset does not require historical per-node reset anchors.

## Receiver-side cursor invalidation

A receiver reset destroys the invariant certified by every receiver-local stored source cursor: that this receiver has incorporated that source through the cursor's `through` coordinate.

The cursor's `incarnation` field names the **source** journal incarnation, not the receiver's. Incrementing the receiver's own `journalIncarnation` therefore does not invalidate receiver-local cursors for other sources by field comparison.

Accordingly, controlled reset MUST atomically delete every receiver-local stored source cursor, for example every record under:

```text
journal/cursors/*
```

as part of installing the reset state.

After reset, incremental synchronization with any source is unavailable until a successful full synchronization establishes a fresh cursor for that source.

Separately, the receiver's incremented journal incarnation invalidates cursors held by other replicas **about this receiver**, because those cursors name the receiver as their source.

## Rebootstrap, not journal import

After the target legacy graph is constructed, Journal 2 creates a new local explanation of that resulting graph.

Define the reset semantic domain as:

```text
ResetKeys =
    representedKeys(preResetReceiver)
    union representedKeys(resetSource)
```

where represented keys include both present heads and tombstoned/absent heads in compacted Journal 2 summaries, plus materialized legacy nodes when bootstrapping a journal-less supported source.

For every materialized target semantic node K:

1. retain/construct the target legacy value/timestamp record according to reset semantics;
2. author a new local `ValueEvent(reason="reset")`, seeding its HLC physical component from that target record's unchanged/copied `modifiedAt`;
3. that new event ID becomes K's new `ValueId`, even if equal payload bytes were reused without rewriting;
4. later author a local `ValidateEvent(reason="reset")` whose basis encodes the resulting legacy incoming validity relation as described below;
5. if the resulting target node is stale, author a local value-scoped soft invalidation after the validation so the projection remains stale.

For every K in `ResetKeys` which is absent from the resulting target legacy graph, author a local `DeleteEvent(reason="reset")`.

This includes a node which is represented only by a tombstone in the chosen source and was completely unknown to the pre-reset receiver. Such a source tombstone has been observed by reset and must be represented by the new local reset baseline; otherwise an older delayed value could later resurrect the node.

These tombstones ensure that both pre-reset receiver values and source-observed absent authority cannot be resurrected merely because their old/source journal summaries are not imported into the new local history.

The set of reset-created events is O(N) and each is individually bounded.

## Encoding target validity

Reset must preserve the resulting legacy `valid` relation without assuming unavailable historical value versions.

After every target present node has received its new reset `ValueId`, build each certificate basis over `inputEdges(K)`:

```text
basis[i] = currentValueId(Di)
    if legacy valid[Di] contains K
basis[i] = "unknown"
    otherwise
```

For a target fresh node, the existing graph invariant guarantees that every required incoming validity edge exists, so the basis contains the current ValueId for every direct input.

For a target stale node, partial or absent validity is represented exactly by current IDs and `"unknown"` sentinels. A following soft invalidation keeps the node stale even when all basis entries happen to match.

No source historical certificate is imported.

## Reset invalidation baseline

The new incarnation's per-node value-specific invalidation state is rebuilt from the resulting target graph rather than carrying arbitrary old value-specific frontier history.

Old node-wide/value-specific journal invalidation frontiers are not required to survive as reset-anchor archives. Reset's newly authored values/certificates/tombstones are a new local baseline.

The global causal summary and HLC authority high-water mark may still remember old/remote history for future causal/authority-safe allocation; those header coordinates are not reset semantic authority for individual nodes.

## Reset laws and theorems

The following properties define the semantic contract of Journal 2 reset. They are normative obligations, not implementation sketches.

Let:

```text
B = Reset(R, S)
```

where R is the pre-reset receiver, S is the chosen stable reset source, and `resetTarget(R,S)` is the legacy graph state constructed by the controlled reset lifecycle after applying the documented host-local preservation rules.

Let `project(X)` be the legacy IncrementalGraph projection of supported Journal 2 state X.

Let `resetContext(B)` denote the causal knowledge observed before the reset baseline events of B are authored, and let `resetAuthorityHighWater(B)` denote the HLC high-water mark after joining the reset-observed authority state and before the first reset baseline event is advanced.

For an event reference E:

```text
coveredByReset(E, B)
```

means E is causally covered by `resetContext(B)` according to the Journal 2 happened-before/context relation.

For a supported state U, define:

```text
CoveredState(U, B)
```

to mean:

1. every semantic NodeKey represented by U is in B's `ResetKeys`; and
2. every synchronization-relevant semantic event reference/frontier coordinate contributed by U is covered by the reset baseline context.

### R1. Projection replacement law

Reset installs exactly the chosen target graph:

```text
project(Reset(R,S)) = resetTarget(R,S)
```

modulo physical storage identities and host-local metadata which the lifecycle explicitly preserves without semantic graph effect.

This is the primary user-visible meaning of reset.

### R2. Fresh-baseline identity law

For every K materialized in `resetTarget(R,S)`, B contains a newly authored local reset `ValueId` for K rather than reusing S's source `ValueId` merely because the payload came from S.

For every K in `ResetKeys` absent from `resetTarget(R,S)`, B contains a newly authored local reset tombstone.

Therefore reset is a semantic rebaseline, not a journal-identity copy.

### R3. Observed-history domination law

Every reset-authored head/certificate/invalidation used to establish the new baseline must be causally after the reset-relevant semantic authority which the reset operation actually observed.

Its HLC authority is allocated after joining `resetAuthorityHighWater(B)`, so every reset-authored baseline event compares later than the observed authority it is intended to supersede.

Consequently, a pre-reset/source authority already covered by the reset cannot later defeat the reset baseline merely by being redelivered from another replica.

This is the anti-resurrection guarantee which motivates reauthoring the target state instead of simply copying S's old semantic identities.

### R4. Covered-state absorption theorem

For any supported U such that:

```text
CoveredState(U, B)
```

and U contains no genuinely post-reset semantic event, normal synchronization of U into B is a semantic no-op:

```text
observe(Sync(B <- U)) = observe(B)
```

where `observe` includes the legacy graph projection and synchronization-relevant Journal 2 semantics.

Intuition: every fact U can contribute is already on the causally old side of the reset cut, and B rebuilt a head/certificate/tombstone baseline for every represented key in that domain.

This theorem is stronger than merely saying that old values do not win: covered old invalidations/certificates also cannot re-stale or otherwise perturb the reset projection after being redelivered.

### R5. Unseen-concurrency non-guarantee

Journal 2 reset does **not** guarantee universal absorption of arbitrary state which was not causally covered by the reset.

If U later presents a semantic authority E for which:

```text
!coveredByReset(E, B)
```

then E may be concurrent with the reset baseline. Ordinary Journal 2 synchronization/conflict rules apply, including HLC authority resolution for competing concurrent heads/certificates, and it is permitted that:

```text
observe(Sync(B <- U)) != observe(B)
```

This is not reset failure. It is the deliberate boundary between the current bounded/local reset contract and a stronger global reset-barrier contract.

### R6. Projection idempotence, semantic non-idempotence

If S is unchanged and the controlled reset target is therefore the same, repeating reset preserves the same user-visible graph projection:

```text
project(Reset(Reset(R,S), S))
    = resetTarget(R,S)
```

However reset is not semantically idempotent as journal state:

```text
Reset(Reset(R,S), S) != Reset(R,S)
```

because a repeated reset advances the local incarnation and may author a fresh baseline with new local event/value identities and later HLC authority.

No Journal 2 convergence rule depends on semantic reset idempotence.

### R7. No per-reset-history accumulation law

After canonical compaction, the retained Journal 2 state need not contain one reset marker, anchor, or baseline record per historical reset.

Repeated resets may replace/subsume prior reset-specific raw history so the compacted-state size depends on the currently represented key/author/counter/authority-clock domain, not linearly on the number of resets performed.

This law does **not** imply that absent keys can always be forgotten: tombstoned keys whose negative authority remains synchronization-relevant still contribute to the retained absent-key term T.

### R8. Post-reset convergence theorem

A completed reset produces an ordinary supported Journal 2 state. Therefore, after graph-changing operations (including further resets) stop, the ordinary Journal 2 convergence theorem applies to the participating connected replicas under its stated fairness assumptions.

Reset does not require a separate convergence mechanism after publication.

## Alternative reset contracts and their trade-offs

The current design is the **rebaseline reset** defined above. Two nearby alternatives illustrate what its guarantees buy.

### A. Source-identity copy reset

A weaker reset could install S's exact semantic heads/ValueIds instead of minting a local baseline:

```text
head(ResetCopy(R,S), K) = head(S,K)
```

Advantages:

- source semantic identity is preserved;
- repeating reset to unchanged S can be closer to semantic idempotence;
- fewer reset-authored value identities are created.

But it does not generally satisfy R3/R4. A pre-reset receiver authority which outranks S but was intentionally discarded by reset can later return through another replica and win again. To recover observed-history absorption, this design would need some additional reset barrier/negative authority, at which point it is no longer a simple source-identity copy.

### B. Current Journal 2 rebaseline reset

The current design satisfies R1-R4 and R7 with only per-key bounded current reset meaning and ordinary causal/HLC header metadata.

Its costs are:

- source ValueIds are not preserved across reset;
- reset is semantically non-idempotent as in R6;
- it deliberately does not provide universal absorption of unseen concurrent state (R5).

This is the current Journal 2 choice.

### C. Global-barrier / epoch reset

A stronger reset contract could require:

```text
for every pre-reset semantic authority E,
even if the resetting replicas had never observed E,
ResetBarrier dominates E when E is encountered later
```

This would strengthen R5 into universal pre-reset absorption.

Such a guarantee cannot be obtained from the current per-event causal context/HLC alone, because an unseen event is by definition not below the reset's observed causal cut. It requires additional globally interpretable reset-era/epoch semantics, including rules for:

- distinguishing pre-barrier from post-barrier events from hosts which were offline during reset;
- ordering or reconciling concurrent independent resets;
- deciding what absence means for keys never enumerated by the reset;
- retaining enough barrier metadata for arbitrarily delayed first/returning hosts;
- incorporating the barrier into every future synchronization/authority decision which may encounter old state.

A global barrier may be useful if universal reset absorption becomes a product requirement, but it is a materially stronger distributed-state model than Journal 2's current local rebaseline reset.

## Same-host restoration

First-boot recovery of this host's own previously published synchronized database state is not `Reset(R,S)` under R1-R8, even if the lifecycle reuses the same snapshot-staging/cutover machinery.

A supported same-host restoration reinstalls the saved Journal 2 state as the continuation of the **same writer history**. It preserves, subject to validation:

```text
writer
journalIncarnation
localJournalCounter
localOperationCounter
causalSummary
authorityClock
node summaries and immutable EventRefs
changed-node markers
receiver-local source cursors
legacy graph/value/timestamp records
```

It does not mint `reason="reset"` ValueIds, does not increment the incarnation merely because the process/installation was recreated, and does not delete valid restored source cursors merely because restoration occurred.

This is safe because the restored cursor/application invariants and writer-local allocation state are part of the exact previously published same-host state being resumed. On the next synchronization, an individual remote source which has reset in the meantime will invalidate its restored cursor by ordinary source-incarnation comparison.

### Restoration no-reuse invariant

A supported restoration MUST NOT resume from a stale writer state if a later event from the same `(writer, journalIncarnation)` could already exist in supported external state while being absent from the restored snapshot. Otherwise the restored writer could reuse a committed `JournalEventId` or move its HLC high-water mark backward.

Therefore arbitrary rollback to an older checkpoint/snapshot of the same writer is outside the supported restoration transition. The supported first-boot path restores the host's authoritative previously published synchronized state; it is recovery, not time travel.

If a product requirement later needs rollback to an older same-writer checkpoint while later same-writer events may survive elsewhere, that must use a new lifecycle transition which prevents ID reuse—for example by creating a new writer identity/incarnation and explicitly specifying how old state is reconciled. It must not masquerade as ordinary restoration.

## Why reset stays within the bound

Let:

- `L` be the number of materialized/present keys in the reset baseline;
- `T` be the number of absent/tombstoned keys retained by the reset baseline;
- `N = L + T`.

Reset creates only a constant number of events/summary components per represented key:

- one value or tombstone authority;
- one certificate for a present value;
- at most one initial stale assertion;
- bounded input ValueId basis;
- ordinary bounded causal/frontier metadata and constant-many HLC authority scalars.

Receiver-local source cursors are deleted rather than accumulated across resets.

After canonical compaction this is:

```text
O((L + T) R log H) bits
```

and each individual journal LevelDB value is:

```text
O(R log H) bits.
```

No term depends linearly on the number of prior resets or historical reset anchors because prior reset-specific per-node history is subsumed by the current incarnation baseline. The retained absent-key term T may nevertheless reflect historical unique-key churn when anti-resurrection authority for those keys remains required.

## Delayed old replicas

A replica which has not participated since before reset may later present old semantic authorities after an arbitrarily long delay.

If those authorities are covered by the reset baseline, R3/R4 apply: redelivery cannot undo the reset.

A genuinely unseen remote authority may be concurrent with the reset and is resolved by ordinary Journal 2 synchronization rules when eventually observed, as stated by R5. Journal 2 does not promise Journal 1's exact absorption of arbitrary unseen reset-anchor history.

No correctness argument in this reset design assumes that such a delayed replica eventually returns at all; this follows the liveness-independent intent `$id-jtwoparticip`.

## Cursor behavior

For semantic reset, two distinct cursor effects apply:

1. cursors held by other replicas about this receiver become invalid because this receiver's `journalIncarnation` changed;
2. cursors stored by this receiver about other sources are explicitly deleted because reset destroyed their incorporated-state invariant.

The reset process rebuilds one changed-node marker per represented node in the new incarnation. A subsequent incremental relationship with any source is established only after a successful full synchronization under the reset receiver state.

Same-host restoration is different: it restores the saved incarnation/cursors unchanged, subject to the restoration invariants above.

## Repeating reset

Repeating reset to an equivalent source snapshot is a new controlled reset operation and therefore may create a new incarnation and new local baseline authority.

Its user-visible projection is idempotent for an unchanged reset target, but its Journal 2 semantic identity is intentionally not; see R6.
