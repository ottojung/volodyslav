# PR #1335 Review — Strategy

This document describes a principled strategy for addressing the feedback raised in the PR #1335
review (see `pr1335-review1.md`).

---

## Guiding principles

### Principle 1 — Single authoritative source of truth for computed state

All computed state must live exclusively in `_computed`.  There must be no other long-lived copy of
computed state in the system.  Short-lived local variables used within a single synchronous or
logically-atomic step are acceptable, but they must not persist across `await` boundaries unless
they are provably consistent with `_computed`.

*Consequence for identifier lookup:* the `IdentifierResolver` pattern — which holds a snapshot of
the lookup that can diverge from `_computed` — must be replaced with a design in which all
identifier lookups and allocations go through `_computed.identifierLookup` directly.

### Principle 2 — The mutex determines the consistency boundary

Every mutation of `_computed` AND the corresponding disk write must occur inside a single
acquisition of the relevant mutex.  The mutex is the only synchronisation mechanism; no other
mechanism (snapshot merging, conflict resolution at commit time) should be relied upon for
correctness.

*Consequence:* identifier allocation — which is a mutation of the identifier lookup — must happen
inside the mutex, not before it.

### Principle 3 — Correctness must be locally obvious

A reader should be able to verify correctness by reading the code of a single function and the
invariants stated in comments or specification documents.  Correctness must not depend on
understanding the interleaving of concurrent operations or the age of cached snapshots.

*Consequence:* the design must reduce the reasoning footprint to: "inside the mutex, we read
`_computed`, do X, write `_computed`, and commit to disk.  No other concurrent code can observe an
intermediate state."

### Principle 4 — Laziness is acceptable; divergence is not

`_computed` does not need to be initialised eagerly or maintained in perfect sync with disk at every
instruction boundary.  The system may defer loading state from disk until it is actually needed
("lazy loading").  However, once an operation reads or writes `_computed`, it must observe a state
that is consistent with some past committed disk state, and it must leave `_computed` consistent
with whatever was just committed.

*Consequence:* lazy loading of `_computed.identifierLookup` is fine, but the load must happen
inside the mutex so no two operations can load-and-modify concurrently.

### Principle 5 — Observable behaviour, not internal state at every instant

The required invariant is freedom from *observable divergence*: any value that a caller can read
from the system must correspond to a committed state.  Internal intermediate states (e.g., `_computed`
after loading but before committing new entries) do not need to be identical to the disk state, as
long as they are never *less* complete than the disk state (monotonicity).

---

## Design decisions

### Decision A — Move identifier allocation inside the mutex

All calls that allocate a new identifier (i.e., assign a `NodeIdentifier` to a `NodeKeyString` that
does not yet have one) must happen inside `withComputedStateMutex`, reading from and writing to
`_computed.identifierLookup` directly.

This eliminates the race condition (Problem 2) by making allocation atomic with the lookup update.

### Decision B — Eliminate the `IdentifierResolver` snapshot pattern

The `IdentifierResolver` object currently takes a copy of the lookup at resolver creation time.
This snapshot-based pattern is the root cause of the out-of-`_computed` state problem (Problem 1).

Replace it with a design in which:
- All identifier queries go to `_computed.identifierLookup` (under the mutex).
- Newly allocated identifiers are written to `_computed.identifierLookup` immediately (under the
  mutex), before any dependent node data is written.
- The disk commit of new identifier entries happens in the same batch as the node data.

### Decision C — Define explicit invariants for `_computed`

Write a specification document that states, for `_computed.identifierLookup`:
- Its relationship to the persisted `identifiers_keys_map` (superset invariant).
- Under what conditions it is safe to read it without the mutex (read-only lookups of already
  committed entries).
- What operations may mutate it and under what synchronisation.

This addresses Problem 4.

### Decision D — Lazy-load under the mutex

`_computed.identifierLookup` is loaded from disk on first need.  The load must be performed inside
the mutex so no two concurrent operations can both observe an empty lookup and both try to build it
from disk independently.

After the load, the lookup is cached in `_computed` and subsequent operations use the cached copy.

### Decision E — Use re-entrant logical sections, not recursive mutex acquisition

Recursive dependency pulls during a graph operation must not re-acquire the mutex independently.
Instead, the mutex is acquired once for the entire top-level operation.  Inner pulls that run as
part of that operation share the same mutex acquisition context.

This is implemented by passing a "current batch context" through the call stack rather than using
separate mutex acquisitions for sub-operations.

---

## What the strategy avoids

| Avoided approach | Reason |
|-----------------|--------|
| Keeping the snapshot-and-merge pattern but making it more careful | Does not make correctness obvious; still requires non-local reasoning |
| Using a second mutex specifically for identifier allocation | Adds complexity; introduces risk of lock-ordering bugs |
| Removing the mutex and using copy-on-write | Does not work with LevelDB's synchronous batch semantics |
| Eager synchronisation (always keeping `_computed` identical to disk) | Overly constraining; makes lazy loading impossible and complicates startup |

---

## Relationship to the spec document

The strategy produces one primary output: the specification document at
`docs/specs/incremental-graph-volatile-consistency.md`.  That document translates the principles and
decisions above into precise, testable invariants and protocols that describe the desired state of
the system.

Any subsequent code changes must be driven by that specification.
