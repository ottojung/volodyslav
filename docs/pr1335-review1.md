# PR #1335 Review — Problem description

This document analyses the synchronisation problems identified in the review feedback for PR #1335.
The feedback states that the codebase "deals with syncing in a very complicated and seemingly
unreliable way." This document describes each problem precisely.

---

## Background: what must be synchronised

The IncrementalGraph system maintains two state layers:

- **Persisted layer** — LevelDB on disk.  The ground truth for node values, freshness, inputs,
  revdeps, counters, timestamps, and the `identifiers_keys_map` bijection.
- **Volatile layer** (`_computed`) — in-memory fields of `RootDatabaseClass`.  Specifically,
  `_computed.identifierLookup` is the authoritative live bijection between semantic node keys and
  opaque node identifiers.

For correctness, the volatile layer must at all times be **exactly isomorphic** to the persisted
layer: it must not be missing any entry that is on disk, and it must not contain any entry that is
not yet on disk.  Both directions of this isomorphism are required.

The second direction is the one that is difficult and currently violated: the volatile layer must
not expose data that has not yet been committed to disk.

---

## Problem 1: Computed state leaks out of `_computed`

The feedback requires: *"All computed data must be stored exclusively in the `_computed` field of
`RootDatabase`. No computed data may live outside of that field, except for local, short-lived,
variables."*

In the current design the `IdentifierResolver` acts as a second copy of computed state that lives
outside `_computed`:

- Each resolver takes a **snapshot** of `_computed.identifierLookup` at the time the resolver is
  first accessed.
- The resolver accumulates new identifier allocations in its own `pendingIdentifierMappings` map,
  which is not part of `_computed`.
- This snapshot and its accumulated allocations are long-lived (they persist for the entire duration
  of a pull operation, which can span many asynchronous turns and recursive sub-pulls).

From the moment the resolver's snapshot diverges from `_computed.identifierLookup` (because another
concurrent operation committed new entries), the resolver holds computed state that is inconsistent
with the authoritative source.

---

## Problem 2: Race condition in identifier allocation

The `fn(batch)` callback in `withIdentifierBatch` runs **outside** the `withComputedStateMutex`.
During `fn(batch)`, the `IdentifierResolver` may allocate new identifiers.  Because the resolver
operates on a stale snapshot, two concurrent operations can simultaneously allocate **different**
identifiers for the **same** key:

```
Time  Thread A                              Thread B
────  ─────────────────────────────────────────────────────
 1    resolver_A = makeIdentifierResolver() (loads lookup; key X absent)
 2                                          resolver_B = makeIdentifierResolver() (loads lookup; key X absent)
 3    fn_A(batch): resolves X → id_A (new allocation, id_A ∉ lookup)
 4                                          fn_B(batch): resolves X → id_B (new allocation, id_B ∉ lookup)
 5    [acquires withComputedStateMutex]
 6    reads activeLookup; applies id_A for X; commits; sets _computed.lookup with X → id_A
 7    [releases mutex]
 8                                          [acquires withComputedStateMutex]
 9                                          reads activeLookup (now has X → id_A)
10                                          tries applyPendingTo: setIdentifierMapping(id_B, X)
11                                          → IdentifierLookupError: "key X already assigned to id_A"
12                                          [mutex released; operation fails]
```

At step 11, Thread B's commit fails with an `IdentifierLookupError`.  The node operations in
Thread B's batch (values, freshness, inputs, etc.) were built using `id_B` as the identifier, but
`id_B` was never committed to the identifier lookup, so the stored node data is orphaned and
unreachable via the lookup.

This is a real correctness bug that can manifest under any concurrent workload that triggers new
identifier allocations for the same key simultaneously (for example, two concurrent pulls of the
same previously unseen node).

---

## Problem 3: Correctness is not obvious to readers

To understand whether the current design is correct, a reader must simultaneously reason about:

1. **When does a resolver load its snapshot?**  Lazily, on first key access during `fn(batch)`.
   This means the snapshot age is variable and depends on when in the operation the first key is
   resolved.

2. **What does `applyPendingTo` guarantee?**  It merges the resolver's local allocations onto the
   active lookup at commit time.  But it does so by calling `setIdentifierMapping`, which throws on
   conflict — so the guarantee it provides (no conflict) depends on the assumption that no other
   concurrent resolver allocated identifiers for the same keys.  This assumption is not enforced and
   can be violated (Problem 2).

3. **What does the mutex protect?**  `withComputedStateMutex` serialises only the
   *commit phase* (steps 5–7 in the timeline above).  The *allocation phase* (step 3–4) runs
   concurrently.  The mutual exclusion is therefore insufficient to prevent conflicting allocations.

4. **How does `_computed.identifierLookup` relate to the resolver's snapshot?**  They can diverge.
   The resolver's snapshot can be older than `_computed`, and the resolver's pending allocations are
   not reflected in `_computed` until commit time.

None of these relationships are documented in the code, and the code cannot be verified correct
without this analysis.

---

## Problem 4: The `_computed` / disk consistency boundary is implicit and violated

After a successful commit inside `withComputedStateMutex`, `_computed.identifierLookup` is updated.
However, the current implementation adds new identifier entries to `_computed.identifierLookup`
**before** flushing to disk (step 4 in the old `withIdentifierBatch`: `applyPendingTo` is called on
the active lookup, then the batch is flushed).  This violates the isomorphism requirement: there is
a window during which `_computed` contains entries that are not yet on disk.

Furthermore there is no documented invariant specifying:
- At what point is `_computed.identifierLookup` guaranteed to be exactly isomorphic to disk?
- Is it valid for `_computed` to be ahead of disk?  (It is not.)
- Under what conditions is it safe to read from `_computed` without taking the mutex?

Without these invariants documented, it is impossible for a reader to be confident the system is
correct, and the ordering bug described above goes unnoticed.

---

## Summary

| # | Problem | Consequence |
|---|---------|-------------|
| 1 | Computed state (resolver snapshots, pending allocations) lives outside `_computed` | Harder to reason about consistency; violates design requirement |
| 2 | Identifier allocation happens outside the mutex; concurrent resolvers can conflict | `IdentifierLookupError` at commit time; orphaned node data |
| 3 | Correctness argument requires multi-level non-obvious reasoning | Bugs are hard to detect; maintenance is risky |
| 4 | `_computed` is updated before the disk flush; no invariant documents the required isomorphism | `_computed` can be ahead of disk; correctness is impossible to verify from the code |
