# PR #1335 review 1 implementation plan

## 1. Root active state

- Extend active root computed state with `inFlightIdentifiers` and `inFlightIdentifierOwners`.
- Add a synchronous `reserveNodeIdentifier(...)` helper on the root database.
- Add reservation cleanup and inspection helpers for commit validation and abort cleanup.
- Reinitialize in-flight reservation sets when switching or clearing active replicas.

## 2. Transaction shape

- Add transaction IDs.
- Add `reservedIdentifiers`.
- Add per-transaction pull-node lock tracking.
- Keep the transaction identifier overlay backed by the committed lookup.

## 3. Per-node pull locks

- Add a lock table in graph storage keyed by canonical node-key string.
- Acquire a node lock before executing that node's pull body.
- Store release functions in the transaction and release them only after commit or abort.
- Treat re-acquisition by the same transaction as a no-op to support nested repeated pulls.

## 4. Delayed input identifier allocation

- Avoid pre-allocating static input identifiers when starting a pull for a node.
- Pull dependencies first; after each dependency pull, read its identifier from the transaction overlay/base lookup.
- This prevents two concurrent parents from reserving separate identifiers for the same shared dependency before either reaches the dependency's per-node lock.

## 5. Logical batch operations

- Replace raw eager operations in graph transactions with logical operations tagged by graph sublevel name.
- Preserve read-your-writes behavior for node-owned records.
- Store reverse-dependency additions as merge intents.

## 6. Commit rebase and rendering

- Under the commit mutex, clone the current committed lookup to compute the durable serialized lookup without mutating volatile state.
- If a transaction's node key already has a committed identifier, rewrite its reserved identifier to the canonical one.
- Otherwise validate the reservation and include the new mapping in the serialized lookup.
- Render logical operations after identifier rewriting.
- Merge reverse-dependency additions by reading the latest committed record, inserting missing dependents, and preserving sorted order.
- Flush all operations in one durable batch.
- After successful flush, publish only newly committed mappings into the volatile lookup.

## 7. Cleanup

- In `finally`, clear all in-flight identifier reservations.
- Release all held per-node locks.
- Leave volatile committed lookup unchanged if the transaction body or durable batch fails.

## 8. Tests and validation

- Update concurrency tests to assert that disjoint pulls may enter computors concurrently.
- Keep rollback and volatile/durable consistency tests.
- Run targeted incremental graph tests first, then static analysis, full tests, and build.
