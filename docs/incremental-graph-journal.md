# IncrementalGraph journal

The journal is immutable logical history and possible-change infrastructure, not authoritative graph state. Graph values, freshness, timestamps, identifiers, and validity remain graph-owned. Synchronization never invokes computors or invents values.

## Entries and causal freshness

```text
ValidateJournalEntry = GenerationScopedJournalEntryBase & {
    action: "validate"
    clearsInvalidates: InvalidationContext
}
InvalidationContext = Map<HostFingerprint, JournalEntryId>
```

Add/delete are unscoped; edit/invalidate/validate name the exact same-key add generation. `JournalEntryId=(sequence,author)` remains immutable replicated identity. Each context mapping `A -> I` names a real observed invalidate authored by A for the validation's same key and generation. It is not an arbitrary Lamport threshold.

For K,G, `invalidateFrontier(K,G)[A]` is A's greatest retained invalidate in that stream. `covers(V,I)` holds exactly when V and I have equal key and generation and V's context for I.author names I or a later same-author invalidate in that stream. V is effective exactly when it alone covers every frontier element. Contexts from separate validations are never combined. With an empty frontier, an applicable genuine validation is effective but does not itself manufacture graph validity.

A validate is authored only when normal graph execution genuinely commits stale→fresh. In the same atomic graph/journal transaction it captures the complete frontier from the exact transaction-visible snapshot. Telescope/darkroom serialization makes every invalidate committed before the validation linearization point visible in the context; one committed afterward remains uncleared. Synchronization never authors validate.

Freshness for the winning generation requires both one effective validation (when invalidations exist) and ordinary exact graph validity/coherence. Without it, the key is stale and synchronization transports no incoming validity proof that bypasses revalidation.

## Normative traces

* **High-clock old validation:** B's `V=(101,B,G)` does not name A's later unseen `I=(10,A,G)`. After merge V does not cover I, so K is stale; numeric order is irrelevant.
* **Actual observation:** A invalidates; B synchronizes, observes I, genuinely recomputes, and atomically authors V naming I. V covers the frontier, so freshness may return if graph proof is coherent.
* **Split knowledge:** with `I_A` and `I_C`, B's validation naming only I_A and D's naming only I_C leave K stale. No single validation covers both. E may genuinely revalidate after observing both and author one context naming both, permitting freshness subject to coherence.
* **Delayed host:** a validation missing an offline host's invalidate becomes insufficient immediately when that invalidate arrives.
* **Generation change:** contexts and invalidates for G1 have no authority over a later winning add G2.

These rules guarantee no unseen invalidation clearing, no fictional combination of proofs, eventual genuine revalidation after complete observation, delayed-host safety, and strict generation isolation.

## Merge, compaction, and storage

```text
J1 join J2 = compact(entries(J1) union entries(J2))
```

Canonical compaction retains notification coordinate maxima, winning-generation value witnesses, every author's frontier invalidate and greatest validation, every invalidate referenced by a retained validation, and every referenced add. Same-author later validations have componentwise-monotone contexts because durable author knowledge cannot roll back. This makes discarded older contexts dominated and gives `compact(compact(A) union B)=compact(A union B)`, including delayed hosts and future generations. Canonical idempotence and closure yield ACI merge. Details and cursor witness touching are normative in the compaction specification.

The exact guarantee is:

```text
size(compact(J)) = O(nr²)
```

Here n counts represented current/historic keys and r counts authors in compacted entries or causal references. Finite schema arity and fixed maximum serialized `ConstValue` size make keys constant-sized. Per key there are `O(r)` coordinates and validations, each validation may carry `O(r)` context, and exact references add at most `O(r²)` state.

**This is not a continuous physical-storage promise.** Uncompacted immutable history may grow with operation count. Compaction may run at any time, after any transaction, during maintenance or synchronization, repeatedly, or not for arbitrarily many mutations. A crash before it leaves valid history. Correctness never depends on timing.

Receiver-local `localIndex` is movable cursor metadata, not logical identity. Import assigns it only to unknown entries. Compaction removal atomically touches a retained same-key witness so old cursors retain all-action coverage.

## Deliberate API limits

Computor invocation does not receive a journal cursor. The runtime does not expose the journal position corresponding to a computation. A computor therefore cannot rely on a runtime-supplied bootstrap cursor for later incremental `possibleMaybeChanges()` polling. This omission is deliberate. `baselinePossibleNodeChange()` means only “before all locally observable journal history in this cursor domain”; it is not the position where a current computation began and is not an equivalent substitute. No raw index, `journalGet`, context object, hidden graph handle, or bootstrap cursor is provided.

A filtered query that scans through internal watermark H but returns no match produces no reusable cursor. The prior cursor remains the only continuation, so later polling may reconsider irrelevant entries. This is intentional. `possibleMaybeChanges()` guarantees conservative change coverage, not amortized progress through entries excluded by `NodeFilter`. No `scannedThrough` or matching-output complexity guarantee exists. Reconstructible indexes may optimize scanning without changing semantics; optional compaction means cost may depend on uncompacted size.

Detailed specifications: [types](specs/incremental-graph-journal-types.md), [API](specs/incremental-graph-journal-api.md), [emission](specs/incremental-graph-journal-emission.md), [compaction](specs/incremental-graph-journal-compaction.md), [journal synchronization](specs/incremental-graph-journal-sync.md), and [graph synchronization](specs/incremental-graph-synchronization.md).
