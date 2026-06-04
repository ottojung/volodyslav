# Issue P3 — Error handling in `withTransaction` (Review Correction)

**TL;DR:** My review claimed there was a `rollback()` method that calls `db.close()` on failure. **That was incorrect.** The actual code does not have such a method. This document explains what the real error handling looks like, and whether any actual concern remains.

---

## What the review said

> "When a transaction's commit() fails, it calls rollback() internally. But rollback() calls this.batch.clear() followed by this.db.close(). Closing the database on any failed commit seems overly aggressive..."

This description does not match any code in the diff. There is no `Transaction` class with `commit()`/`rollback()` methods, no `this.batch.clear()`, and no `db.close()` in the transaction error path.

---

## What the actual code does

The transaction logic lives in `graph_state.js:4612–4688`, inside `makeGraphStorage`'s `withTransaction` method:

```
withTransaction  (graph_state.js:4612)
  │
  ├─ Create TransactionIdentifierLookup overlay (txLookup)
  ├─ Create BatchBuilder (batch + operations array)
  ├─ Run user callback: await fn(tx)
  ├─ Enter commit mutex: withCommitMutex(...)
  │   ├─ Apply revdep diffs (add/remove from batch.revdeps)
  │   ├─ Flush to disk: activeSchemaStorage.batch(operations)    ← atomic LevelDB write
  │   ├─ If allocations: commitTransactionLookup(txLookup)       ← apply overlay to base lookup
  │   └─ (exit mutex)
  └─ finally:
       rootDatabase._releaseAllocations(txLookup)                 ← cleanup pending reservations
```

**No `db.close()` anywhere in this path.** The `finally` block only calls `_releaseAllocations`, which removes this transaction's entries from the ephemeral `_pendingAllocations` map (`root_database.js:1825–1833`):

```js
_releaseAllocations(txLookup) {
    for (const keyString of txLookup.ownedKeys) {
        const idStr = this._pendingAllocations.get(keyString);
        this._pendingAllocations.delete(keyString);
        if (idStr !== undefined) {
            this._pendingAllocationsById.delete(idStr);
        }
    }
}
```

---

## Error scenarios and correctness

### Scenario A: User callback `fn(tx)` throws

1. The error propagates out of the `try` block immediately.
2. `activeSchemaStorage.batch(operations)` is **never called** — nothing written to disk.
3. The overlay `txLookup` is never applied (no `commitTransactionLookup` call).
4. `finally` runs: `_releaseAllocations` cleans up the transaction's pending reservation entries.

Result: clean — no leaked state.

### Scenario B: `activeSchemaStorage.batch(operations)` throws (flush failure)

1. LevelDB's `batch()` is atomic: if it throws, nothing was written.
2. `commitTransactionLookup` is **skipped** (it's after the batch call).
3. `finally` runs: `_releaseAllocations` cleans up.

Result: clean — no partial write, no leaked reservations.

### Scenario C: `commitTransactionLookup` throws (application of in-memory overlay fails)

1. Data is already safely on disk (the LevelDB batch succeeded).
2. `commitTransactionLookup` modifies in-memory state only (applies overlay entries to the base `IdentifierLookup`). This is a synchronous Map operation that should never throw under normal conditions.
3. If it did throw, the on-disk state and the in-memory lookup would be out of sync, but this is recoverable on next startup (which reloads from disk).

Result: recoverable, though an assertion or guard would be nice.

---

## Conclusion

The review's P3 was a false alarm — **there is no `db.close()` in the error path**. The actual error handling is well-structured:

- The `finally` block correctly releases identifier reservations on both success and failure (`root_database.js:1825`).
- LevelDB batch atomicity ensures no partial writes on flush failure.
- The disk-first invariant is maintained: `commitTransactionLookup` (in-memory) only runs after a successful `batch(operations)` (on-disk).

No changes needed.
