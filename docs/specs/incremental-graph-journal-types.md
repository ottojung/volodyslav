# IncrementalGraph journal types

This document defines the durable replicated journal model. It is normative.

## One immutable journal

A database stores exactly one physical replicated collection:

```text
journal[JournalEntryId] = JournalEntry
JournalEntryId = (sequence, author)
```

`JournalEntryId` is ordered lexicographically by unsigned sequence and then fingerprint. Physical insertion order has no meaning. An imported entry retains its exact ID and immutable contents. Two different contents under one ID are corruption.

```text
JournalEntryBase = {
    author: DatabaseFingerprint
    sequence: uint64
    key: NodeKey
    nodeName: NodeName
    bindings: BindingEnvironment
    time: UnixTimestamp
}

AddJournalEntry = JournalEntryBase & { action: "add" }
DeleteJournalEntry = JournalEntryBase & { action: "delete" }
GenerationScopedJournalEntryBase = JournalEntryBase & {
    generation: JournalEntryId
}
EditJournalEntry = GenerationScopedJournalEntryBase & { action: "edit" }
InvalidateJournalEntry = GenerationScopedJournalEntryBase & {
    action: "invalidate"
    mode: "soft" | "hard"
}
ValidateJournalEntry = GenerationScopedJournalEntryBase & {
    action: "validate"
    clearsHardInvalidates: HardInvalidationContext
}
JournalEntry = AddJournalEntry | DeleteJournalEntry | EditJournalEntry
             | InvalidateJournalEntry | ValidateJournalEntry
HardInvalidationContext = Map<DatabaseFingerprint, JournalEntryId>
```

Every loader, import validator, migration, and merge boundary MUST check `key == NodeKey(nodeName, bindings)` using the production identity-preserving serializer. `NodeKey` need not be reversible. It also checks the closed action shape, valid fingerprints and uint64 values, exact immutable identity, valid timestamps, and that each generation reference resolves to a same-key add. A validation context may reference only an earlier hard invalidate of its exact key and generation, at most one per author. A later validation by the same author/key/generation cannot regress any observed coordinate.

An add establishes a presence generation. Edit, invalidate, and validate are scoped to that exact add; delete is not. Every event has exactly the public action named by its variant. `mode` refines internal invalidation semantics but both modes expose public action `invalidate`.

For add/edit, `time` is the semantic value event time and equals graph `modifiedAt`; an authority-fence add which preserves an equal value preserves the source snapshot's intended value timestamp as its add `time`. Delete/invalidate/validate use their actual event time without changing `modifiedAt`. `ValueRevision=(time,sequence,author)` remains wall-time-first; exact equal-time provenance is selected canonically by ID.

## Coverage and allocator

```text
JournalCoverage = Map<DatabaseFingerprint, uint64>
journalCoverage: JournalCoverage
```

A missing coordinate is zero. `journalCoverage[A]=n` proves that the host has a complete account of A-authored notification obligations through n, although compaction may have removed exact events. It is prefix coverage, not retention. Allocator gaps are closed non-events and are allowed. Coverage is durable and componentwise monotone, and every retained E satisfies `journalCoverage[E.author] >= E.sequence`.

Each writer owns a durable `localJournalClock`. Before local authoring it observes the maximum imported sequence according to the Lamport allocator rule, advances, and publishes once. Aborted reserved values remain gaps. After every atomic commit:

```text
journalCoverage[localFingerprint] == localJournalClock
```

Thus no sequence at or below that coordinate can later become a new local event. Coverage is journal metadata, not graph state. Rollback while retaining the same fingerprint is unsupported.

## Invalidation semantics

A **soft invalidate** records a real freshness transition caused by ordinary dependency propagation while sufficient incoming proofs remain. The cached value and proofs remain cache-revalidatable. It is an exact invalidate notification, but is neither a must-recompute root nor part of causal hard-invalidation state and cannot revoke another host's proofs.

A **hard invalidate** establishes or deliberately reasserts a must-recompute obligation: cached data may remain as `oldValue`, but cache-only reuse cannot make it fresh. Explicit invalidate, proof-removing synchronization or migration, reset hardening, and stale-to-stale hardening author hard invalidates. One causal decision authors one invalidate; hard mode replaces rather than accompanies soft mode. Settled state carrying an outstanding hard barrier is silent.

```text
hardInvalidateFrontier(K,G)[A] =
    greatest outstanding hard invalidate by A for K,G
```

Only hard invalidates participate. `clearsHardInvalidates` contains only hard barriers actually observed by that validation. A soft-only stale-to-fresh cache revalidation may validate with an empty context. A validation is effective only when its context covers every coordinate of the applicable hard frontier. Graph state remains authoritative for current value, freshness, and validity.

## Atomicity and corruption boundary

Graph state, journal, coverage, allocator, generation/provenance metadata, and schema version are installed atomically. A crash exposes the complete before-state or complete after-state. Malformed identity, address, reference, timestamp, or monotonicity data is corruption and is rejected before semantic use. Supported restoration resumes only the exact durable state belonging to its fingerprint.
