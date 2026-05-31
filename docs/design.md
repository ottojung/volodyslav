# IncrementalGraph minimal locking design

## Goal

Make IncrementalGraph comply with the locking requirements without serializing unrelated work. The current implementation must not hold the computed-state mutex while running computors, traversing dependencies, or performing ordinary batch reads and writes for disjoint nodes.

The required behavior is:

1. `pull()` is mutually exclusive with `invalidate()` and inspection reads through the graph activity mode lock.
2. `invalidate()` calls may overlap with other `invalidate()` calls.
3. Inspection reads may overlap with `invalidate()` calls.
4. Pulls of the same concrete node serialize.
5. Pulls of disjoint concrete node sets may overlap.
6. The volatile identifier lookup is updated only after the durable batch succeeds.
7. Two live transactions must not reserve the same newly generated identifier.

## Findings from PR #1335

PR #1335 moved graph persistence from semantic node keys to opaque node identifiers. That design is correct and should be preserved: graph state sublevels should remain identifier-native, and semantic key resolution should stay at the IncrementalGraph boundary.

The follow-up locking design does not need transaction IDs or an owner map for in-flight identifiers. Those fields are diagnostics only. Correctness requires only a set of reserved identifier strings, plus transaction-local knowledge of which identifiers must be released on commit or abort.

The design also should not turn every transaction batch write into a diff. Most records are node-owned: value, freshness, inputs, counters, and timestamps for one node are protected by that node's pull lock or are idempotent invalidation writes. The only shared graph records that need diff/merge treatment are reverse-dependency lists, because multiple dependents can concurrently add themselves to the same input's list.

## Coordination mechanisms

### Graph activity mode lock

The existing mode lock remains the outer lock:

- `pull` mode for public pull operations;
- `observe` mode for invalidation and inspection reads;
- `exclusive` mode for open, reset, migration, and replica switching.

This lock enforces the high-level compatibility matrix. It is acquired before any per-node or commit lock.

### Per-node pull locks

Each concrete node whose pull or invalidation body is operating on that node acquires a per-node lock keyed by the serialized concrete node key. The lock is held until the transaction commits or aborts, not merely until the computor returns. This prevents a second transaction from pulling the same concrete node while the first transaction's writes are still private.

Nested dependency pulls acquire additional per-node locks as dependencies are reached. Repeated pulls of the same node inside one transaction reuse the already-held lock.

### Commit mutex

The computed-state mutex is now a short commit mutex. It covers only:

1. rendering reverse-dependency merge intents against the latest committed revdeps records;
2. serializing the identifier lookup overlay with the current committed lookup;
3. writing the durable batch;
4. publishing identifier overlay entries to the volatile committed lookup after durable success.

No computor execution, dependency traversal, public callback execution, or identifier generation runs under this mutex.

## Identifier reservation

Identifier reservation is synchronous and in-memory:

1. Check the transaction overlay for an existing mapping.
2. Check the committed lookup for an existing mapping.
3. Generate a candidate identifier synchronously.
4. Reject it if the committed lookup or transaction overlay already contains it.
5. Reject it if the active in-flight identifier set already contains it.
6. Insert it into the active in-flight identifier set.
7. Insert it into the transaction overlay and transaction `reservedIdentifiers` set.

Because the check/generate/reserve sequence has no `await`, another operation in the same Node.js process cannot interleave between the duplicate check and the reservation insert. The reservation set is cleared in a `finally` path after commit or abort.

No `transaction.id` is required. No `inFlightIdentifierOwners` map is required.

## Transaction writes

### Node-owned writes stay as batch operations

The following writes remain ordinary transaction batch operations:

- `values[node] = value`;
- `freshness[node] = state`;
- `inputs[node] = inputsRecord`;
- `counters[node] = counter`;
- `timestamps[node] = timestampRecord`.

They are not converted to diffs.

### Reverse dependencies are merge intents

Reverse-dependency additions are queued as:

```text
revdepsAdd(inputIdentifier, dependentIdentifier)
```

At commit, while holding the commit mutex, each input's latest committed revdeps list is read, the dependent identifiers are inserted if missing, the list is kept sorted, and the merged record is written in the same durable batch as the node-owned writes.

## Commit and cleanup protocol

For each transaction:

1. Create the transaction overlay and read-your-writes batch outside the commit mutex.
2. Run the graph operation while acquiring per-node locks as needed.
3. Enter the commit mutex.
4. Render reverse-dependency merge intents.
5. Add the serialized identifier lookup operation if new identifiers were allocated.
6. Write the durable batch.
7. Publish the identifier overlay to the volatile lookup only after the durable write succeeds.
8. Leave the commit mutex.
9. Release in-flight identifier reservations.
10. Release held per-node locks.

If any step before durable success fails, volatile identifier lookup publication does not happen, reservations are cleared, and per-node locks are released.

## Implementation checklist

- Keep graph activity mode locking unchanged.
- Replace transaction-body serialization with commit-only serialization.
- Add per-node locks held through commit or abort.
- Add synchronous in-flight identifier reservation without transaction IDs or owner maps.
- Convert only reverse-dependency additions to commit-time merge intents.
- Keep node-owned batch writes eager and simple.
- Test that disjoint pulls overlap, same-node pulls serialize, duplicate generated identifiers are retried, failed batches do not publish volatile identifiers, and concurrent reverse-dependency additions are preserved.
