# Incremental Graph Volatile Consistency

## High-level overview

The IncrementalGraph system maintains its state in two layers:

1. **Persisted layer** — a LevelDB database on disk.  The persisted layer survives process
   restarts.  It stores node values, freshness markers, input dependency records, reverse-dependency
   indices, monotonic counters, creation/modification timestamps, and the *identifier lookup*
   (the bijection between semantic node keys and opaque node identifiers).

2. **Volatile layer** (`_computed`) — in-memory fields of `RootDatabase`.  The volatile layer
   provides fast, in-process access to the runtime state that mirrors the persisted layer.  It is
   populated lazily from the persisted layer and kept in exact correspondence with it as operations
   proceed.

The consistency guarantee the system provides is:

> **At every observable point, the volatile layer is exactly isomorphic to the persisted layer.**

"Observable point" means any moment when code outside `withComputedStateMutex` can read from
`_computed`.  Inside a mutex-held section, `_computed` may temporarily hold intermediate local
working state, but by the time the mutex is released, `_computed` must again exactly reflect
whatever is on disk.

"Exactly isomorphic" means neither more nor less: the volatile layer must not expose data that is
not yet on disk, and it must not omit data that is on disk.

The synchronisation between the two layers need not be eager in one specific sense: the volatile
layer is allowed to start in an uninitialised state and load its contents from disk lazily — on
first need — rather than at construction time.  This lazy loading must happen inside the mutex so
the loaded state is exactly the persisted state at the moment of loading.  After the first load, the
invariant of exact isomorphism must be maintained for the rest of the session.

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

### Invariant 1 — Exact isomorphism

At every observable point, `_computed.identifierLookup` contains **exactly** the same entries as
the most recently committed `identifiers_keys_map` on disk.

Formally:
- If `(id, key)` is in the committed `identifiers_keys_map`, then `(id, key)` is in
  `_computed.identifierLookup`.
- If `(id, key)` is in `_computed.identifierLookup`, then `(id, key)` is in the committed
  `identifiers_keys_map`.

Both directions are required.  The volatile layer must neither lag behind disk (missing committed
entries) nor run ahead of disk (holding entries that have not yet been committed).

### Invariant 2 — Monotonicity of the persisted layer

The persisted `identifiers_keys_map` only ever grows: entries are never deleted.  Because the
volatile layer is exactly isomorphic to the persisted layer (Invariant 1), the visible content of
`_computed.identifierLookup` also only ever grows between observable points within a single replica
session.

This is a consequence of Invariant 1 combined with the append-only nature of the persisted layer;
it is not an independent invariant of the volatile layer itself.

### Invariant 3 — Serialisation

All mutations of `_computed.identifierLookup` happen inside a single acquisition of
`withComputedStateMutex`.  Two mutations cannot run concurrently.

Reading `_computed.identifierLookup` outside the mutex is safe only for entries that are known to
already be committed on disk (i.e., have been written in a prior, fully completed mutex section).
Any code that might read an entry that could have been newly allocated since the last full mutex
section must re-acquire the mutex.

### Invariant 4 — Disk-first commit ordering

The persisted layer is always updated **before** `_computed` is updated.  Specifically, for any
operation that allocates a new identifier:

1. Inside `withComputedStateMutex`:
   a. Compute the new identifier mapping into a **temporary local variable** (not yet in `_computed`).
   b. Include the updated `identifiers_keys_map` in the current LevelDB batch.
   c. Flush the batch to disk.
   d. **Only after the flush succeeds**: update `_computed.identifierLookup` to add the new mapping.
   e. If the flush fails: do **not** update `_computed.identifierLookup`.  Discard the temporary
      allocation.  Surface the error to the caller.

This ordering ensures that after the mutex is released, `_computed.identifierLookup` is always
exactly isomorphic to the disk state (Invariant 1).

### Invariant 5 — Replica scope

All entries in `_computed.identifierLookup` belong to the active replica (`_computed.replicaName`).
After a replica cutover, `_computed.identifierLookup` is replaced entirely with the new replica's
identifier lookup loaded from disk.  No entry from the old replica's lookup persists in `_computed`
after the cutover completes.

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

After this function returns, `_computed.identifierLookup` satisfies Invariant 1 (it is exactly
isomorphic to the persisted `identifiers_keys_map` as of the moment the read occurred).

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
      - If not found, allocate a new identifier **into a temporary local variable** (do not write to
        `_computed.identifierLookup` yet):
        1. Generate a candidate identifier (random or deterministic).
        2. Verify the candidate is not already in `_computed.identifierLookup`.
        3. If it is (collision), generate another candidate and retry.
        4. Record the `(candidate, key)` mapping in a local pending list for this operation.

   c. Include the pending list as an update to `identifiers_keys_map` in the LevelDB batch.

   d. Add all node-data operations (values, freshness, inputs, revdeps, counters, timestamps) to
      the LevelDB batch, keyed by the resolved identifiers.

   e. Flush the batch to disk.

   f. **Only after a successful flush**: add every entry from the pending list to
      `_computed.identifierLookup`.

   g. If the flush fails: do **not** modify `_computed.identifierLookup`.  Discard the pending
      list.  Surface the error to the caller.

3. `withComputedStateMutex` releases.

At step 3 release time, `_computed.identifierLookup` is exactly isomorphic to the disk state,
satisfying Invariant 1.

### Sequence with no new allocation

If the operation only touches nodes whose identifiers are already in `_computed.identifierLookup`
(all keys are known), steps 2b–2c simplify to:

- Look up all keys in `_computed.identifierLookup` (no allocation, no pending list).
- Build and flush the batch without an `identifiers_keys_map` update.

The mutex is still required while reading `_computed.identifierLookup` so that reads are consistent
with any concurrent mutations (which are also performed under the mutex).

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

### Property 4 — Monotonicity (no entries disappear between observable points)

An entry that is present in `_computed.identifierLookup` at one observable point is also present at
every later observable point within the same replica session.

This follows from the append-only nature of the persisted `identifiers_keys_map` combined with
Invariant 1.

*Verification approach:* snapshot the lookup before and after a sequence of operations; assert the
after-snapshot contains every entry from the before-snapshot.

### Property 5 — Exact equality with disk at every observable point

At every observable point, `_computed.identifierLookup` contains **exactly** the same entries as
the persisted `identifiers_keys_map` — no more and no fewer.

*Verification approach:* after any operation completes (mutex released), read the persisted map
directly from LevelDB.  Assert that the two sets of entries are equal in both directions (disk ⊆
volatile AND volatile ⊆ disk).

### Property 6 — No volatile entry before disk commit

An entry is never present in `_computed.identifierLookup` unless it has already been committed to
the persisted `identifiers_keys_map`.  There is no "optimistic" or "ahead-of-disk" volatile state.

*Verification approach:* during a flush (using a test hook), pause after writing to disk but before
returning from the flush call.  At that moment, `_computed.identifierLookup` must not yet contain
the new entry.  After the flush returns successfully, the entry must be present.

### Property 7 — Rollback on failed commit

If the LevelDB batch flush fails (simulated by injecting a failure), no new identifier mappings
from that operation are visible in `_computed.identifierLookup` after the failure.

*Verification approach:* inject a flush failure; assert that keys that were being allocated during
the failing operation are not in `_computed.identifierLookup` afterwards, and that the on-disk map
is also unchanged.

### Property 8 — Replica cutover replaces the lookup entirely and exactly

After a replica cutover, `_computed.identifierLookup` contains exactly the entries from the new
replica's `identifiers_keys_map`, and no entries from the old replica's lookup.

*Verification approach:* populate replica A with identifiers, perform a cutover to replica B
(which has a different set of identifiers), assert that `_computed.identifierLookup` matches
replica B's lookup exactly (equal in both directions) and contains no replica A entries.

### Property 9 — Nested pull shares allocation context

If an outer pull for node X causes an inner pull for node Y (a dependency), and Y was previously
unseen, then after both pulls complete, the identifier allocated for Y is present in the same
committed batch as the data for X (i.e., they appear in the same atomic write), and both appear
on disk before either appears in `_computed.identifierLookup`.

*Verification approach:* use a test graph where X depends on Y (both unseen); instrument the
LevelDB batch to capture which keys are written in each batch; assert that Y's identifier entry and
X's node data appear in the same batch, and that the volatile lookup is updated only after the
flush.

### Property 10 — Read-only lookups do not interfere with allocations

A concurrent operation that only reads existing identifiers (no new allocations) does not interfere
with an operation that is simultaneously allocating new identifiers.  Both operations complete
successfully and the reader sees a consistent, fully-committed state.

*Verification approach:* run a reader and an allocator concurrently; assert neither fails, the
reader sees a state that is exactly some committed version of the disk, and the allocator's new
entries are only visible after its batch is flushed.
