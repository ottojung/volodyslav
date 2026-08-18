# IncrementalGraph journal types

This document is normative.

## Supported-state boundary

Proofs quantify over supported reachable graph/journal states produced by the specified atomic authoring, synchronization, migration, reset, restoration, and exact compaction transitions. Immutable identity, canonical address, generation and causal references, allocator/coverage, graph projection, and initial-freshness invariants all hold. Corrupt, forged, rolled-back, or partially installed state is rejected and outside the proof domain. Supported compacted and uncompacted forms are both in-domain.

## One precise journal

```text
journal[JournalEntryId] = JournalEntry
JournalEntryId = (sequence, author)

JournalEntryBase = {
    author: DatabaseFingerprint
    sequence: uint64
    key: NodeKey
    nodeName: NodeName
    bindings: BindingEnvironment
    time: UnixTimestamp
}
GenerationJournalEntry = JournalEntryBase & {
    kind: "generation"
    publicAction: "add" | "edit" | null
    initialFreshness: JournalEntryId
}
DeleteJournalEntry = JournalEntryBase & { action: "delete" }
GenerationScopedJournalEntryBase = JournalEntryBase & { generation: JournalEntryId }
EditJournalEntry = GenerationScopedJournalEntryBase & { action: "edit" }
InvalidateJournalEntry = GenerationScopedJournalEntryBase & {
    action: "invalidate"
    mode: "soft" | "hard"
}
ValidateJournalEntry = GenerationScopedJournalEntryBase & {
    action: "validate"
    clearsInvalidates: InvalidationContext
}
InvalidationContext = Map<DatabaseFingerprint, JournalEntryId>
JournalEntry = GenerationJournalEntry | DeleteJournalEntry | EditJournalEntry
             | InvalidateJournalEntry | ValidateJournalEntry
```

IDs order lexicographically by uint64 sequence then fingerprint. Transport order is irrelevant and import preserves exact identity/content. Every boundary validates the closed discriminated shape, scalar domains, and `key == NodeKey(nodeName,bindings)` using the production identity-preserving serializer; NodeKey need not be reversible.

A generation entry establishes positive presence and is that generation's initial value/provenance event. Its time is the represented semantic `modifiedAt`. Its public action is add only for absent-to-materialized, edit only for a materially present unequal-value replacement, and null for an equal-value internal authority fence. A null action is not a polling obligation. Ordinary later unequal-value changes may use scoped edit. Delete is negative presence. Every scoped entry references an exact same-key generation entry.

Every generation names `initialFreshness`, which resolves to exactly one later-ID scoped freshness event authored atomically with it; no other event may claim that initial role. That event is: validate when fresh, soft invalidate when stale with reusable proofs, or hard invalidate when must-recompute. A supported current positive generation never lacks this witness. Validate means the generation is positively established or re-established fresh after the observed invalidation frontier; it includes initial freshness, not only stale-to-fresh. Invalidate is an exact negative freshness assertion, including initial stale state and later invalidation/hardening.

Validation references are earlier same-key/same-generation invalidates of either mode, one per author. Same-author validation knowledge cannot regress.

## Public action

```text
publicAction(E) =
    E.publicAction                 if E.kind="generation"
    E.action                       otherwise
```

Only non-null results are visible polling obligations. Thus each precise event exposes zero or one public action, never a projection to actions that did not happen.

## Coverage and lazy allocator

`JournalCoverage = Map<DatabaseFingerprint,uint64>`; missing coordinates mean zero. `journalCoverage[A]=n` closes A's authored obligation prefix through n despite gaps and compaction. Coverage is durable, componentwise monotone, and dominates every retained event on that event's own author coordinate.

Each host owns `localJournalClock` for its fingerprint. Importing or observing foreign entries does **not** advance that clock or the local coverage coordinate; a host may retain a foreign sequence above its local clock. Immediately before local authoring, the transaction observes the maximum relevant retained/covered sequence, raises the allocation watermark, and allocates every new local event strictly above it. After committed local authoring:

```text
journalCoverage[localFingerprint] == localJournalClock
```

The local closed prefix never regresses. A receive that authors nothing leaves the local clock/coordinate unchanged. This lazy Lamport rule permits exact reverse-catch-up coverage equality. Rollback under the same fingerprint remains unsupported.

## Causal freshness

```text
invalidateFrontier(J,K,G)[A] = greatest invalidate of either mode by A for K,G
hardInvalidateFrontier(J,K,G)[A] = greatest hard invalidate by A for K,G
```

`covers(V,I)` means V is scoped to I's K,G and its immutable `clearsInvalidates[I.author]` resolves to an invalidate by that author for K,G at sequence at least I.sequence. This is causal coverage (`V >c I`), not JournalEntryId order.

```text
freshnessEffective(V,J,K,G) iff V individually covers every invalidateFrontier member
journalFresh(J,K,G) iff some applicable retained V is freshnessEffective
hardnessCleared(V,J,K,G) iff V individually covers every hardInvalidateFrontier member
journalHard(J,K,G) iff hardInvalidateFrontier is nonempty
                         and no one applicable V is hardnessCleared
```

Partial validation contexts never combine. There is no empty-invalidate-frontier freshness exception: initial validate is the positive witness. An empty hard frontier is non-hard. Uncovered soft-only state is stale/cache-revalidatable; uncovered hard state is must-recompute; clearing hard H followed by soft S is stale-soft.

## Projection theorems

For every supported reachable graph/journal state, the precise journal determines journal-observable current NodeKey presence, generation, value provenance/modifiedAt identity, freshness authority, and hard-vs-soft stale authority. Graph ComputedValue bytes and NodeIdentifier allocation remain graph-owned.

### A. Identifier Incarnation Theorem — NodeIdentifier domain

Each allocated `NodeIdentifier x` identifies one materialization incarnation. While x belongs to the storage-level current materialized identifier set (`graphState.listMaterializedNodes()` returns this `NodeIdentifier[]`), identifier lookup maps x to exactly one NodeKey. After deletion removes x, normal materialization never reuses or reintroduces x. Rematerializing the same NodeKey allocates x2 != x. The public graph API `listMaterializedNodes()` separately returns `[NodeName,BindingEnvironment]` tuples, not identifiers. Controlled reset may retain receiver x while replacing its internal journal generation.

### B. NodeKey Presence Projection Theorem — NodeKey domain

For semantic NodeKey K, K is currently materialized iff `presenceHead(J,K)` is a GenerationJournalEntry; it is absent iff `presenceHead(J,K)` is delete or undefined, subject to graph/journal consistency. History `G1, delete, G2` is valid. Historical add/delete polling representatives do not determine current presence by membership.

### C. Current-Generation Value Provenance Theorem — winning journal-generation domain

For materialized K, `G=generation(J,K)` is the presence head ID. The generation entry G plus scoped edit value heads determine `origin` and wall-time-first `ValueRevision`; actual ComputedValue bytes remain graph state. A reset fence with null public action remains an initial value/provenance event.

### D. Current-Generation Freshness Projection Theorem — precise JournalEntry domain

K is fresh iff some validation scoped to K,G is freshnessEffective and ordinary graph coherence holds. `>c` is immutable context coverage, never numeric ID comparison. A high-ID validation which did not observe a delayed invalidate cannot clear it.

### E. Hard-Staleness Projection Theorem — precise JournalEntry domain

K,G is hard-stale exactly when `journalHard`; otherwise an uncovered all-mode frontier is stale-soft. Empty hard frontier is non-hard.

### F. Polling No-False-Negatives Theorem — visible PossibleNodeChange domain

Polling preserves per-author/non-null-public-action obligations but deliberately hides NodeIdentifier, generation, mode, and causal context. Its visible array cannot reconstruct current presence or freshness; those stronger theorems are over the precise journal.

## Atomicity

Graph, journal, coverage, allocator, identifier/provenance metadata, and schema version install atomically. A crash exposes the complete before-state or after-state.
