# PR #1335 Review 1 Implementation Plan

## 1. Root computed reservation state

- Add `inFlightIdentifiers: Set<string>` and `inFlightIdentifierOwners: Map<string, string>` to active root computed state.
- Reinitialize those sets/maps when the active replica is switched or cleared.
- For tests with minimal root database stubs, lazily attach equivalent reservation state when `_computed` is not present.

## 2. Transaction shape

- Add transaction IDs from a monotonic in-process counter.
- Add `reservedIdentifiers: Set<string>` to every transaction.
- Keep `identifierLookup` as an overlay backed by the committed lookup.
- Keep `inFlight` for transaction-local nested pull deduplication.

## 3. Synchronous identifier reservation

Implement `reserveNodeIdentifier(tx, rootDatabase, nodeKey)`:

1. Return an existing transaction/base lookup mapping if present.
2. Generate candidates synchronously through `rootDatabase.generateNodeIdentifier()`.
3. Reject candidates already present in the transaction/base lookup.
4. Reject candidates present in live `inFlightIdentifiers`.
5. Insert the candidate string into live reservations and diagnostics.
6. Insert the node-key mapping into the transaction overlay.
7. Insert the candidate string into `tx.reservedIdentifiers`.
8. Return the candidate.

Cleanup helper:

- Remove every `tx.reservedIdentifiers` entry from live reservation sets/maps.
- Clear `tx.reservedIdentifiers`.
- Never mutate committed lookup during cleanup.

## 4. Narrow transaction mutex

Change `withTransaction(fn)` so that it:

1. Creates transaction state without acquiring the computed-state mutex.
2. Awaits `fn(tx)` outside the commit mutex.
3. Acquires `withComputedStateMutex(...)` only after the body succeeds.
4. Under the mutex, appends `identifiers_keys_map` when allocations exist, awaits the durable batch, publishes overlay to the committed lookup, and clears reservations.
5. On any throw before or during commit, clears reservations and rethrows.

## 5. Concrete pull locking

- Add a `withPullNodeMutex(...)` helper in `lock.js` keyed by serialized concrete node key strings.
- For top-level pulls, acquire locks for the concrete output and its static concrete inputs in sorted de-duplicated order.
- Hold those locks until the transaction commits or aborts by wrapping the entire `graph.withTransaction(...)` call.
- Preserve nested pulls as transaction-local operations; `tx.inFlight` deduplicates repeated nested pulls in one transaction.

## 6. Tests

- Update concurrency tests so disjoint top-level pulls are expected to overlap.
- Add a deterministic duplicate-candidate test where two live transactions receive the same generated identifier and the second retries.
- Keep existing same-node serialization, mode-lock, volatile consistency, and batch-failure tests.
- Run focused suites first, then full test/static-analysis/build checks.
