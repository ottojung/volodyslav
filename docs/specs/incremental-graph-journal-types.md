# IncrementalGraph journal types

This document is normative over supported reachable states produced by the atomic authoring, receive, migration, observed-reset, restoration, and canonical-compaction transitions. Corrupt, forged, rolled-back, partially installed, or clock-unsupported states are outside the proof domain.

Within one supported merged journal state, one `DatabaseFingerprint` denotes
exactly one durable writer history. Synchronization uses existing host/branch
lifecycle identity to reject distinct writer histories with the same
fingerprint before journal union, so they never enter that supported state.
Snapshots continuing or restoring the same durable writer history may retain
the same fingerprint. Fresh fingerprint creation provides only probabilistic
distinctness, not a mathematical or creation-time uniqueness guarantee.

## One precise journal

```text
journal[JournalEntryId] = JournalEntry
JournalEntryId = (sequence, author)
JournalEntryBase = { author, sequence:uint64, key, nodeName, bindings, time }
GenerationJournalEntry = JournalEntryBase & {
    kind:"generation", initialFreshness:JournalEntryId
}
DeleteJournalEntry = JournalEntryBase & { kind:"delete", resetLineage?:ResetLineage }
ResetObservationEntry = JournalEntryBase & {
    kind:"reset-observation", absentAnchor:JournalEntryId | null,
    resetLineage:ResetLineage
}
GenerationScopedBase = JournalEntryBase & { generation:JournalEntryId }
EditJournalEntry = GenerationScopedBase & { kind:"edit" }
InvalidateJournalEntry = GenerationScopedBase & {
    kind:"invalidate", mode:"soft"|"hard",
    appliesTo:"generation" | { valueOrigin:JournalEntryId },
    resetLineage?:ResetLineage
}
ValidateJournalEntry = GenerationScopedBase & {
    kind:"validate", clearsThrough:CausalPrefix,
    valueOrigin:JournalEntryId,
    resetLineage?:ResetLineage
}
ResetLineage = {
    consumedThrough:CausalPrefix,
    correspondence:ResetCorrespondence | null
}
ResetCorrespondence = {
    consumedGeneration:JournalEntryId,
    consumedValueOrigin:JournalEntryId
}
CausalPrefix = Map<DatabaseFingerprint,uint64>
```

For two reset-lineage carriers `L1,L2` with the same durable author, NodeKey, and tagged receiver anchor, `L1.sequence<L2.sequence` implies `L1.consumedThrough <=componentwise L2.consumedThrough`. This is a supported-state structural invariant and the proof-carrying basis for bounded same-anchor succession: the later immutable same-writer assertion replaces the earlier assertion without placing `L1.id` in `L2.consumedThrough`. Different authors or different anchors receive no such implied observation order.

An immutable generation entry establishes positive presence and initial value provenance for an actual absent-to-present materialization, so `publicAction(generation)="add"`. Reset never creates a generation to fence equal present history. Delete is negative presence. Edit is an unequal present-to-present value change scoped to the surviving generation. Every generation names exactly one later-ID, atomically authored initial validate/soft-invalidate/hard-invalidate.

For generation `G` and its named initial event `I`, structural validity requires `I.author=G.author`, `I.sequence>G.sequence`, `I.key=G.key`, `I.generation=G.id`, and `I.kind` in `{validate,invalidate}`. The two entries install atomically. Sequence adjacency is not required, but a generation cannot name another author's future event.

```text
publicAction(E) = "add" for generation; undefined for reset-observation; otherwise E.kind
```

Soft/hard both expose invalidate. Every public graph event exposes exactly one action. ResetObservationEntry is internal metadata in the same physical journal, has no public action, and is ignored by polling maxima.

Every boundary validates closed shapes/scalars, immutable-ID agreement, and `key == NodeKey(nodeName,bindings)` using the production identity-preserving serializer. Every scoped event resolves to an exact same-key GenerationJournalEntry. Generation initial-freshness references resolve exactly.

**Post-edit Negative-Freshness Invariant.** Any transaction that authors a same-generation edit for a new semantic value and leaves that value stale MUST author a new negative freshness assertion after the edit: soft when complete cache-revalidation proof remains, hard when recomputation is required. Pre-edit invalidates cannot represent the new value's negative authority. Equal-value operations author no edit and may reuse existing authority under the ordinary causal rules.

Generation-wide invalidates represent explicit/concurrent causal invalidation that applies regardless of which value origin wins. Initial-stale, post-edit, reset/migration cache-status, proof-loss, and propagated-input-staleness assertions are value-specific and name the exact value origin whose cache state they describe. For selected origin O, an invalidate is applicable iff it is generation-wide or names O. Both causal frontiers and validation effectiveness are computed only from applicable invalidates; a losing value's cache-status barrier cannot stale a different selected value.

Every validation names the exact value origin it validates. The initial validation names its GenerationJournalEntry; validation after an edit names that edit. Positive evidence for one origin never freshens another origin, even when its causal prefix includes the other origin’s invalidates.

Observed reset attaches `resetLineage` to a receiver-retained freshness assertion for a present target or to the real reset-authored DeleteJournalEntry for a present-to-absent target. When both snapshots are already absent and either side has represented key history, it authors an internal ResetObservationEntry anchored to the receiver delete (or explicit null absence when no receiver presence event exists). A null anchor is a durable virtual absence, not a condition that the future union's raw presence head remain null: events at or below its vector remain absorbed after union, and ordinary generation/delete ordering applies only among events above that vector. With no post-cutoff presence event, causal presence remains absent. This metadata-only entry has no public action and cannot masquerade as add/edit/delete/validate/invalidate.

Reset causal observation and semantic correspondence are distinct. `consumedThrough` is the joinable per-author prefix inspected across both snapshots; missing means zero. Concurrent observations for one receiver anchor join by componentwise maximum, without inferring causality from carrier JournalEntryId. `correspondence`, when present, names exactly one source generation/origin actually compared `isEqual` with the receiver value anchor. Concurrent/later exact correspondences form a bounded retained set; causal coordinates alone never certify semantic equality.

For every author A, an A-authored key event at or below joined `consumedThrough[A]` is absorbed. A same-lineage event above it remains eligible regardless of carrier. Structural validation requires canonical vectors and exact shapes. Delete/reset-observation absent lineage has null correspondence; validate/invalidate present lineage has a non-null exact correspondence. Both correspondence IDs contain nonzero uint64 sequences and supported fingerprints. Booleans, duplicate/unsorted coordinates, mismatched kind/correspondence, malformed IDs, and unknown fields are rejected.

## UnixTimestamp and event time

`UnixTimestamp` persists as a signed integer millisecond count since `1970-01-01T00:00:00Z`. Its supported domain is exactly the integer interval `[-8640000000000000,8640000000000000]`, excluding booleans. `toUnixTimestamp(DateTime)=DateTime.toMillis()` and `fromUnixTimestamp(t)` constructs the exact UTC instant; both require exact integer round-trip. Out-of-domain, fractional, approximate, clamped, rounded, or malformed persisted/token values are rejected.

* generation time is its semantic value `modifiedAt`;
* edit time is the edited value `modifiedAt`;
* delete time is deletion occurrence and does not change value `modifiedAt`;
* invalidate time is assertion occurrence and does not change value `modifiedAt`;
* validate time is assertion occurrence and does not change value `modifiedAt`.

Reset-created/changed value generation/edit time is reset transaction time τ. Reset freshness assertions use their actual occurrence τ. Equal surviving reset values preserve receiver `modifiedAt`. Supported cross-host value ordering assumes clocks do not invert real value-event order; a source `modifiedAt>τ` for an already-observed value is outside that clock premise. The protocol does not repair unsynchronized clocks.

## Coverage, causal prefixes, and lazy allocation

`JournalCoverage[A]=n` proves the host has a complete account of A's authored prefix through n, despite gaps/compaction. `Validate.clearsThrough[A]=n` instead proves that this validation was justified by trusted evidence of a closed A prefix through n; it clears only applicable same-key/same-generation invalidates in that prefix. Reset may use validated source coverage it explicitly inspected to justify `clearsThrough`, without merging that coverage into receiver `journalCoverage`.

A locally authored coordinate may claim only a prefix for which the transaction had valid closed-prefix evidence: ordinarily local journal/coverage, and for controlled reset additionally its validated source snapshot. Compaction preserves the vector claim even if it removes exact covered evidence.

Validation knowledge is durable and monotone. For validations V1,V2 with the same author, key, and generation (regardless of value origin):

```text
V1.sequence < V2.sequence => V1.clearsThrough <=componentwise V2.clearsThrough
```

Every validation authoring path—ordinary pull/revalidation, migration, a genuinely synchronization-authored initial validation, and observed reset—starts with the greatest prior same-author/key/generation validation vector and componentwise-maxes newly justified closed prefixes into it. The prior vector is itself durable evidence for carry-forward; source coordinates learned only by reset remain in later validation state without being copied into host journalCoverage. A retained pair violating monotonicity is unsupported/corrupt. Structural load validation checks canonical map shape, at most one coordinate per fingerprint, and uint64 coordinates; lifecycle legitimacy of the claimed evidence is a separate authoring proof.

Import does not advance the local clock/coordinate. Immediately before local authoring, allocation raises above all relevant retained/covered sequence authority. After commit, local coverage equals local clock and the local prefix never regresses.

## Freshness

```text
applicable(I,O) iff I.appliesTo="generation" or I.appliesTo.valueOrigin=O
invalidateFrontier(J,K,G,O)[A] = greatest applicable invalidate of either mode by A
hardInvalidateFrontier(J,K,G,O)[A] = greatest applicable hard invalidate by A
covers(V,I) iff V.key=I.key and V.generation=I.generation
                 and I.sequence <= V.clearsThrough[I.author]
freshnessEffective(V,J,K,G,O) iff V.valueOrigin=O and V alone covers every applicable invalidateFrontier member
journalFresh iff some applicable V is freshnessEffective
journalHard iff hard frontier is nonempty and no applicable V alone covers it
```

**Validation Causality Theorem.** A validation clears only applicable invalidates within legitimately evidenced `clearsThrough` coordinates. Separate partial validations never combine. Empty hard frontier is non-hard. Initial validate is required positive freshness evidence, so freshness has no implicit empty-frontier exception. A delayed event under `clearsThrough` is already cleared; a later event above it is not.

A derived stale-soft materialization retains the complete reusable incoming proof needed for cache-only revalidation. Stale-soft without that proof is unsupported: proof loss establishes must-recompute and requires a hard invalidate unless an applicable uncovered hard barrier already represents it. A zero-input stale materialization has no incoming proof to reuse and is hard-stale rather than soft-stale.

## Projection theorems

**Identifier Incarnation Theorem (NodeIdentifier domain).** A storage-level materialized NodeIdentifier maps to exactly one NodeKey. Removal retires it permanently; rematerializing the same NodeKey allocates a different identifier. Public `listMaterializedNodes()` exposes semantic address tuples, not these identifiers. Reset retains receiver identifiers for surviving materializations.

**NodeKey Presence Projection Theorem (NodeKey domain).** K is materialized iff causal `presenceHead(J,K)` is GenerationJournalEntry; it is absent iff the head is delete or undefined. Each reset anchor is evaluated against its own joined causal vector before raw presence ordering, so a higher-ID event inside that vector cannot disable its absorber. A null explicit-absence anchor may suppress consumed presence without another post-cutoff event; a non-null anchor remains fallback until another actual generation/delete is outside that anchor's cut. Actual post-cutoff generation/delete events and generations activated by above-cut scoped events remain eligible; only actual generation/delete IDs order the result. History generation/delete/generation is valid. Polling history membership is not current presence.

**Current Value Provenance Theorem (winning-generation domain).** The winning generation entry plus scoped value heads determine origin/modifiedAt identity; ComputedValue bytes remain graph state.

**Freshness and Hardness Projection Theorems (precise-entry domain).** Current generation freshness uses one causal-prefix validation plus graph coherence, never numeric validate/invalidate ordering. Hard/soft authority follows the formulas above.

**Polling Projection Theorem (PossibleNodeChange domain).** Polling hides identifiers, generations, modes, and causal contexts; it preserves action obligations but cannot reconstruct current graph state.

Graph, journal, vectors, local clock, identifier/proof state, and timestamps install atomically.
