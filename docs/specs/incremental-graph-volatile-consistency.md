# Incremental Graph: Transaction Model and Persistence Consistency

## Overview and guiding principles

The IncrementalGraph system stores its state in two layers:

1. **Persisted layer** — a LevelDB database on disk. Survives process restarts. Stores node
   values, freshness markers, input dependency records, reverse-dependency indices, monotonic
   counters, creation/modification timestamps, and the *identifier lookup* (the bijection between
   semantic node keys and deterministic fingerprint-index node identifiers).

2. **Volatile layer** (`_computed`) — an in-memory mirror of the persisted layer. Lives inside
   `RootDatabase`. Provides fast in-process access to the current committed state.

The consistency guarantee is:

> **At every observable point, the volatile layer is exactly isomorphic to the persisted layer.**

An *observable point* is any moment outside an active transaction. Inside a transaction, working
state may temporarily diverge; by the time the transaction commits (or rolls back), the volatile
layer is restored to exact correspondence with whatever is on disk.

Two principles guide the entire design:

- **Explicit over ambient.** Nested operations receive their transaction context as a direct
  function argument. There is no global state, no implicit ambient context, and no use of
  `async_hooks` or similar introspection mechanisms.

- **Disk before memory.** The in-memory state is updated only after the LevelDB batch has been
  durably flushed. A failed flush leaves both disk and memory unchanged.

---

## Data model

### Persisted state (LevelDB)

Node data is stored in typed sublevels keyed by `NodeIdentifier`:

| Sublevel | Key | Value |
|----------|-----|-------|
| `values` | `NodeIdentifier` | computed node value |
| `freshness` | `NodeIdentifier` | `'up-to-date'` or `'potentially-outdated'` |
| `inputs` | `NodeIdentifier` | input identifier list and their counters |
| `revdeps` | `NodeIdentifier` | reverse-dependency list |
| `counters` | `NodeIdentifier` | monotonic integer counter |
| `timestamps` | `NodeIdentifier` | creation and modification timestamps |

Metadata is stored separately in sublevels keyed by fixed string keys:

| Sublevel | Key | Value |
|----------|-----|-------|
| `global` | `'identifiers_keys_map'` | identifier ↔ key bijection |
| `global` | `'last_node_index'` | greatest durably-retired allocation index |
| `global` | `'fingerprint'` | local allocation fingerprint |
| `_meta` | `'current_replica'` | active replica name (`'x'` or `'y'`) |

### Derived volatile state (`_computed`)

`_computed` is the *injection* of the durable database into memory: every field can be
reconstructed by opening the replica's sublevels and reading its persisted metadata.
It mirrors the persisted state:

| Field | Type | Meaning |
|-------|------|---------|
| `replicaName` | `'x' \| 'y'` | Active replica name. |
| `namespaceSublevel` | `SchemaSublevelType` | LevelDB sublevel handle for the active replica. |
| `globalSublevel` | `GlobalSublevelType` | Global sublevel handle. |
| `schemaStorage` | `SchemaStorage` | Typed accessors for all node-data sublevels. |
| `identifierLookup` | `IdentifierLookup` | Bijection `NodeKeyString ↔ NodeIdentifier`. |
| `lastNodeIndex` | `number` | Greatest durably-retired allocation index. |
| `fingerprint` | `string` | Machine-local database fingerprint. |

All replica-derived runtime state lives in `_computed`. No other long-lived field of
`RootDatabase` may hold replica-derived state. Short-lived local variables that do not persist
across `await` boundaries and are not shared between concurrent call chains are exempt.

Ephemeral, in-process-only state (such as `_pendingAllocations` for concurrent identifier
reservation) lives directly on the `RootDatabase` class, NOT inside `_computed`. This ensures it
is never discarded or reconstructed during a replica cutover, which replaces `_computed` from the
on-disk state. An example is `_pendingAllocations` and its reverse map `_pendingAllocationsById`,
which track identifier reservations made by in-flight transactions; they must survive across
replica switches because a cutover can happen while allocations are in flight.

### NodeIdentifier and NodeKeyString

- **NodeKeyString** — a human-readable encoding of a node's computation: its head name and
  argument list (e.g., `'fetch["https://example.com"]'`).
- **NodeIdentifier** — a deterministic `<base36-index>-<fingerprint>` string used as the actual
  database key in every node-data sublevel. See `keys-design.md` for the full format specification.

The `identifierLookup` is the only place where semantic keys are translated to storage keys. It
is a strict bijection represented as two inverse maps:

```
IdentifierLookup = {
    keyToId: Map<NodeKeyString, NodeIdentifier>,
    idToKey: Map<NodeIdentifier, NodeKeyString>,
}
```

The persisted form of the lookup is stored under `'identifiers_keys_map'` in the active replica's
global sublevel as a sorted array of `[NodeIdentifier, NodeKeyString]` pairs. The lookup is
append-only: entries are never deleted within a single replica session.

---

## Transaction model

### What a transaction is

A **transaction** is a short-lived object that groups all reads and writes for one
`pullNode(key)` call — whether top-level or nested. It contains:

- **batch** — a LevelDB batch accumulator with a read-your-writes overlay. Writes queued into the
  batch are visible to subsequent reads within the same transaction; reads that miss the overlay
  fall through to the underlying database.
- **identifierLookup** — a working copy of the committed lookup, extended in-place with any new
  allocations made during this transaction. At commit time this becomes the new committed lookup.

A transaction is created at the start of every `pullNode(key)` call, whether it originates from
the public API or from a nested dependency pull inside a computor. That transaction covers exactly
that single `pullNode` execution: the node's freshness check, its dependency pulls (each with their
own independent transaction), its own recomputation, and its own batch writes. It never outlives
the concurrency scope that protects its node writes and identifier allocations.

Parent and nested pulls do **not** share a transaction. Each nested pull opens its own transaction,
commits it independently, and returns the computed value to the parent. This is detailed in
[Nested pulls and independent commits](#nested-pulls-and-independent-commits) below.

### Concurrency requirements

The specification does not require one particular locking implementation. A valid implementation
may use a single graph mutex, finer-grained node locks plus a commit lock, or another equivalent
scheme. It must satisfy these semantic requirements:

- Two transactions that can write the same concrete node cannot concurrently mutate that node's
  persisted records.
- Identifier allocation for a semantic node key is serialized with any other transaction that could
  allocate or publish an identifier for the same key.
- Identifier publication is atomic at observable boundaries: callers never observe a partially
  updated volatile `identifierLookup`.
- Commit publication is ordered disk-first: durable writes complete before the volatile lookup is
  updated.
- Exclusive operations such as migration and replica cutover suspend incompatible graph activity.

The implementation should be as fine-grained as practical, but fine-grained locking must not weaken
the observable consistency guarantees above.

### Transaction lifecycle

Every `pullNode(key)` call — whether top-level or a nested dependency pull inside a computor —
follows this pattern:

```
withGraphConcurrencyScope(async () => {
    const tx = createTransaction()        // load committed lookup; create empty batch
    const result = await runOperation(tx) // pull / invalidate / inspect
    await commitTransaction(tx)           // flush batch, then update volatile state
    return result
})
```

`createTransaction()` reads `_computed.identifierLookup` (the committed lookup guaranteed by the
concurrency protocol to be exactly the disk state at that observable boundary) and creates a fresh
batch accumulator.

`commitTransaction(tx)` implements the disk-first ordering described in the next section.

### Nested pulls and independent commits

When computing a node's value, the computor may pull additional dependencies. Each nested pull
**creates its own Transaction** — it does not share a batch with the parent pull. Every nested
pull submits its batch independently as soon as it finishes, before the parent continues.

This ensures that a dependency's writes are committed to disk even if a later parent computor
fails. It also means that each pull is self-contained: the identifier allocations, value writes,
and metadata changes from one pull are never entangled with another.

Each pull must be internally idempotent. Since a dependency's pull commits independently before
the parent, a failure in the parent does not roll back the already-committed dependency.

The computor receives a `pull` callback that may be used for dynamic dependencies:

```
computor(inputValues, oldValue, bindings, pull)
    pull — (nodeName, bindings?) => Promise<ComputedValue>
           Calls into the graph.
           The computor must use this function for any dynamic dependencies.
           It must not call the graph's public pull method (which would deadlock).
```

A top-level pull creates a transaction and calls `pullNode(nodeKey)`. A nested pull does the
same: it calls `pullNode(nodeKey)` which creates its own fresh transaction. There is no structural
difference between the two paths — both create independent transactions.

---

## Commit protocol

### The invariant

At every observable point (outside an active commit publication), `_computed.identifierLookup`
contains **exactly** the same entries as the persisted `identifiers_keys_map` — no more and no
fewer.

### Commit sequence

When the operation completes inside its concurrency scope:

1. If any new identifier allocations were made during the transaction, append to the batch:
   - the updated `identifiers_keys_map` (the full working lookup);
   - the updated `last_node_index` (the committed allocation watermark).
2. Append any node records (values, freshness, inputs, counters, timestamps) accumulated by the
   transaction to the batch.
3. Flush the batch to LevelDB atomically.
4. **Only after a successful flush**:
   - publish the transaction lookup into `_computed.identifierLookup`;
   - advance `_computed.lastNodeIndex` to the committed watermark.
   `_computed.fingerprint` does not change during normal transactions.
5. If the flush fails: do not update `_computed.identifierLookup` or `_computed.lastNodeIndex`.
   Discard the failed allocations. Surface the error to the caller.

This ordering guarantees the invariant: the volatile layer always reflects exactly the committed
disk state at every observable point.

### Identifier allocation

When a pull encounters a node key not present in the transaction's working lookup:

1. Generate a deterministic candidate identifier from the next local index and the database
   fingerprint: `${nextIndex.toString(36)}-${fingerprint}`.
2. Add the `(candidate, key)` pair to the working lookup immediately — it is visible to subsequent
   operations within the same transaction, but it is not in `_computed` or on disk yet.

At commit time, the updated working lookup is written to disk as part of the batch (step 1 above),
and only then replaces `_computed.identifierLookup` (step 3 above).

---

## Initialisation and replica model

### Initial open

When the database is first opened:

1. Read the replica pointer from `_meta/current_replica`. This is the authoritative record of
   which replica is active.
2. Construct the `namespaceSublevel`, `globalSublevel`, and `schemaStorage` for that replica.
3. Load from the active replica's global sublevel:
   - `identifiers_keys_map`;
   - `last_node_index`;
   - `fingerprint`.
4. A genuinely fresh replica (no stored version) initializes empty lookup metadata,
   `last_node_index = 0`, and a valid fingerprint.
5. A versioned replica missing required identifier or allocation metadata must fail hard during
   open — silent repair is not permitted.
6. Assign `_computed = { replicaName, namespaceSublevel, globalSublevel, schemaStorage,
   identifierLookup, lastNodeIndex, fingerprint }`.

The lookup and allocation metadata are loaded once at open time. There is no lazy-loading step
and no uninitialized sentinel: `_computed` is always a valid, fully populated injection of the
durable database state after the database is opened.

### Replica cutover

A replica cutover replaces the active replica and therefore all of `_computed`. It runs under an
exclusive lock that suspends all graph activity (pulls, invalidations, inspections).

Steps:

1. Acquire the exclusive lock (all graph activity suspended).
2. Prepare the new replica's data in the inactive replica's sublevels.
3. Write the new replica pointer to `_meta/current_replica` durably.
4. Load the new replica's metadata from the new `globalSublevel`:
   - `identifiers_keys_map`;
   - `last_node_index`;
   - `fingerprint`.
5. Atomically replace `_computed`:
   ```
   _computed = {
       replicaName:       <new replica name>,
       namespaceSublevel: <new namespaceSublevel>,
       globalSublevel:    <new globalSublevel>,
       schemaStorage:     <new schemaStorage>,
       identifierLookup:  <loaded from new globalSublevel>,
       lastNodeIndex:     <loaded from new globalSublevel>,
       fingerprint:       <loaded from new globalSublevel>,
   }
   ```
6. Release the exclusive lock.

After step 5, any subsequent operation observes the new `_computed` exclusively. No entry from the
old replica's lookup, `lastNodeIndex`, or `fingerprint` persists in `_computed` after the cutover
completes, except where reset/import logic intentionally preserves the local fingerprint by writing
it into the target replica before the cutover.

---

## Module structure

The implementation is organized into four layers with strictly unidirectional dependencies:

```
database/         Raw LevelDB access: typed sublevels, node identifier generation,
                  identifier lookup serialization and bijection maintenance.
                  No knowledge of graph semantics.

graph_state.js    Volatile state (_computed): mutex management, transaction
                  creation, commit protocol (disk-first flush then memory update).
                  Depends only on database/.

pull.js           Pull algorithm: resolve node keys, check freshness, recompute
                  if needed, propagate dependency writes. Creates its own
                  Transaction for each pull; never acquires the mutex itself.
                  Depends on graph_state.js and database/.

invalidate.js     Invalidation algorithm: mark nodes potentially-outdated and
                  propagate through the reverse-dependency index.
                  Same transaction-based structure as pull.js.
                  Depends on graph_state.js and database/.

class.js          Public API surface. Creates transactions, acquires the mutex,
                  delegates to pull.js and invalidate.js, exposes the computor
                  interface with an explicit pull callback.
                  Depends on all of the above.
```

No module uses `async_hooks`, global mutable state, or any ambient context mechanism. The
dependency graph is a DAG.

---

## Testable properties

The following properties must hold for any conforming implementation.

### P1 — Committed identifiers are readable after commit

After a successful pull that allocates a new identifier for node key K, a subsequent lookup of K
in `_computed.identifierLookup` returns the same identifier.

### P2 — No concurrent allocation conflict

Two concurrent top-level pulls for the same fresh node key K both complete successfully and
produce the same identifier for K. The concurrency protocol ensures the relevant allocation and
publication steps are serialized; the later allocation attempt sees the identifier allocated by the
earlier one.

*Verification:* start two concurrent pulls for a fresh key. Assert that after both complete,
`_computed.identifierLookup` contains exactly one entry for K and both pulls saw the same identifier.

### P3 — Identifier stability across restarts

If node key K was assigned identifier I in one process session and that assignment was committed to
disk, then after the database is closed and reopened, pulling K returns a value keyed by I.

*Verification:* open DB, pull a node, close DB, reopen DB, assert the same identifier is returned
for the same key.

### P4 — Monotonicity

An entry present in `_computed.identifierLookup` at one observable point is present at every later
observable point within the same replica session.

*Verification:* snapshot the lookup before and after a sequence of operations; assert the
after-snapshot is a superset of the before-snapshot.

### P5 — Exact isomorphism at observable points

At every observable point, `_computed.identifierLookup` contains **exactly** the same entries as
the persisted `identifiers_keys_map` — no more and no fewer.

*Verification:* after any operation completes and its concurrency scope is released, read the
persisted map directly from LevelDB. Assert that the two sets are equal in both directions.

### P6 — Disk before memory

A new identifier allocation is never present in `_computed.identifierLookup` before the batch
containing it has been successfully flushed to disk.

*Verification:* using a test hook, pause inside the flush after writing to disk but before
returning. At that moment `_computed.identifierLookup` must not yet contain the new entry. After
the flush returns, the entry must be present.

### P7 — Rollback on failed flush

If the batch flush fails, no new identifier mappings or `last_node_index` advancement from that
transaction are visible in `_computed.identifierLookup` or `_computed.lastNodeIndex` afterwards,
and the on-disk state is also unchanged.

*Verification:* inject a flush failure; assert that keys being allocated during the failing
operation are absent from both `_computed.identifierLookup` and the on-disk map afterwards, and
that `_computed.lastNodeIndex` did not advance.

### P8 — Committed `last_node_index` reflected in `_computed`

After a successful transaction that allocates identifiers, `_computed.lastNodeIndex` reflects the
committed allocation watermark that was durably written to disk.

*Verification:* after a commit that allocates identifiers, read `last_node_index` from the on-disk
global sublevel and assert it matches `_computed.lastNodeIndex`.

### P9 — Replica cutover replaces the lookup and allocation metadata entirely

After a cutover to replica R, `_computed.identifierLookup`, `_computed.lastNodeIndex`, and
`_computed.fingerprint` contain exactly the values from R's global sublevel and no values from the
previous replica.

*Verification:* populate replica A with identifiers, high last_node_index, and one fingerprint;
prepare replica B with different identifiers, lower last_node_index, and a different
fingerprint. After cutover, assert all three fields match replica B's values exactly.

### P10 — Replica cutover preserves local fingerprint during reset/import

When a reset/import cutover is performed into an existing live database, the pre-import local
fingerprint is preserved by explicitly writing it into the target replica's global sublevel before
the cutover. After the cutover, `_computed.fingerprint` reflects the local fingerprint, not the
one from the imported snapshot.

*Verification:* create a live DB with fingerprint L, import a snapshot with fingerprint S,
cut over, assert `_computed.fingerprint` is L not S.

### P11 — Nested pulls submit independent batches

When an outer pull for node X causes an inner pull for node Y (a dependency), the inner pull
creates its own Transaction and submits its batch independently. Y's writes are fully committed
to disk before X's computor runs with Y's value.

*Verification:* use a test graph where X depends on Y (both unseen); inline a spy in the
LevelDB batch flush for the inner pull and assert that Y's data (identifier, value, counters,
timestamps) is written in its own batch commit, separate from X's batch.
