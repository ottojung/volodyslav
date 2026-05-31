# PR #1335 review 1 strategy

## Objective

Implement the target design from `docs/design.md` without weakening the guarantees introduced by PR #1335. The strategy is to preserve the identifier-keyed storage model while replacing broad transaction-body serialization with principled minimal locking.

## Principles

1. **Disk before memory.** The volatile identifier lookup must never publish mappings that are not already durably flushed.
2. **Reserve synchronously.** Identifier generation, collision checking, and in-flight reservation must complete in one non-yielding call stack.
3. **Serialize only shared state.** Computors and dependency traversal should not run under the commit mutex. Shared durable records are merged under the commit mutex.
4. **Own node writes by node lock.** A transaction that computes a concrete node holds that node lock until commit or abort.
5. **Merge shared reverse-dependency records.** Reverse dependencies are shared by many dependents, so updates must be represented as merge intents rather than eager whole-array overwrites.
6. **Rebase late.** A transaction that reserved an identifier for a node key may discover at commit that another transaction already committed a canonical identifier for that key. In that case, rewrite the transaction's node-state intents to the canonical identifier and discard the non-canonical reservation.
7. **Keep migration/storage compatibility.** Persisted formats introduced by PR #1335 remain unchanged: graph sublevels are identifier-keyed and `identifiers_keys_map` remains the durable bijection.

## Concurrency model

- Pulls enter pull mode and can overlap with other pulls.
- Invalidations and inspection enter observe mode and can overlap with each other.
- Pull mode and observe mode remain mutually exclusive.
- Per-node locks serialize pulls of the same concrete node and shared dependency nodes.
- Disjoint pulls may execute computors concurrently.
- Commit phases serialize with a short computed-state mutex per active replica.

## Identifier model

Each transaction owns an overlay lookup plus a set of reserved identifier strings. The root active state owns a process-local in-flight identifier set. Allocation is synchronous and checks both committed identifiers and in-flight identifiers. Abort and commit cleanup always clear the transaction's reservations.

## Commit model

Under the commit mutex, a transaction rebases its overlay on the latest committed lookup, renders logical node writes to raw database operations, merges reverse-dependency additions against the latest committed reverse-dependency records, writes `identifiers_keys_map` if needed, awaits the durable batch, and only then publishes new mappings to the volatile committed lookup.

## Testing strategy

Update tests that encoded the previous broad-mutex behavior, and add/keep tests that assert the new design properties: disjoint pull concurrency, same-node serialization, shared-dependency convergence, rollback after failed batches, volatile lookup not advancing during disk flush, and reverse-dependency preservation.
