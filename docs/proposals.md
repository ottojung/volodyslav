# Proposals for Full Compliance with Incremental Graph Locking Spec

## Context
This document evaluates realistic ways to achieve full compliance with `docs/specs/incremental-graph-locking-design.md` while preserving correctness of volatile↔persistent synchronization in the identifier lookup and node-state commit path.

The key tension is:

- Locking spec wants **fine-grained pull concurrency** (same-node serialized, different-node concurrent).
- Current volatile/persistent synchronization model relies on strong serialization to avoid lost updates during identifier allocation/commit.

## Compliance target (from spec)

To be fully compliant, the runtime must satisfy all of these simultaneously:

1. `invalidate` and inspection reads run in `observe` mode and may overlap.
2. `pull` runs in `pull` mode and is mutually exclusive with observe-mode activity.
3. Same-node pulls serialize via per-node pull key.
4. Different-node pulls are allowed to progress concurrently.
5. Lock order is stable and deadlock-safe.

## Non-negotiable correctness constraints

Any compliant design must preserve these invariants:

1. **Disk-first ordering for lookup updates**: volatile identifier map must never advance past what was durably flushed.
2. **No lost updates** across concurrent transactions that both allocate identifiers and/or write node-state records.
3. **Atomic visibility boundary**: each transaction’s node-state writes and accompanying identifier-map delta must commit as one coherent persistent batch.
4. **Crash safety**: restart from persistent snapshot must reconstruct a valid lookup/state pair.

## Proposal A (Recommended): Split execution phase from commit phase

### Idea
Allow concurrent pull computation and dependency traversal, but serialize only the final **commit phase** that merges identifier-allocation deltas and flushes persistent writes.

### Shape
- Keep `withModeMutex(GRAPH_ACTIVITY_KEY, "pull")` for pull phase exclusion vs observe.
- Add per-node `withMutex(PULL_NODE_KEY(node))` around top-level pull body for same-node exclusion.
- Run compute/resolve/freshness logic in per-transaction overlays concurrently.
- At commit boundary, acquire a dedicated `COMMIT_KEY(computedStateIdentifier)` mutex.
- Under `COMMIT_KEY`:
  - rebase/validate transaction identifier overlay against current base,
  - append serialized identifier delta,
  - flush storage batch,
  - then publish overlay into volatile lookup.

### Why it can be compliant
- Different-node pulls can compute in parallel.
- Same-node pulls still serialize.
- Observe/pull separation unchanged.

### Why volatile-persistent correctness holds
- The only shared mutable global is merged under one commit mutex.
- Disk-first ordering remains local to the commit critical section.
- Lost updates are prevented by serialized merge+flush.

### Trade-offs
- More complex transaction lifecycle (prepare vs commit states).
- Potential rebase/retry logic at commit if overlays conflict.

## Proposal B: Two-tier locking for allocation only + optimistic commit validation

### Idea
Serialize only identifier allocation operations with an allocation mutex, while permitting non-allocating transactions to commit concurrently if they do not touch lookup deltas.

### Shape
- Per-node + pull/observe locking as in spec.
- `ALLOC_KEY` protects calls that introduce new node identifiers.
- Transactions record whether they allocated.
- Commit path:
  - Non-allocating tx: commit node-state batch directly.
  - Allocating tx: acquire `ALLOC_KEY`, persist lookup delta + writes, then publish volatile.

### Correctness concerns
- Must guarantee atomic cross-transaction ordering between allocating and non-allocating commits touching related nodes.
- Requires strict constraints to avoid visibility skew where values are committed for identifiers not yet durably mapped.

### Assessment
Feasible but riskier than Proposal A due to mixed commit pathways and subtle ordering hazards.

## Proposal C: Global commit log / journaled state machine

### Idea
Convert commit into append-only journal entries (intent + apply), then materialize canonical maps/state from journal order.

### Benefits
- Strong replay model and explicit crash recovery semantics.
- Easy to reason about ordering and durability.

### Costs
- Large architectural change; heavy migration burden.
- Overkill for current codebase scope.

### Assessment
High assurance but disproportionate complexity for current objective.

## Proposal D: Preserve global transaction serialization (status quo+)

### Idea
Keep full serialization around transaction execution and formalize that as the concurrency contract.

### Assessment
- Preserves correctness trivially.
- Fails full locking-spec compliance because different-node pulls remain blocked.

Not acceptable if full compliance is mandatory.

## Comparative decision matrix

| Proposal | Full spec compliance | Volatile/persistent safety | Complexity | Recommended |
|---|---|---|---|---|
| A. Split execute/commit | High | High | Medium | **Yes** |
| B. Allocation-only serialization | Medium-High | Medium (subtle hazards) | Medium-High | Maybe |
| C. Journaled commit engine | High | High | Very High | No (now) |
| D. Keep global serialization | Low | High | Low | No |

## Recommended rollout (Proposal A)

1. **Lock primitives**
   - Introduce `PULL_NODE_KEY` helper and keep current mode locks.
   - Add dedicated `COMMIT_KEY` mutex for persistent/volatile merge.

2. **Transaction model split**
   - Phase 1: compute in transaction overlay (concurrent).
   - Phase 2: commit under `COMMIT_KEY` (serialized merge+flush+publish).

3. **Conflict policy**
   - Define deterministic rebase/abort semantics if overlay assumptions no longer hold at commit.
   - Prefer bounded retry for benign conflicts.

4. **Spec conformance tests**
   - Explicitly test:
     - different-node parallel pull start/progress,
     - same-node serialization,
     - observe/pull incompatibility,
     - invalidate/read compatibility.

5. **Synchronization integrity tests**
   - Concurrent allocation stress tests with crash/restart replay checks.
   - Assertions that every persisted identifier delta is reflected in volatile only after flush success.

## Acceptance criteria for final solution

A solution is acceptable only if all are true:

1. All locking-spec concurrency semantics are demonstrably satisfied.
2. No test shows volatile map ahead of durable state after injected failures.
3. Concurrent allocation workloads show no lost mappings or duplicate inconsistent mappings.
4. Recovery from persisted data reconstructs a coherent identifier lookup and node-state graph.

## Final recommendation

Adopt **Proposal A**. It provides the best balance: full locking-spec compliance, preserved volatile-persistent correctness, and manageable implementation complexity within the current architecture.
