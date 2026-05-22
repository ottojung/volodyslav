# Incremental Graph Volatile Consistency

## High-level overview

The IncrementalGraph system maintains its state in two layers:

1. **Persisted layer** — a LevelDB database on disk.  The persisted layer survives process
   restarts.  It stores node values, freshness markers, input dependency records, reverse-dependency
   indices, monotonic counters, creation/modification timestamps, and the *identifier lookup*
   (the bijection between semantic node keys and opaque node identifiers).

2. **Volatile layer** (`_computed`) — in-memory fields of `RootDatabase`.  The volatile layer
   provides fast access to the runtime state that is derived from the persisted layer.  It is
   populated when the database is first opened and is kept up-to-date as operations proceed.

The consistency guarantee the system provides is:

> **Every value that any caller can read from the volatile layer corresponds to a state that has
> been durably committed to the persisted layer.**

In other words, the volatile layer must never expose data that was never persisted.  The converse
— that the volatile layer is always *exactly* equal to the persisted layer — is not required.  The
volatile layer may be a superset of the persisted layer (it may contain entries that have been
committed to disk but not yet reloaded, or entries that were committed in the current session and
are still held in memory), but it must never be a subset (it must not forget entries that have been
committed).

The synchronisation between the two layers need not be eager.  The volatile layer is allowed to
"catch up" lazily — loading state from the persisted layer only when it is first needed — provided
that the invariants below are maintained at all times.

---

## Data model

### `_computed` — the volatile layer

`_computed` is a single object stored as a field of `RootDatabase`.  All computed runtime state
lives exclusively in `_computed`.  No other long-lived location in the system may hold computed
state.  Short-lived local variables (those that do not persist across `await` boundaries and are not
shared between concurrent call chains) are exempt.

`_computed` contains:

| Field | Type | Meaning |
|-------|------|---------|
| `replicaName` | `'x' \| 'y'` | The name of the currently active replica. |
| `namespaceSublevel` | `SchemaSublevelType` | The top-level LevelDB sublevel for the active replica. |
| `globalSublevel` | `GlobalSublevelType` | The global sublevel for the active replica. |
| `schemaStorage` | `SchemaStorage` | Typed accessors for all node-data sublevels. |
| `identifierLookup` | `IdentifierLookup` | The authoritative in-memory bijection `NodeKeyString ↔ NodeIdentifier`. |

The `identifierLookup` field is the primary concern of this document.

### `IdentifierLookup` — the bijection

An `IdentifierLookup` is a strict bijection between two sets:

- **Semantic node keys** (`NodeKeyString`): human-readable keys that encode a node's computation
  (head name + argument list).
- **Node identifiers** (`NodeIdentifier`): opaque 9-character lowercase-ASCII strings used as the
  actual on-disk keys for all node data.

The bijection is represented as two maps that are always inverses of each other:

```
IdentifierLookup = {
    keyToId: Map<NodeKeyString_as_string, NodeIdentifier>,
    idToKey: Map<NodeIdentifier_as_string, NodeKeyString>,
}
```

A lookup is valid if and only if:
- For every entry `(key, id)` in `keyToId`, the entry `(id, key)` exists in `idToKey`.
- For every entry `(id, key)` in `idToKey`, the entry `(key, id)` exists in `keyToId`.
- No key appears more than once; no identifier appears more than once.

### Persisted form of the identifier lookup

The persisted form of the identifier lookup is stored under the key `"identifiers_keys_map"` in the
active replica's global sublevel.  It is a sorted array of `[NodeIdentifier, NodeKeyString]` pairs,
sorted lexicographically by identifier string.

---

## Invariants

The following invariants must hold at all times.  They define the correctness contract for the
synchronisation mechanism.

### Invariant 1 — Superset

At any observable point (any point at which a caller reads from `_computed`),
`_computed.identifierLookup` contains at least every entry that is present in the most recently
committed `identifiers_keys_map` on disk.

Formally: if `(id, key)` is in the committed `identifiers_keys_map`, then `(id, key)` is in
`_computed.identifierLookup`.

The converse is not required: `_computed.identifierLookup` may contain entries that have not yet
been committed to disk, as long as they are committed before any observable read occurs that would
expose them.

### Invariant 2 — Monotonicity

No entry is ever removed from `_computed.identifierLookup`.  Entries may only be added.

Identifiers are permanent: once a `NodeIdentifier` is assigned to a `NodeKeyString`, that mapping
is valid for the lifetime of the replica.

### Invariant 3 — Serialisation

All mutations of `_computed.identifierLookup` happen inside a single acquisition of
`withComputedStateMutex`.  Two mutations cannot run concurrently.

Reading `_computed.identifierLookup` for a key that is known to already be present (i.e., the
caller is certain the entry was committed in a prior operation) does not require the mutex.

### Invariant 4 — Atomic commit

A new identifier mapping becomes visible in `_computed.identifierLookup` only after the
corresponding `identifiers_keys_map` entry has been durably written to disk.  Specifically:

1. Inside `withComputedStateMutex`:
   a. Allocate the new identifier and add it to `_computed.identifierLookup`.
   b. Include the updated `identifiers_keys_map` in the current LevelDB batch.
   c. Flush the batch to disk.
   d. Only after the flush succeeds is the new entry considered committed.
2. If the flush fails, the new entry must be removed from `_computed.identifierLookup` (rollback).

This ensures that `_computed.identifierLookup` never contains entries that failed to reach disk.

### Invariant 5 — Replica scope

All entries in `_computed.identifierLookup` belong to the active replica (`_computed.replicaName`).
After a replica cutover, `_computed.identifierLookup` is replaced entirely with the new replica's
identifier lookup.  No entry from the old replica's lookup persists in `_computed` after the
cutover completes.

---

## Initialisation protocol

The initialisation protocol describes how `_computed` is populated when the database is first
opened, or when the active replica changes (cutover).

### Step-by-step

1. Read the replica pointer from the `_meta/current_replica` key in the root LevelDB level.
   This is the authoritative record of which replica is active.

2. Construct the `namespaceSublevel`, `globalSublevel`, and `schemaStorage` for the replica named
   by the pointer.

3. Mark `_computed.identifierLookup` as **uninitialized** (e.g., as an empty lookup or a sentinel
   value, depending on the implementation).  Do not load from disk yet.

4. Assign `_computed = { replicaName, namespaceSublevel, globalSublevel, schemaStorage,
   identifierLookup: <uninitialized> }`.

5. The first operation that requires the identifier lookup calls
   `ensureActiveIdentifierLookupLoaded()` (see below) inside `withComputedStateMutex`.

### `ensureActiveIdentifierLookupLoaded()`

This function is called inside `withComputedStateMutex`.  It is idempotent.

1. Check whether `_computed.identifierLookup` has been initialized.
2. If already initialized, return immediately.
3. If not initialized:
   a. Read the `identifiers_keys_map` entry from `_computed.globalSublevel`.
   b. If absent, treat it as an empty lookup.
   c. Deserialize and validate the lookup.
   d. Assign the result to `_computed.identifierLookup`.

After this function returns, `_computed.identifierLookup` satisfies Invariant 1 (it is a superset
of the persisted lookup as of the moment the read occurred).

---

## Operation protocol

This section describes the sequence of steps for any graph operation that reads or writes
identifier mappings (e.g., a pull that resolves a previously unseen node).

### Full sequence (with new identifier allocation)

1. The caller constructs a batch context (see "Batch context" below).

2. The caller calls `withComputedStateMutex`:

   a. Call `ensureActiveIdentifierLookupLoaded()`.

   b. For each node key that the operation touches:
      - Look up the key in `_computed.identifierLookup`.
      - If found, use the existing identifier.  No disk write is needed for this key.
      - If not found, allocate a new identifier:
        1. Generate a candidate identifier (random or deterministic).
        2. Verify the candidate is not already in `_computed.identifierLookup`.
        3. If it is (collision), generate another candidate and retry.
        4. Add the mapping `(candidate, key)` to `_computed.identifierLookup`.
        5. Record the new mapping in the current batch's pending-lookup list.

   c. Include the pending-lookup list as an update to `identifiers_keys_map` in the LevelDB batch.

   d. Add all node-data operations (values, freshness, inputs, revdeps, counters, timestamps) to
      the LevelDB batch, keyed by the resolved identifiers.

   e. Flush the batch to disk.

   f. If the flush fails, undo the additions made to `_computed.identifierLookup` in step (b).
      Surface the error to the caller.

3. `withComputedStateMutex` releases.

### Sequence with no new allocation

If the operation only touches nodes whose identifiers are already in `_computed.identifierLookup`
(all keys are known), steps 2b–2c simplify to:

- Look up all keys in `_computed.identifierLookup` (no allocation, no pending-lookup list).
- Build and flush the batch without a `identifiers_keys_map` update.

The mutex is still required so that the read of `_computed.identifierLookup` is consistent with
ongoing allocations by concurrent operations.

### Batch context

A **batch context** groups the node-data operations and any new identifier allocations for one
top-level graph operation into a single LevelDB batch.  It is created at the start of the operation
and discarded after the batch is flushed.

A batch context is a short-lived local object.  It does not persist in `_computed` or any other
field of `RootDatabase`.

### Nested (recursive) dependency pulls

When an operation recursively pulls a dependency node as part of computing the outer node's value,
the inner pull shares the outer operation's batch context and mutex acquisition.  The inner pull
does **not** acquire `withComputedStateMutex` independently.

This is achieved by threading the batch context through the call stack.  Any code that needs to
resolve identifiers or write node data during a pull operation receives the batch context as an
argument.

This design prevents deadlocks (the mutex is not re-entered) and ensures that all identifier
allocations for an entire pull tree — including sub-dependencies — are committed in a single
atomic batch.

---

## Replica cutover protocol

A replica cutover replaces the active replica (and therefore all of `_computed`) with a new one.

### Precondition

The cutover must happen inside `withExclusiveMode`, which ensures that no pull, invalidate, or
observe operation is running concurrently.

### Steps

1. Acquire `withExclusiveMode` (all graph activity suspended).

2. Prepare the new replica's data in the inactive replica storage (named by
   `otherReplicaName()`).

3. Durably write the new replica pointer to `_meta/current_replica`.

4. Construct the new `namespaceSublevel`, `globalSublevel`, and `schemaStorage`.

5. Load the new replica's `identifiers_keys_map` from the new `globalSublevel`.

6. Replace `_computed` atomically (in a single synchronous assignment):
   ```
   _computed = {
       replicaName:       <new replica name>,
       namespaceSublevel: <new namespaceSublevel>,
       globalSublevel:    <new globalSublevel>,
       schemaStorage:     <new schemaStorage>,
       identifierLookup:  <loaded from new globalSublevel>,
   };
   ```

7. Release `withExclusiveMode`.

After step 6, any subsequent operation observes the new `_computed` exclusively.  No entry from the
old replica's `identifierLookup` remains in `_computed`.

---

## Testable properties

The following properties must hold for any conforming implementation.  They are stated in terms that
can be directly verified by a test.

### Property 1 — Committed identifiers are readable after commit

After an operation that allocates a new identifier for node key K and commits successfully,
a subsequent call to look up K in `_computed.identifierLookup` returns the same identifier.

### Property 2 — No conflicting concurrent allocations

If two concurrent operations both attempt to resolve the same previously-unseen node key K, they
must produce the same final identifier for K.  It is not permitted for them to each allocate a
different identifier and then conflict at commit time.

*Verification approach:* start two concurrent pull operations for a fresh key in a test graph.
Assert that after both complete, `_computed.identifierLookup` contains exactly one entry for K,
and both operations saw the same identifier.

### Property 3 — Identifier stability across restarts

If a node key K was assigned identifier I in one process session and that assignment was committed
to disk, then after the database is closed and reopened, a lookup of K returns I.

*Verification approach:* open DB, pull a node (forcing identifier allocation), close DB, reopen DB,
assert the same identifier is returned for the same key.

### Property 4 — Monotonicity (no entries disappear)

The number of entries in `_computed.identifierLookup` is non-decreasing.  An entry that is present
at time T₁ is also present at every later time T₂ > T₁ within the same replica session.

*Verification approach:* snapshot the lookup before and after a sequence of operations; assert the
after-snapshot is a superset of the before-snapshot.

### Property 5 — Superset of disk

At any point, `_computed.identifierLookup` contains at least every entry present in the persisted
`identifiers_keys_map`.

*Verification approach:* read the persisted map directly from LevelDB; assert every entry is also
in `_computed.identifierLookup`.

### Property 6 — Rollback on failed commit

If the LevelDB batch flush fails (simulated by injecting a failure), no new identifier mappings
from that operation are visible in `_computed.identifierLookup` after the failure.

*Verification approach:* inject a flush failure; assert that keys that were being allocated during
the failing operation are not in `_computed.identifierLookup` afterwards.

### Property 7 — Replica cutover replaces the lookup entirely

After a replica cutover, `_computed.identifierLookup` contains exactly the entries from the new
replica's `identifiers_keys_map`, and no entries from the old replica's lookup.

*Verification approach:* populate replica A with identifiers, perform a cutover to replica B
(which has a different set of identifiers), assert that `_computed.identifierLookup` matches
replica B's lookup and contains no replica A entries.

### Property 8 — Nested pull shares allocation context

If an outer pull for node X causes an inner pull for node Y (a dependency), and Y was previously
unseen, then after both pulls complete, the identifier allocated for Y is present in the same
committed batch as the data for X (i.e., they appear in the same atomic write).

*Verification approach:* use a test graph where X depends on Y (both unseen); instrument the
LevelDB batch to capture which keys are written in each batch; assert that Y's identifier entry and
X's node data appear in the same batch.

### Property 9 — Read-only lookups do not conflict with allocations

A concurrent operation that only reads existing identifiers (no new allocations) does not interfere
with an operation that is simultaneously allocating new identifiers.  Both operations complete
successfully and see consistent results.

*Verification approach:* run a reader and an allocator concurrently; assert neither fails and the
reader sees a consistent state.
