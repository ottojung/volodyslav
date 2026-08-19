# IncrementalGraph journal types

This document is normative over supported reachable states produced by the atomic authoring, receive, migration, observed-reset, restoration, and canonical-compaction transitions. Corrupt, forged, rolled-back, partially installed, or clock-unsupported states are outside the proof domain.

## One precise journal

```text
journal[JournalEntryId] = JournalEntry
JournalEntryId = (sequence, author)
JournalEntryBase = { author, sequence:uint64, key, nodeName, bindings, time }
GenerationJournalEntry = JournalEntryBase & {
    kind:"generation", initialFreshness:JournalEntryId
}
DeleteJournalEntry = JournalEntryBase & { kind:"delete" }
GenerationScopedBase = JournalEntryBase & { generation:JournalEntryId }
EditJournalEntry = GenerationScopedBase & { kind:"edit" }
InvalidateJournalEntry = GenerationScopedBase & { kind:"invalidate", mode:"soft"|"hard" }
ValidateJournalEntry = GenerationScopedBase & {
    kind:"validate", clearsThrough:CausalPrefix
}
CausalPrefix = Map<DatabaseFingerprint,uint64>
```

An immutable generation entry establishes positive presence and initial value provenance for an actual absent-to-present materialization, so `publicAction(generation)="add"`. Reset never creates a generation to fence equal present history. Delete is negative presence. Edit is an unequal present-to-present value change scoped to the surviving generation. Every generation names exactly one later-ID, atomically authored initial validate/soft-invalidate/hard-invalidate.

```text
publicAction(E) = "add" for generation; otherwise E.kind
```

Soft/hard both expose invalidate. Each event exposes exactly one public action.

Every boundary validates closed shapes/scalars, immutable-ID agreement, and `key == NodeKey(nodeName,bindings)` using the production identity-preserving serializer. Every scoped event resolves to an exact same-key GenerationJournalEntry. Generation initial-freshness references resolve exactly.

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

Import does not advance the local clock/coordinate. Immediately before local authoring, allocation raises above all relevant retained/covered sequence authority. After commit, local coverage equals local clock and the local prefix never regresses.

## Freshness

```text
invalidateFrontier(J,K,G)[A] = greatest invalidate of either mode by A
hardInvalidateFrontier(J,K,G)[A] = greatest hard invalidate by A
covers(V,I) iff V.key=I.key and V.generation=I.generation
                 and I.sequence <= V.clearsThrough[I.author]
freshnessEffective(V,J,K,G) iff V alone covers every invalidateFrontier member
journalFresh iff some applicable V is freshnessEffective
journalHard iff hard frontier is nonempty and no applicable V alone covers it
```

**Validation Causality Theorem.** A validation clears only applicable invalidates within legitimately evidenced `clearsThrough` coordinates. Separate partial validations never combine. Empty hard frontier is non-hard. Initial validate is required positive freshness evidence, so freshness has no implicit empty-frontier exception. A delayed event under `clearsThrough` is already cleared; a later event above it is not.

## Projection theorems

**Identifier Incarnation Theorem (NodeIdentifier domain).** A storage-level materialized NodeIdentifier maps to exactly one NodeKey. Removal retires it permanently; rematerializing the same NodeKey allocates a different identifier. Public `listMaterializedNodes()` exposes semantic address tuples, not these identifiers. Reset retains receiver identifiers for surviving materializations.

**NodeKey Presence Projection Theorem (NodeKey domain).** K is materialized iff `presenceHead(J,K)` is GenerationJournalEntry; it is absent iff the head is delete or undefined. History generation/delete/generation is valid. Polling history membership is not current presence.

**Current Value Provenance Theorem (winning-generation domain).** The winning generation entry plus scoped value heads determine origin/modifiedAt identity; ComputedValue bytes remain graph state.

**Freshness and Hardness Projection Theorems (precise-entry domain).** Current generation freshness uses one causal-prefix validation plus graph coherence, never numeric validate/invalidate ordering. Hard/soft authority follows the formulas above.

**Polling Projection Theorem (PossibleNodeChange domain).** Polling hides identifiers, generations, modes, and causal contexts; it preserves action obligations but cannot reconstruct current graph state.

Graph, journal, vectors, local clock, identifier/proof state, and timestamps install atomically.
