# IncrementalGraph locking design

## Goal

IncrementalGraph should allow independent pull work to run concurrently while preserving the durable/volatile consistency of the identifier-based database.

The required behavior is:

1. `pull()` operations may overlap other `pull()` operations unless they need the same concrete node.
2. `pull()` operations do not overlap invalidation or inspection reads.
3. `invalidate()` operations may overlap other `invalidate()` operations.
4. Inspection reads may overlap invalidation.
5. Maintenance operations such as database open, reset, replica switch, and migration exclude all graph activity.
6. The volatile identifier lookup never contains data that has not first been durably written.
7. Identifier allocation remains a bijection: one semantic node key has one identifier, and one identifier belongs to one semantic node key.

The main implementation task is to remove the broad lock around whole transactions. User computors and dependency traversal must not run under the commit/publish lock.

## Model

### Node key and node identifier

A concrete graph node has two identities:

- `NodeKeyString` is the canonical semantic identity: node head plus bindings.
- `NodeIdentifier` is the opaque durable storage identity used as the key in graph sublevels.

The persistent graph sublevels are keyed by `NodeIdentifier`. The mapping between semantic keys and identifiers is stored in `global/identifiers_keys_map` and mirrored in memory as `identifierLookup`.

### Identifier lookup

The committed lookup is a bijection:

```javascript
{
    keyToId, // Map<NodeKeyString, NodeIdentifier>
    idToKey, // Map<string, NodeKeyString>
}
```

The in-memory committed lookup is part of the active root computed state and is updated only after the durable batch containing the same lookup update succeeds.

### Transaction

A transaction is the state for one top-level graph operation. It contains:

```javascript
{
    batch,
    identifierLookup,
    reservedIdentifiers,
    heldNodeLocks,
    inFlight,
}
```

Where:

- `batch` is the existing read-your-writes batch for node-data sublevels.
- `identifierLookup` is a transaction overlay containing only mappings newly allocated by this transaction, backed by the committed lookup.
- `reservedIdentifiers` is the set of generated identifier strings reserved by this transaction and not yet committed or aborted.
- `heldNodeLocks` is the set of concrete node-lock keys held until transaction finish.
- `inFlight` deduplicates repeated pulls of the same node within this transaction.

A transaction does not need an ID. Correctness is derived from lock ownership, synchronous reservation, and commit assertions, not from diagnostic transaction ownership metadata.

### Active root computed state

The active root computed state contains the active replica handles, committed identifier lookup, and a set of generated identifiers reserved by live transactions:

```javascript
{
    replicaName,
    namespaceSublevel,
    globalSublevel,
    schemaStorage,
    identifierLookup,
    inFlightIdentifiers,
}
```

`inFlightIdentifiers` is a `Set<string>`. It prevents two live transactions from reserving the same generated identifier before either transaction commits. It does not store transaction owners.

## Locking primitives

### Graph activity mode lock

There is one graph activity key with compatible modes:

```text
GRAPH_ACTIVITY_KEY
```

Use it as follows:

| Operation | Mode |
| --- | --- |
| Pull | `pull` |
| Invalidation | `observe` |
| Inspection read | `observe` |
| Maintenance | `exclusive` |

Same-mode holders may overlap. Different modes exclude each other. Therefore pulls can overlap pulls, invalidations can overlap invalidations, inspection can overlap invalidation, and maintenance excludes everything.

The graph activity lock is always the first lock acquired by public graph operations.

### Concrete node lock

There is one exclusive lock per canonical semantic node key:

```text
NODE_KEY(nodeKeyString)
```

The lock key is the semantic `NodeKeyString`, not the `NodeIdentifier`, because a previously unseen node does not have a committed identifier yet. Using the semantic key guarantees that two concurrent operations cannot allocate two different identifiers for the same node while it is still absent from the committed lookup.

This lock protects:

- execution of the pull body for that concrete node;
- writes to node-owned records: `values[node]`, `freshness[node]`, `inputs[node]`, `counters[node]`, and `timestamps[node]`;
- read-modify-write updates to that node's reverse-dependency list when the node is used as an input;
- creation of a new identifier mapping for that node key.

A transaction holds every acquired concrete node lock until commit or abort. Releasing a node lock before commit is unsafe because the transaction's batch is still private; another transaction could read the old durable state and compute or update against stale data.

If a transaction already holds `NODE_KEY(k)`, reacquiring it is a no-op.

### Commit mutex

There is one short commit mutex per active replica:

```text
COMMIT_KEY(replicaName)
```

The commit mutex protects only the durable commit and volatile publication phase. It does not protect computor execution, dependency traversal, identifier generation, or waiting for concrete node locks.

## Identifier allocation

Identifier allocation is a synchronous operation. It must not `await`, perform I/O, call user code, schedule callbacks, or acquire a sleeper mutex.

Before a transaction creates a new mapping for `nodeKey`, it must hold `NODE_KEY(nodeKey)`. That lock prevents another live transaction from creating a competing mapping for the same semantic key.

Allocation algorithm:

1. If the transaction overlay maps `nodeKey`, return that identifier.
2. If the committed lookup maps `nodeKey`, return that identifier.
3. Assert that the transaction holds `NODE_KEY(nodeKey)`.
4. Generate a candidate identifier synchronously.
5. If the committed lookup already maps the candidate identifier to any key, retry.
6. If `inFlightIdentifiers` already contains the candidate identifier string, retry.
7. Add the candidate identifier string to `inFlightIdentifiers`.
8. Add `nodeKey -> candidate` and `candidate -> nodeKey` to the transaction overlay.
9. Add the candidate identifier string to `tx.reservedIdentifiers`.
10. Return the candidate.

Steps 4 through 9 are one non-yielding critical section. In a single Node.js writer process, no other graph operation can interleave between the duplicate checks and the reservation insert.

If a transaction aborts, every identifier in `tx.reservedIdentifiers` is removed from `inFlightIdentifiers`. If a transaction commits, those reservations are removed after durable commit and volatile publication.

## Pull protocol

A top-level pull follows this sequence:

1. Acquire `GRAPH_ACTIVITY_KEY` in `pull` mode.
2. Create an empty transaction.
3. Pull the requested node within the transaction.
4. Commit the transaction under `COMMIT_KEY(replicaName)`.
5. Release all concrete node locks held by the transaction.
6. Release graph activity mode.

Pulling a concrete node within a transaction follows this sequence:

1. Canonicalize the requested node to `nodeKeyString`.
2. If `tx.inFlight` already has this key, await and return that promise.
3. Acquire `NODE_KEY(nodeKeyString)` unless already held by the transaction.
4. Resolve or allocate the node identifier.
5. Read freshness and value through `tx.batch`.
6. If the node is up-to-date, return the cached value while keeping the node lock held until transaction finish.
7. Pull static and dynamic dependencies using the same transaction.
8. For every dependency, keep its concrete node lock held until transaction finish.
9. Write this node's value, freshness, inputs, counter, timestamp, and reverse-dependency updates into `tx.batch`.
10. Return the recompute result.

Dependency pulls use exactly the same transaction. They do not acquire graph activity mode and do not create a nested transaction.

This protocol is intentionally conservative about dependency locks: if a recomputation will add this node to `revdeps[input]`, the transaction must hold the concrete node lock for `input` until commit. That makes reverse-dependency updates ordinary batch writes rather than global diffs.

## Invalidation protocol

A top-level invalidation follows this sequence:

1. Acquire `GRAPH_ACTIVITY_KEY` in `observe` mode.
2. Create an empty transaction.
3. Canonicalize the target node key.
4. Acquire `NODE_KEY(targetNodeKey)` if the invalidation must create an identifier mapping or materialize the target node's input record.
5. Resolve or allocate the target node identifier.
6. Write `freshness[target] = "potentially-outdated"` into `tx.batch`.
7. Propagate `"potentially-outdated"` through existing reverse-dependency records.
8. Commit the transaction under `COMMIT_KEY(replicaName)`.
9. Release all concrete node locks held by the transaction.
10. Release graph activity mode.

Concurrent invalidations are allowed because their freshness writes are idempotent. If an invalidation only touches already-identified nodes and only sets freshness to `"potentially-outdated"`, it does not need to acquire node locks for every propagated dependent. If it creates new identifier mappings or materialized records, it must hold the corresponding concrete node locks until transaction finish.

## Commit protocol

The transaction's node-data writes remain a normal LevelDB batch. They are not converted into a logical diff representation.

Only the identifier overlay is rebased against the latest committed lookup. The overlay is global metadata, while the node-data batch is protected by concrete node locks.

Under `COMMIT_KEY(replicaName)`:

1. Read the latest active schema storage and committed identifier lookup.
2. For each transaction overlay entry, assert that the committed lookup does not already map the same node key to a different identifier.
3. For each transaction overlay entry, assert that the committed lookup does not already map the same identifier to a different node key.
4. Merge the overlay entries into a lookup snapshot.
5. If the overlay is non-empty, append one `global/identifiers_keys_map` put operation containing the full serialized merged lookup.
6. Flush the transaction's existing node-data operations plus the optional lookup put in one durable batch.
7. After the batch succeeds, publish the overlay entries into the volatile committed lookup.
8. Remove `tx.reservedIdentifiers` from `inFlightIdentifiers`.
9. Return the transaction result.

If any assertion fails before the durable batch, abort the transaction and leave the volatile committed lookup unchanged. Such a failure indicates that a caller created a mapping without holding the required concrete node lock, or that durable state was changed outside this protocol.

If the durable batch fails, abort the transaction, clear reservations, release locks, and leave the volatile committed lookup unchanged.

If the process crashes after the durable batch succeeds but before volatile publication, restart reconstructs the lookup from durable `identifiers_keys_map`.

## Why node-data batches are not diffs

Node-data conflicts should be prevented by lock coverage, not repaired by a second merge language.

The batch writes are safe when these ownership rules hold:

- A transaction writing node-owned records for `node` holds `NODE_KEY(nodeKey)` until commit.
- A transaction updating `revdeps[input]` holds `NODE_KEY(inputNodeKey)` until commit.
- Invalidation writes that set freshness to `"potentially-outdated"` are idempotent.
- Maintenance operations run in `exclusive` graph activity mode.

Identifier lookup updates are different because unrelated transactions can allocate different node keys concurrently. Therefore the transaction identifier overlay is merged under the commit mutex. This is the only required diff-like operation.

## Inspection protocol

Inspection reads acquire `GRAPH_ACTIVITY_KEY` in `observe` mode.

Single-record reads may read the current durable sublevels normally.

Inspection reads that combine `identifierLookup` with durable node-data sublevels must not observe a volatile lookup that is newer or older than the durable records being combined with it. The simplest rule is: take `COMMIT_KEY(replicaName)` around multi-record inspection reads that combine volatile lookup state with durable sublevel scans.

## Maintenance protocol

Operations that replace active replica state, migrate storage, reset the database, or reopen active handles acquire graph activity in `exclusive` mode.

Exclusive operations may rebuild `_computed`, including `identifierLookup` and `inFlightIdentifiers`. They must not run concurrently with pull, invalidation, inspection, or commit publication.

## Lock order

All code follows this order:

1. graph activity mode lock;
2. concrete node locks;
3. synchronous identifier allocation while holding the concrete node lock for the allocated key;
4. commit mutex;
5. release commit mutex;
6. release concrete node locks;
7. release graph activity mode lock.

Code must never acquire graph activity mode while holding a concrete node lock or the commit mutex. Code must never call user computors while holding the commit mutex.

The dependency graph is a DAG, so recursive dependency pulls acquire concrete node locks along dependency edges. A concrete-node deadlock would imply a dependency cycle, which graph construction rejects.

## Multi-process boundary

`inFlightIdentifiers` is an in-process reservation set. This design assumes one active writer process per database replica.

If multiple writer processes can write the same replica, identifier reservation must move to durable transactional storage with uniqueness guarantees. The in-memory reservation set is not sufficient across processes.

## Required tests

The implementation should include tests for:

1. two disjoint pulls both enter their computors before either finishes;
2. two pulls of the same node serialize on the concrete node lock;
3. two pulls with a shared dependency serialize only at the shared dependency;
4. nested pulls reuse the outer transaction and do not create a nested transaction;
5. duplicate generated identifier candidates retry using `inFlightIdentifiers`;
6. abort clears identifier reservations and releases concrete node locks;
7. durable batch failure leaves volatile `identifierLookup` unchanged;
8. reverse-dependency updates from concurrent pulls preserve every dependent;
9. concurrent invalidations converge on `"potentially-outdated"` without requiring full batch diffs;
10. multi-record inspection does not combine mismatched volatile lookup and durable node-data snapshots;
11. exclusive maintenance blocks pull, invalidation, inspection, and commit publication.
