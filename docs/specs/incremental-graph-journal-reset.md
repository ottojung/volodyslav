# IncrementalGraph Journal 2 Reset

## Purpose

This specification defines controlled reset-to-snapshot behavior for Journal 2 and distinguishes it from same-host restoration.

Reset is not ordinary synchronization. It intentionally replaces an already-established receiver's graph state with a chosen source snapshot and starts a new local journal incarnation.

Journal 2 reset does not import the source journal as receiver history and does not retain historical per-node reset anchors.

A same-host first-boot recovery of this database's own previously published synchronized state is a different lifecycle transition; see **Same-host restoration** below.

## Preconditions

Reset operates under the lifecycle's exclusive replacement boundary on stable receiver and source snapshots with compatible schema/database versions.

Both the receiver and the chosen reset source MUST already contain valid compatible Journal 2 state. A journal-less or pre-Journal-2 snapshot is not a supported semantic reset source.

The receiver already has an established local Journal 2 writer identity/state. If no local database exists and the system is recovering this same host's own saved state, use restoration semantics instead of semantic reset.

Before any source-header observation, reset MUST require:

```text
source.causalSummary[receiver.writer] <= receiver.localJournalCounter
```

This is the canonical observation safety condition from `incremental-graph-journal-types.md`. A source which knows a later event coordinate for the receiver's own writer identity cannot be consumed by reset, because importing that coordinate without the corresponding local allocator state would permit event-ID reuse.

A controlled reset source MAY have the same writer identity as the receiver only when it is not ahead of the established receiver writer state:

```text
source.writer == receiver.writer
    => source.localJournalCounter   <= receiver.localJournalCounter
       source.localOperationCounter <= receiver.localOperationCounter
       source.journalIncarnation    <= receiver.journalIncarnation
```

The semantic-counter condition is implied by valid headers plus the writer-coordinate invariant, but is stated explicitly here as a reset precondition. The operation-counter condition prevents reuse of a same-writer historical `OperationId`, and the incarnation condition prevents reset from reusing a same-writer source incarnation which already exists ahead of the receiver. A same-writer source which is ahead in any of these coordinates requires supported restoration/reconciliation rather than controlled reset.

In addition to those numeric conditions, a same-writer reset source MUST be an authoritative snapshot from that writer's own continuing history under the supported database lifecycle. A snapshot from a distinct installation or continuing host history which merely shares the same `DatabaseFingerprint` is not a supported same-writer reset source, even if all three coordinates above are less than or equal to the receiver's. Cross-host snapshot cloning is outside the supported lifecycle as specified in `incremental-graph-fingerprint.md`; reset does not reinterpret such a clone as an older state of the receiver's writer history.

This provenance condition is a supported-lifecycle precondition, not a claim that the Journal header can cryptographically prove snapshot origin. Reset may rely on the controlled lifecycle path which selected the source; it is not required to infer clone provenance from the equal writer identity alone.

These conditions still permit an already-established database to reset semantically to an older/equal authoritative snapshot of its own writer history. That is distinct from first-boot same-host restoration: reset retains the receiver's allocator frontier, increments its incarnation, and authors a fresh reset baseline rather than resuming the source counters as the active writer state.

## Resulting legacy graph

Reset constructs the target legacy graph according to the existing reset semantics for values, timestamps, freshness, validity, identifiers, graph scheme, and database version.

The representation of those sublevels is unchanged.

A reset implementation may avoid rewriting a receiver payload when:

```text
isEqual(receiverValue, sourceValue)
```

for the corresponding semantic node. This is the one Journal 2 synchronization/lifecycle operation allowed to use `ComputedValue` equality for this purpose.

Equality merely permits leaving already-equal payload bytes in place. It does not prove shared ValueId, provenance, causal history, validation history, journal identity, authority time, or creation time.

Every materialized reset target must contain a parseable legacy timestamp record satisfying `canonical(createdAt) <= canonical(modifiedAt)`. The reset baseline retains `canonical(createdAt)` as that node's `CreationTime`; it does not manufacture a creation time from reset execution time.

## New journal incarnation

A successful reset increments:

```text
journalIncarnation := journalIncarnation + 1
```

before issuing new cursors.

The local writer fingerprint remains the database's durable writer identity unless the broader database lifecycle explicitly creates a new database identity.

`localJournalCounter` remains monotone across the controlled reset transition and is writer-local; it is not reset to zero and is not raised to source sequence magnitudes.

`localOperationCounter` also remains monotone across reset and is not restarted. `OperationRecord.incarnation` records the journal incarnation in which the operation occurred; operation identity remains `{ author, sequence }` and uniqueness does not depend on reusing operation sequence numbers in a new incarnation.

Before reset-authored events are allocated, the receiver observes the chosen source's Journal 2 causal and authority high-water knowledge only after the preconditions above have established that the source's coordinate for the receiver writer cannot exceed the receiver allocator frontier:

```text
causalSummary := componentwiseMax(causalSummary, source.causalSummary)
authorityClock := maxAuthorityTime(authorityClock, source.authorityClock)
```

The join therefore leaves `causalSummary[receiver.writer] == localJournalCounter` and cannot move the receiver's own writer coordinate ahead of its allocator. These causal and authority observations are coupled and MUST preserve J2-INV-7 and J2-INV-9 in the same publication. Every reset baseline event is therefore causally after the semantic history which reset actually observed and advances from an HLC high-water mark at least as great as every retained head/certificate authority represented by either reset input.

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

where represented keys include both present heads and tombstoned/absent heads in compacted Journal 2 summaries.

For every K in `ResetKeys`, first retain the node-scoped invalidation knowledge already observed by reset:

```text
resetNodeInvalidateFrontier[K] = componentwiseMax(
    preResetReceiver.nodeInvalidateFrontier[K],
    resetSource.nodeInvalidateFrontier[K]
)
```

where a missing summary contributes the zero/empty frontier. This retained frontier is synchronization-relevant semantic summary state, not imported raw source history and not a newly authored invalidation event. It remains attached to K whether the reset target makes K present or absent.

First enumerate every materialized target semantic node in canonical NodeKey order. For every such K:

1. retain/construct the target legacy value/timestamp record according to reset semantics;
2. set the reset node summary's `createdAt` to `canonical(target.timestamps[K].createdAt)`;
3. author a new local `ValueEvent(reason="reset")`, using the ordinary ValueEvent HLC seed from that target record's unchanged/copied `modifiedAt`;
4. that new event ID becomes K's new `ValueId`, even if equal payload bytes were reused without rewriting.

The new reset `ValueId` identifies the reset-authored value occurrence, not the node's creation time. It also establishes a new selected-head lineage for future creation-time joins: the target's `CreationTime` is carried by that new head, while pre-reset losing heads and tombstones cannot contribute their old creation times. A later synchronization combines creation times only with another summary carrying this same selected reset head, according to `joinCreation` in `incremental-graph-journal-projection.md`.

The `modifiedAt` seed does not determine reset enumeration or distinguish reset value authorities. Each target value/timestamp record comes from a value occurrence represented by the pre-reset receiver or reset source; that occurrence's authority time is at least its own `modifiedAt`, and J2-INV-9 places that authority beneath the corresponding input header. Reset joins both input authority clocks before authoring the baseline, so the joined `authorityClock.physical` already dominates every target `modifiedAt`. The ordinary HLC allocator therefore keeps reset value events on that joined physical high-water coordinate and advances their logical coordinate in canonical NodeKey order. Reset authority is deliberately above the observed cut without assigning additional conflict meaning to target timestamp order.

After all target present nodes have their reset ValueIds, author the validation/invalidation baseline in deterministic semantic topological order:

5. author a local `ValidateEvent(reason="reset")` whose basis encodes the resulting legacy incoming validity relation as described below;
6. if the resulting target node is stale, author a local value-scoped `InvalidateEvent(reason="reset")` after the validation so the projection remains stale.

For every K in `ResetKeys` which is absent from the resulting target legacy graph, author a local `DeleteEvent(reason="reset")` in deterministic canonical NodeKey order. The resulting absent summary retains no `createdAt`.

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

For a target fresh node, the existing graph invariant guarantees every required incoming validity edge exists, so the basis contains the current ValueId for every direct input.

For a target stale node, partial or absent validity is represented exactly by current IDs and `"unknown"` sentinels. A following value-scoped `InvalidateEvent(reason="reset")` keeps the node stale even when all basis entries happen to match.

No source historical certificate is imported.

## Reset invalidation baseline

Node-scoped and value-scoped invalidation state deliberately behave differently across reset.

`nodeInvalidateFrontier` is independent of the selected `ValueId` and remains future-relevant across value replacement. For every K in `ResetKeys`, the reset summary therefore retains exactly `resetNodeInvalidateFrontier[K]`, the componentwise maximum of the pre-reset receiver and reset-source node frontiers. This applies to both present and absent reset results.

By J2-INV-8, each retained node-frontier coordinate in the pre-reset receiver is covered by the receiver's own `causalSummary`, and each retained node-frontier coordinate in the reset source is covered by the source's own `causalSummary`. Reset joins those causal summaries componentwise before authoring its baseline events, so the resulting reset context necessarily covers `resetNodeInvalidateFrontier[K]`. Therefore a reset certificate for a present node has a context covering the retained node frontier. Preserving the frontier does not by itself make the reset target stale or alter the target legacy validity relation.

Retaining that frontier is nevertheless necessary for future synchronization. A later competing value/certificate which did not observe an old explicit node invalidation must still be constrained by that invalidation, and redelivery of an already-covered pre-reset/source summary must not mutate the reset node summary merely by reintroducing a forgotten frontier coordinate.

Old **value-scoped** invalidation frontiers are different: they belong to old `ValueId`s, while reset gives every present target node a fresh reset `ValueId`. Those old value-specific frontiers are discarded. A stale reset target instead receives the new value-scoped `InvalidateEvent(reason="reset")` authored in the reset baseline for its new reset `ValueId`.

The global causal summary and HLC authority high-water mark may still remember old/remote history for future causal/authority-safe allocation; those header coordinates complement, rather than replace, the retained per-node node-invalidation frontier.

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

to mean all of:

1. every semantic NodeKey represented by U is in B's `ResetKeys`;
2. every synchronization-relevant semantic event reference and value-scoped frontier coordinate contributed by U is covered by `resetContext(B)`;
3. for every represented NodeKey K, `B.nodeInvalidateFrontier[K]` componentwise dominates `U.nodeInvalidateFrontier[K]`;
4. U's header causal summary is componentwise covered by `resetContext(B)`; and
5. `U.authorityClock <= resetAuthorityHighWater(B)` in the AuthorityTime order.

The distinction in condition 3 is essential. A causal header can prove that an old node invalidation occurred without encoding the NodeKey to which its frontier belongs. Because node-scoped invalidation remains synchronization-relevant summary state across value changes, causal coverage alone is not enough to prove that redelivery of that frontier is a semantic no-op. Reset explicitly retains the node frontiers it observed from R and S; `CoveredState` requires any other U's node frontier to already be dominated by that retained per-node state.

The header conditions are also essential: synchronization-relevant source knowledge can grow without changing any node or authoring a local semantic event. A state is not fully absorbed by the reset merely because its per-node semantic events are old if its header would still advance B's future causal or authority allocation state.

The synchronization theorems below quantify only over U which is a valid ordinary synchronization input for B, including the distinct-writer and own-writer-coordinate preconditions from `incremental-graph-journal-sync.md`. A same-writer U is not redelivered through ordinary `Sync(B <- U)`; same-writer history is handled by controlled reset or same-host restoration under their dedicated rules.

### R1. Projection replacement law

Reset installs exactly the chosen target graph:

```text
project(Reset(R,S)) = resetTarget(R,S)
```

modulo physical storage identities and host-local metadata which the lifecycle explicitly preserves without semantic graph effect.

This includes timestamp meaning: for every present K, `B[K].createdAt == canonical(resetTarget(R,S)[K].createdAt)`, and the selected reset occurrence retains its target `modifiedAt`.

This is the primary user-visible meaning of reset.

### R2. Fresh-baseline identity law

For every K materialized in `resetTarget(R,S)`, B contains a newly authored local reset `ValueId` for K rather than reusing S's source `ValueId` merely because the payload came from S. B also retains that target materialization's canonical `CreationTime` in the present node summary; the creation time is not part of the new `ValueId`.

For every K in `ResetKeys` absent from `resetTarget(R,S)`, B contains a newly authored local reset tombstone and no retained `createdAt`.

Therefore reset is a semantic rebaseline, not a journal-identity copy.

### R3. Observed-history domination law

Every reset-authored head/certificate/invalidation used to establish the new baseline must be causally after the reset-relevant semantic authority which the reset operation actually observed. Reset also retains the componentwise maximum observed `nodeInvalidateFrontier` for every `ResetKey`, because that node-scoped authority remains future-relevant independently of the newly authored reset `ValueId` or tombstone.

Its HLC authority is allocated after joining `resetAuthorityHighWater(B)`, so every reset-authored baseline event compares later than the observed authority it is intended to supersede. Present-node reset certificates therefore cover the retained node invalidation frontier.

Consequently, a pre-reset/source authority already represented by the reset cannot later defeat or newly mutate the reset baseline merely by being redelivered from another replica.

This is the anti-resurrection and absorption guarantee which motivates reauthoring the target state while retaining future-relevant node-scoped invalidation authority instead of simply copying S's old semantic identities.

### R4. Covered-state absorption theorem

For any supported U which satisfies the ordinary synchronization preconditions for B and:

```text
CoveredState(U, B)
```

and contains no genuinely post-reset semantic event, normal synchronization of U into B is a semantic no-op:

```text
observe(Sync(B <- U)) = observe(B)
```

where `observe` includes the legacy graph projection, synchronization-relevant Journal 2 node semantics, and the causal/authority header high-water state which affects future event allocation.

Intuition: every fact U can contribute is already on the causally old side of the reset cut or, for node-scoped invalidation, is already present in B's retained per-node frontier; B rebuilt a head/certificate/tombstone baseline for every represented key in that domain; and U cannot advance B's already-post-reset header high-water state. In particular, redelivering a dominated node frontier is idempotent rather than a new `AdoptEvent`-worthy summary change. Any such U carries only heads on the old side of the reset cut, so it also cannot contribute `CreationTime` to B's newer reset heads under the selected-head creation join.

This theorem is stronger than merely saying that old values do not win: covered old invalidations/certificates cannot re-stale the reset projection, represented node-frontier coordinates cannot newly reappear, covered creation metadata cannot cross the reset-head boundary, and covered header-only knowledge cannot alter future allocation behavior when redelivered.

### R5. Unseen-concurrency non-guarantee

Journal 2 reset does **not** guarantee universal absorption of arbitrary synchronization-compatible state which was not represented by the reset cut.

If such a U later presents a semantic authority E for which:

```text
!coveredByReset(E, B)
```

then E may be concurrent with the reset baseline. Ordinary Journal 2 synchronization/conflict rules apply, including HLC authority resolution for competing concurrent heads/certificates, and it is permitted that:

```text
observe(Sync(B <- U)) != observe(B)
```

Likewise, a synchronization-compatible state whose ordinary semantic facts are causally covered but whose per-node `nodeInvalidateFrontier` is not dominated by B is not `CoveredState(U,B)`: synchronizing it may extend B's node summary even when B's reset certificate already causally covers that invalidation and the legacy graph projection therefore remains unchanged. A state whose node facts are absorbed but whose causal/authority header exceeds the reset cut is also not `CoveredState(U,B)` and may advance B's header.

This is the specified boundary of reset: it dominates the synchronization-relevant history and per-node frontier state it represented, not arbitrary unseen concurrent authority or per-node facts known only indirectly through a causal header.

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

Repeated resets may replace/subsume prior reset-specific raw history. The retained node-scoped invalidation state is still only one componentwise-max `nodeInvalidateFrontier` per represented key, not one record per reset or per old invalidation event. The compacted-state size therefore depends on the currently represented key/author/counter/authority-clock domain, not linearly on the number of resets performed.

This law does **not** imply that absent keys can always be forgotten: tombstoned keys whose negative authority remains synchronization-relevant still contribute to the retained absent-key term T.

### R8. Post-reset convergence theorem

A completed reset produces an ordinary supported Journal 2 state. Therefore, after graph-changing operations (including further resets) stop, the ordinary Journal 2 convergence theorem applies to the participating connected replicas under its stated fairness assumptions.

Reset does not require a separate convergence mechanism after publication.

## Same-host restoration

First-boot recovery of this host's own previously published synchronized database state is not `Reset(R,S)` under R1-R8, even if the lifecycle reuses the same snapshot-staging/cutover machinery.

When the saved state already contains Journal 2, a supported same-host restoration reinstalls it as the continuation of the **same writer history**. It preserves, subject to validation:

```text
writer
journalIncarnation
localJournalCounter
localOperationCounter
causalSummary
authorityClock
node summaries and immutable EventRefs, including retained CreationTime
changed-node markers
derived reverse structural-edge index
receiver-local source cursors
legacy graph/value/timestamp records
```

It does not mint `reason="reset"` ValueIds, does not increment the incarnation merely because the process/installation was recreated, and does not delete valid restored source cursors merely because restoration occurred.

This is safe because the restored cursor/application invariants and writer-local allocation state are part of the exact previously published same-host state being resumed. On the next synchronization, an individual remote source which has reset in the meantime will invalidate its restored cursor by ordinary source-incarnation comparison.

A same-host saved state which predates Journal 2 may also be restored by the database lifecycle as legacy recovery. It is not a Journal 2 semantic reset. After restoration, the normal migration gate must establish valid Journal 2 state before the database participates in Journal 2 synchronization or can be used as a semantic reset source.

### Restoration no-reuse invariant

A supported Journal 2 restoration MUST NOT resume from a stale writer state if a later semantic-event coordinate, operation coordinate, or incarnation from that writer can survive in any supported authoritative/external state while being absent from the restored snapshot. Otherwise the restored writer could assign a surviving `JournalEventId` or `OperationId` to different history, reuse a source incarnation for different reset history, or resume an HLC high-water mark below surviving same-writer authority.

The supported first-boot path therefore uses the host's authoritative previously published synchronized snapshot as its recovery boundary. A newer local-only tail may have committed to the lost local LevelDB after that publication. If that tail was never published to the authoritative branch and never became synchronization input under the publication-before-propagation invariant, catastrophic loss may abandon it. Restoration may then resume the older authoritative counters/HLC state, and a later event or operation may numerically reuse a coordinate which existed only in that abandoned local tail, because no supported surviving state can contain the abandoned use.

Arbitrary rollback is different. If any later same-writer event, operation coordinate, incarnation, or authority may survive outside the restored snapshot, rollback to that older snapshot is outside the supported Journal 2 restoration transition and MUST be rejected where that evidence is available.

If rollback to an older same-writer checkpoint while later same-writer state may survive elsewhere is ever supported, that transition must prevent identity/incarnation reuse and explicitly specify reconciliation with the later surviving state. It must not masquerade as ordinary restoration.

## Why reset stays within the bound

Let:

- `L` be the number of materialized/present keys in the reset baseline;
- `T` be the number of absent/tombstoned keys retained by the reset baseline;
- `N = L + T`.

Reset creates or retains only a constant number of event/summary components per represented key:

- one value or tombstone authority;
- one componentwise-max node-scoped invalidation frontier;
- one certificate for a present value;
- at most one initial value-scoped stale assertion;
- one bounded `CreationTime` for a present summary;
- bounded input ValueId basis;
- ordinary bounded causal metadata and constant-many HLC authority scalars.

The retained node frontier is one `CausalPrefix`, hence `O(R log H)` bits per represented key, exactly the same asymptotic per-summary cost already assumed by Journal 2. The retained `CreationTime` contributes one `O(1)` bounded primitive and does not extend the intent record's `H` parameter.

Receiver-local source cursors are deleted rather than accumulated across resets.

After canonical compaction this is:

```text
O((L + T) R log H) bits
```

and each individual journal LevelDB value is:

```text
O(R log H) bits.
```

No term depends linearly on the number of prior resets or historical reset anchors because prior reset-specific per-node history is subsumed by the current incarnation baseline and the componentwise-max node frontier. The retained absent-key term T may nevertheless reflect historical unique-key churn when anti-resurrection authority for those keys remains required.

## Delayed old replicas

A replica which has not participated since before reset may later present old semantic authorities after an arbitrarily long delay.

If those authorities and per-node frontier coordinates satisfy `CoveredState` and the replica satisfies ordinary synchronization preconditions, R3/R4 apply: redelivery cannot undo or semantically extend the reset state merely by restoring already-represented node-frontier coordinates.

A genuinely unseen remote authority or a previously unrepresented node-frontier coordinate from a synchronization-compatible replica is resolved by ordinary Journal 2 synchronization rules when eventually observed, as stated by R5. Reset does not absorb state outside its represented reset cut.

No correctness argument in this reset design assumes that such a delayed replica eventually returns at all; this follows the liveness-independent intent `$id-4719065396881648`.

## Cursor behavior

For semantic reset, two distinct cursor effects apply:

1. cursors held by other replicas about this receiver become invalid because this receiver's `journalIncarnation` changed;
2. cursors stored by this receiver about other sources are explicitly deleted because reset destroyed their incorporated-state invariant.

The reset process rebuilds one changed-node marker per represented node in the new incarnation. A subsequent incremental relationship with any source is established only after a successful full synchronization under the reset receiver state.

Same-host restoration is different: it restores saved Journal 2 incarnation/cursors unchanged when Journal 2 state exists, subject to the restoration invariants above.

## Repeating reset

Repeating reset to an equivalent source snapshot is a new controlled reset operation and therefore may create a new incarnation and new local baseline authority.

Its user-visible projection is idempotent for an unchanged reset target, but its Journal 2 semantic identity is intentionally not; see R6.