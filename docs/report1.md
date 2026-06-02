# Incremental Graph Locking Review

## Summary

The graph-activity locks now match the spec better than before, but the node-lock story is still not fully settled.

Current conclusion:
- `invalidate()` and inspection reads are correctly placed in `observe` mode.
- `pull()` is correctly placed in `pull` mode.
- The implementation still needs per-node locks for more than just the target node.
- Deadlock freedom is plausible, but the proof is not yet strong enough to treat as finished.

## Verified Flows

### Top-level pull

Observed path:
- acquire `withPullMode(...)`
- create transaction
- resolve target concrete node
- acquire target node lock
- acquire direct input node locks in sorted order
- run recomputation and any nested pulls in the same transaction

This is the correct graph-level phase, but the node-level lock set is larger than just the target.

### Nested pull during recomputation

Observed path:
- reuse the outer transaction
- no new graph-mode lock
- no new transaction
- no new commit scope

This is correct and necessary.

### Invalidate

Observed path:
- acquire `withObserveMode(...)`
- run invalidation inside the transaction

This matches the locking spec for graph-phase compatibility.

### Inspection reads

Observed path:
- acquire `withObserveMode(...)`
- read materialized state

This matches the spec and is the right place for concurrent reads.

### Commit / publication

Observed path:
- commit work is serialized with `withCommitMutex(...)`
- volatile lookup publication is disk-first

This appears consistent with the volatile-consistency spec.

## Findings

### 1. Target-only locking is not enough for the current storage model

The current pull path does not only mutate the target node's records.
It also mutates dependency metadata owned by each direct input:

- `reconcileReverseDeps(...)` rewrites `revdeps` entries for previous and current inputs.
- `ensureReverseDepsIndexed(...)` inserts the target into each input's reverse-dependency list.
- `ensureMaterialized(...)` rewrites the target's inputs record, which is target-owned, but the reverse-dependency updates are not.
- `resolveConcreteNode()` also allocates identifiers for inputs when needed.

So, with the current schema, a pull writes both:
- the target node's own records, and
- each direct input node's reverse-dependency record.

That means locking only the target node would leave shared input-owned writes unprotected.

### 2. The current direct-input lock set is justified, but only for the present design

The current `resolveConcreteNode()` locks the target first and then each unique direct input in sorted order.

That is not accidental. It protects:
- same-target recomputation,
- shared identifier allocation for input keys,
- concurrent writes to the same input's reverse-dependency record.

So the answer to the scope question is:
- for the current implementation, target-only is not enough;
- you need the target plus every direct input that the current transaction will publish dependency metadata against;
- you do not need to pre-lock the entire transitive closure up front, because nested pulls acquire their own target locks when they become active.

### 3. Deadlock freedom is not yet proven strongly enough

The lock order is currently:
- graph mode lock first,
- then per-node target/input locks.

Direct inputs are acquired in sorted order, which is good, and the DAG property helps a lot.
But the overall proof is still informal because nested pulls can extend the lock set dynamically while the transaction is already in flight.

I did not find a concrete deadlock in the reviewed flows, but I also do not think the current proof is strong enough to call this finished.

### 4. Efficiency is acceptable, but the current granularity is still coarse in one place

The graph-phase locks are now fine-grained enough to allow:
- concurrent invalidates,
- concurrent inspection reads,
- concurrent pulls on different nodes.

The remaining efficiency cost is the shared-input lock set during pull. That cost is real, but it is tied to the current storage layout, not just the lock API.

## Plan

### Near-term

1. Keep the current target-plus-direct-input locking model.
2. Make the lock-order contract explicit in code and docs.
3. Add a dedicated test matrix for overlapping pulls with shared inputs in different orders.
4. Add a stress test for dynamic dependency changes that exercises recursive lock extension.

### Medium-term

5. Tighten the deadlock proof by making the lock hierarchy explicit:
   - graph mode first,
   - then concrete-node locks in deterministic order,
   - no lock acquisitions outside that hierarchy.
6. Consider splitting resolution into two phases if we want better parallelism:
   - target ownership phase,
   - shared-input publication phase.

### Ambitious redesign if we want target-only locking

7. Change reverse-dependency publication so pulls do not directly rewrite shared input-owned records during computation.
8. Use an append-only dependency journal or another mergeable publication model.
9. Reconcile journals at commit time under a short, deterministic merge phase.

That redesign would let the active computation hold only the target lock, but it is a larger change because it reworks how dependency edges are published and read.

## Recommendation

Do not move to target-only locking as-is.
It is not correct for the current schema.

If the goal is fewer locks, the right path is a storage redesign that makes dependency publication mergeable instead of directly mutating shared input records.
