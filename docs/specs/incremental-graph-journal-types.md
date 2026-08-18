# IncrementalGraph journal types

This document defines the durable replicated journal model. It is normative.

## Supported-state boundary

The algebra and proofs quantify over **supported reachable histories**: histories produced by the authoring, synchronization, migration, reset, restoration, and compaction rules in these specifications. Every entry has a valid immutable identity and shape; address, generation, and causal references resolve exactly; same-author clocks and validation knowledge are monotone; graph state agrees with journal-derived presence, value provenance, and freshness; and lifecycle atomicity holds. Corrupt, forged, rolled-back, or partially installed state is rejected and is outside the proof domain. Compacted and uncompacted forms of a supported history are both supported.

## One immutable journal

A database stores exactly one physical replicated collection:

```text
journal[JournalEntryId] = JournalEntry
JournalEntryId = (sequence, author)
```

IDs are ordered lexicographically by unsigned sequence then fingerprint. Physical insertion order has no meaning. Import preserves exact ID and contents; different contents under one ID are corruption.

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
JournalEntry = AddJournalEntry | DeleteJournalEntry | EditJournalEntry
             | InvalidateJournalEntry | ValidateJournalEntry
```

Every load, import, migration, and merge validates `key == NodeKey(nodeName, bindings)` with the production identity-preserving serializer. `NodeKey` need not be reversible. It validates the closed variant shape, fingerprint, uint64, timestamp, immutable identity, and all references. Each generation-scoped entry names a same-key add. Each validation reference names an earlier same-key, same-generation invalidate of the stated author, of either mode, with at most one coordinate per author. Later validation contexts by one author/key/generation cannot regress an observed coordinate.

Every event exposes exactly its variant action. Soft and hard modes both expose `invalidate`; mode is internal causal meaning. Add creates a generation. Edit, invalidate, and validate are scoped to it; delete is not.

For ordinary add/edit, `time` equals the semantic value event's graph `modifiedAt`. An equal-value reset authority-fence add preserves the intended source snapshot value timestamp. Delete/invalidate/validate use occurrence time without changing `modifiedAt`. `ValueRevision=(time,sequence,author)` remains wall-time-first and exact equal-time provenance is canonical by ID.

## Coverage and allocator

```text
JournalCoverage = Map<DatabaseFingerprint, uint64>
journalCoverage: JournalCoverage
```

Missing means zero. `journalCoverage[A]=n` proves complete account of A-authored polling obligations through n although exact events may be compacted. It is prefix coverage, not retention. Gaps are closed non-events. Coverage is durable, componentwise monotone, and dominates every retained event. Each writer has durable `localJournalClock`; observed sequences raise it before local authoring, and committed skips remain gaps. After each atomic commit:

```text
journalCoverage[localFingerprint] == localJournalClock
```

Rollback under the same fingerprint is unsupported.

## Two invalidation frontiers

A soft invalidate is a real stale transition while reusable incoming proofs remain. It blocks an older validation from making the node fresh, but creates no must-recompute authority and does not itself revoke proofs.

A hard invalidate establishes or deliberately reasserts must-recompute state. Cached bytes may remain as `oldValue`, but cache-only reuse cannot make them fresh. Explicit invalidation, unrepresented proof-removal/hardening decisions, migration hardening, and reset hardening author hard mode. One decision emits one invalidate. Settled state already represented by an applicable uncovered hard barrier is silent.

```text
invalidateFrontier(K,G)[A] =
    greatest invalidate of either mode by A for K,G

hardInvalidateFrontier(K,G)[A] =
    greatest hard invalidate by A for K,G
```

For validation V, `covers(V,I)` holds when V is for I's key/generation and `V.clearsInvalidates[I.author]` names an invalidate by that author for the same key/generation whose sequence is at least I's sequence. Then:

```text
freshnessEffective(V,K,G)
    iff V individually covers every member of invalidateFrontier(K,G)

hardnessCleared(V,K,G)
    iff V individually covers every member of hardInvalidateFrontier(K,G)
```

Contexts from multiple validations never combine. An uncovered soft-only frontier yields stale but cache-revalidatable state. An uncovered hard member yields stale must-recompute state. A validation covering hard barriers but missing a later soft invalidate yields stale-soft. Complete all-frontier coverage may permit freshness, subject to ordinary graph coherence. An empty hard frontier is vacuously non-hard; avoiding hard state does not require any validation.

## Atomicity

Graph, journal, coverage, allocator, provenance/generation metadata, and schema version install atomically. A crash exposes the complete before-state or after-state. Structural failure is corruption and is rejected before semantic use.
