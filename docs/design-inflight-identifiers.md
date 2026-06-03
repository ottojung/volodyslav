# Design: In-Flight Identifier Reservation

**Issue:** Review §1.5 — Two concurrent transactions on different keys can allocate the same random 9-char identifier. Neither sees the other's uncommitted overlay allocation. When the second transaction commits, `commitTransactionLookup` silently overwrites the first's `idToKey` entry, breaking the bijection invariant.

**Root cause:** `txAllocateNodeIdentifier` checks only the transaction's own overlay and the committed base lookup. It has no visibility into identifiers that other concurrently-executing transactions have reserved but not yet committed.

---

## Design

Add an **in-process shared variable** `_inFlightIdentifiers: Set<string>` directly on `RootDatabaseClass` that tracks identifiers reserved by in-flight (not-yet-committed) transactions. This variable lives **outside** `_computed` — it is purely ephemeral and must NOT be reconstructible from a database snapshot.

### Why not on `_computed`?

`_computed` is an *injection* of the durable database into memory. Every field in `_computed` can be reconstructed by opening the replica's sublevels and reading persisted metadata. On a replica switch (`setCurrentReplicaPointer`) or database reopen, `_computed` is rebuilt from scratch. Ephemeral state that should not survive a pointer switch — such as in-flight identifier reservations — must live directly on the class instance.

### Key Properties

1. **Check-and-reserve inside the allocation loop**: `txAllocateNodeIdentifier` accepts an optional `tryReserve: (candidateString: string) => boolean` callback. The loop calls `tryReserve` and only commits to a candidate if it returns true — no async interleaving between check and add.

2. **Garbage collection on transaction completion**: Every identifier added to `_inFlightIdentifiers` is removed in a `finally` block after `withTransaction` completes, regardless of success or failure.

3. **No new mutex**: The existing `withCommitMutex` serializes commits, but allocations happen before the commit mutex. The in-flight set is the cross-transaction communication channel that closes this window without adding a new lock.

---

## Affected Files

| File | Change |
|---|---|
| `root_database.js` | Add `_inFlightIdentifiers: Set<string>` field on class. Add `reserveIdentifier`, `releaseIdentifiers` methods. |
| `identifier_lookup.js` | Modify `txAllocateNodeIdentifier` to accept optional `tryReserve: (string) => boolean` callback. |
| `graph_state.js` | Modify `getOrAllocateNodeIdentifier` to pass `tryReserve` callback. Add `finally` cleanup in `withTransaction`. |
| `class.js` | Modify `resolveConcreteNode` to pass `tryReserve` callback. |

---

## Detailed Changes

### 1. `root_database.js` — Ephemeral state on the class

Add field alongside existing fields (not inside `_computed`):

```javascript
/**
 * Identifiers that have been reserved by in-flight (not-yet-committed)
 * transactions but are not yet in the committed `identifierLookup`.
 * Lives outside `_computed` because it is purely ephemeral — it must NOT
 * be reconstructed from a database snapshot.
 * @private
 * @type {Set<string>}
 */
_inFlightIdentifiers;
```

Initialize in constructor:
```javascript
this._inFlightIdentifiers = new Set();
```

Add methods on `RootDatabaseClass`:

```javascript
/**
 * Atomically reserve an identifier for the current transaction.
 * Returns true if the identifier was successfully reserved (was not already
 * in the set). Safe to call from within the allocation loop because it is
 * synchronous (no await) — no concurrent task can interleave between the
 * has-check and the add.
 * @param {string} identifierString
 * @returns {boolean}
 */
reserveIdentifier(identifierString) {
    if (this._inFlightIdentifiers.has(identifierString)) {
        return false;
    }
    this._inFlightIdentifiers.add(identifierString);
    return true;
}

/**
 * Release a batch of identifiers after a transaction completes.
 * @param {Iterable<string>} identifierStrings
 * @returns {void}
 */
releaseIdentifiers(identifierStrings) {
    for (const id of identifierStrings) {
        this._inFlightIdentifiers.delete(id);
    }
}
```

### 2. `identifier_lookup.js` — Allocation with atomic check-and-reserve

Modify `txAllocateNodeIdentifier` to accept a `tryReserve` callback:

```javascript
function txAllocateNodeIdentifier(
    txLookup,
    nodeKey,
    makeIdentifier,
    maxAttempts = undefined,
    tryReserve = undefined,
) {
    const existing = txNodeKeyToId(txLookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }

    const keyString = nodeKeyStringToString(nodeKey);
    for (let attempt = 0; maxAttempts === undefined || attempt < maxAttempts; attempt++) {
        const candidate = makeIdentifier(attempt);
        const candidateString = nodeIdentifierToString(candidate);

        // Check transaction overlay and committed base.
        if (txNodeIdToKey(txLookup, candidate) !== undefined) {
            continue;
        }

        // Try to reserve. If another concurrent transaction already reserved
        // this identifier, skip it and retry with the next candidate.
        if (tryReserve !== undefined && !tryReserve(candidateString)) {
            continue;
        }

        txLookup.keyToId.set(keyString, candidate);
        txLookup.idToKey.set(candidateString, nodeKey);
        return candidate;
    }
    throw new IdentifierAllocationError(keyString);
}
```

### 3. `graph_state.js` — Transaction lifecycle integration

Modify `getOrAllocateNodeIdentifier` to pass the reservation callback:

```javascript
function getOrAllocateNodeIdentifier(tx, rootDatabase, nodeKey) {
    const existing = lookupNodeIdentifier(tx, nodeKey);
    if (existing !== undefined) {
        return existing;
    }
    return txAllocateNodeIdentifier(
        tx.identifierLookup,
        nodeKey,
        () => rootDatabase.generateNodeIdentifier(),
        undefined,
        (candidateString) => rootDatabase.reserveIdentifier(candidateString),
    );
}
```

Add `finally` cleanup in `withTransaction`:

```javascript
async withTransaction(fn) {
    // ... setup ...

    try {
        const result = await fn(tx);
        // ... existing commit logic ...
        return value;
    } finally {
        // Release all identifiers allocated by this transaction from
        // the shared in-flight set.
        const allocatedIds = [];
        for (const idString of txLookup.idToKey.keys()) {
            allocatedIds.push(idString);
        }
        rootDatabase.releaseIdentifiers(allocatedIds);
    }
}
```

### 4. `class.js` — resolveConcreteNode integration

Pass the reservation callback to `txAllocateNodeIdentifier`:

```javascript
async resolveConcreteNode(concreteNode, tx) {
    const outputIdentifier = txAllocateNodeIdentifier(
        tx.identifierLookup,
        concreteNode.output,
        () => this.rootDatabase.generateNodeIdentifier(),
        undefined,
        (candidateString) => this.rootDatabase.reserveIdentifier(candidateString),
    );

    return {
        outputKey: concreteNode.output,
        inputKeys: concreteNode.inputs,
        outputIdentifier,
        computor: concreteNode.computor,
    };
}
```

---

## Cleanup Guarantee

Every identifier added to `_inFlightIdentifiers` is removed in one of two ways:

1. **Normal commit**: `withTransaction`'s `finally` block runs after `commitTransactionLookup` has applied identifiers to the base lookup. The identifiers are released from the in-flight set because they are now visible via the base lookup.

2. **Exception / early return**: The same `finally` block runs. Identifiers that were allocated but never committed are released back to the pool.

3. **Replica switch / reopen**: A new `RootDatabaseClass` instance is created (or `_computed` is rebuilt). The old instance (and its `_inFlightIdentifiers`) is garbage-collected. There is no live transaction crossing a replica switch (switches happen under exclusive mode), so no identifiers are lost.

---

## Correctness Proof

**Claim:** Two concurrent transactions cannot both commit the same identifier for different keys.

**Proof:** Each transaction calls `txAllocateNodeIdentifier` which loops over candidates. For each candidate, the loop:

1. Checks the overlay — synchronous, step A.
2. Checks the base lookup — synchronous, step B.
3. Calls `tryReserve(candidateString)` which checks `_inFlightIdentifiers.has(c)`, returns false if present, otherwise adds it and returns true — synchronous, step C.
4. Only on success of all three does it record the candidate in the overlay — step D.

Steps A–D are all synchronous — no `await` between them. JavaScript is single-threaded, so no other task can modify `_inFlightIdentifiers` between the check and add in step C. Therefore if two concurrent transactions generate the same candidate, exactly one will succeed at step C; the other will see the reservation and continue to the next candidate. □

**Claim:** `_inFlightIdentifiers` does not leak identifiers.

**Proof:** Every identifier added to the set is added via `tryReserve` inside `txAllocateNodeIdentifier`. The `finally` block in `withTransaction` iterates `txLookup.idToKey` (which contains every identifier allocated by this transaction) and removes them from the set. This `finally` runs unconditionally. □

---

## Testing

1. **Unit test**: Mock `reserveIdentifier` to simulate contention. Call `txAllocateNodeIdentifier` with a `makeIdentifier` that produces colliding candidates. Verify the retry loop continues to the next candidate when `tryReserve` returns false.

2. **Integration test**: Use a seeded random to force two concurrent `pullNode` calls on different keys to generate the same identifier. Verify that both transactions commit successfully and `identifiers_keys_map` remains a strict bijection.

3. **Cleanup test**: Verify that if a transaction throws after allocating identifiers, the identifiers are released from `_inFlightIdentifiers` and are available for the next transaction.

4. **Concurrent cleanup test**: Two concurrent transactions where one commits and one throws. Verify the throwing transaction's identifiers are released and do not interfere with the committing transaction's identifiers.

---

## Alternatives Considered

### Extend commit mutex to cover allocation
Acquire `withCommitMutex` before calling `fn(tx)` instead of only during the commit phase. This would serialize all transactions and eliminate the need for in-flight tracking. **Rejected** because it serializes computation, defeating the purpose of concurrent pulls on different keys.

### Single global allocation mutex
A dedicated mutex for identifier allocation (separate from commit mutex). **Rejected** because the in-process Set approach achieves the same correctness with lower overhead (no lock acquisition, no queue management).

### Separate reserve call after allocation
Keep `txAllocateNodeIdentifier` unchanged and add `reserveIdentifier` calls in each caller. **Rejected** because a concurrent task could reserve the same identifier between `txAllocateNodeIdentifier`'s return and the caller's `reserveIdentifier` call, leading to an unreservable identifier in the overlay.
