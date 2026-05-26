# Managerial Overview: Concurrency and Locking Validation (PR #1335 HEAD)

## Scope
This document validates the concurrency/locking behavior on current PR #1335 HEAD against:
- `docs/specs/incremental-graph-locking-design.md`

## Executive summary
Current implementation is **partially aligned** with the locking design:

- ✅ `invalidate` and inspection operations run in observe mode and are compatible with each other.
- ✅ Pull operations run in pull mode and are excluded from observe operations.
- ✅ Exclusive maintenance operations are isolated with `withExclusiveMode`.
- ❌ Pull concurrency on different nodes is effectively reduced by transaction-level computed-state mutex serialization.
- ⚠️ Same-node pull serialization is currently achieved indirectly by global transaction serialization + in-transaction dedupe, not by explicit per-node pull mutex as required by spec.

Net result: correctness is conservative, but intended pull parallelism is not fully realized.

## Spec clauses and validation

### Clause A: `invalidate()` exclusive with any `pull()`, but not with other `invalidate()`
- **Observed**: `invalidate` uses `withObserveMode`; `pull` uses `withPullMode`.
- **Result**: **Pass**.

### Clause B: inspection reads concurrent with `invalidate()`
- **Observed**: both use observe mode.
- **Result**: **Pass**.

### Clause C: `pull()` exclusive with inspection reads
- **Observed**: pull mode conflicts with observe mode.
- **Result**: **Pass**.

### Clause D: same-node pulls serialize
- **Observed**: serialization happens due to broad transaction mutex + per-transaction inFlight dedupe.
- **Spec expectation**: explicit `withMutex(PULL_NODE_KEY(nodeId))`.
- **Result**: **Partially pass** (behavior yes, mechanism no).

### Clause E: different-node pulls should not block each other
- **Observed**: current computed-state mutex around transaction serializes all concurrent top-level pull transactions.
- **Result**: **Fail**.

### Deadlock discipline
- **Observed**: current hierarchy largely avoids cycles; however, required discipline (graph activity mode lock then per-node pull mutex) is not fully encoded because per-node pull mutex is absent.
- **Result**: **Partial**.

## Why this matters
- Current implementation prioritizes allocation consistency by serializing transaction bodies.
- This trades away intended throughput and is mismatched with the lock design objective of parallel pulls on disjoint nodes.

## Recommended direction
1. Introduce explicit per-node pull mutexes keyed by node identifier.
2. Narrow identifier-allocation critical section so allocation safety remains guaranteed without serializing entire pull execution.
3. Keep mode-lock phase semantics unchanged (observe vs pull) because they match the spec’s phase model.

## Conclusion
The current HEAD is safe but over-serialized. It satisfies phase exclusion semantics, but not the intended fine-grained pull parallelism contract of the incremental graph locking design.
