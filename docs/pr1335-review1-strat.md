# PR #1335 review 1: strategy

## Goals

Address both review findings without weakening the identifier-native design introduced by PR #1335:

1. Persist dynamic `pull` callback dependencies as first-class materialized inputs.
2. Prevent fresh concurrent pulls from deadlocking when they need overlapping dependency locks in different schema orders.
3. Preserve the existing transaction model: nested pulls share the outer transaction, and disk writes plus identifier lookup publication commit atomically.
4. Keep `graph_state.js` identifier-native; do not move semantic key translation back into storage.

## Dynamic dependency tracking strategy

During recomputation, maintain a per-parent dependency accumulator containing:

- dependency identifiers, in deterministic first-observed order;
- dependency counters, aligned by array index with the identifiers;
- a set of identifier strings to avoid duplicate entries when a computor pulls the same node more than once.

The accumulator starts with static dependencies after their nested pulls finish and counters are known. The computor `pull` callback then appends each dynamically pulled node after `_pullDuringPull(...)` returns and the dynamic node's counter is available from the transaction batch.

All downstream persistence uses the accumulator instead of the static-only arrays:

- `ensureReverseDepsIndexed(parent, accumulatedIdentifiers, batch)`;
- `ensureMaterialized(parent, accumulatedIdentifiers, accumulatedCounters, batch)`;
- freshness marking for dependencies.

This is intentionally not implemented in `graph_state.js`, because storage should receive already-resolved identifiers and counters. The semantic callback remains in recomputation code, where node-key-to-identifier lookup is already in scope through the transaction.

## Cached recomputation strategy

When a potentially-outdated node has an old value, the counter optimization may return the old value without executing the computor only if the current observed dependency list exactly matches the persisted `inputs` record and all counters match.

For nodes with dynamic dependencies, a static-only observation will not match an old persisted record containing dynamic dependencies, so the computor runs and re-observes its dynamic dependencies. That is correct: dynamic dependencies are only discoverable by executing the computor.

## Reverse dependency precision strategy

The immediate correctness requirement is to add missing reverse edges for dynamic dependencies so invalidation is conservative and stale values are not returned. This change may leave previously persisted reverse edges in place if a later dynamic branch stops depending on a node. That can cause extra invalidation but not stale cache reads. Removing obsolete reverse edges for all static and dynamic schema changes should be treated as a separate cleanup because the current storage helper is add-only for existing static dependencies too.

## Lock-ordering strategy

`resolveConcreteNode(...)` can know the static output and static inputs before allocating identifiers. It should collect the concrete-node locks required for identifier allocation and acquire them in lexicographic order of the serialized node key. After that, it can allocate identifiers and return the resolved node.

This removes circular wait for the reviewed static dependency scenario while preserving the invariant that a transaction holds the lock for a fresh node key before allocating its identifier.

Dynamic pulls are discovered at runtime and cannot all be pre-locked by the parent before the computor runs. They still go through normal nested pull resolution. If dynamic computors need multiple dependencies with explicit ordering guarantees, the API would need a separate batch dynamic-pull primitive; that is outside this review. The implemented canonical ordering fixes the concrete reviewed failure mode for static input lists and keeps the model extensible.

## Validation strategy

Add regression tests that fail against the reviewed implementation:

1. A node with no static inputs dynamically pulls `leaf`; invalidating `leaf` must make the parent recompute and return the new value.
2. The persisted parent inputs and `leaf` reverse dependencies must include the dynamic edge.
3. Concurrent pulls of nodes with shared fresh dependencies in opposite static input orders must complete rather than deadlock.

Then run focused tests, the full test suite, static analysis, and build.
