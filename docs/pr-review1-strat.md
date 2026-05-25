# PR #1376 Review Feedback 1 — strategy

## Strategic objective

Introduce principled no-op transaction detection so that persistence and serialization are skipped when, and only when, there is provably no state delta.

## Principles

1. **Correctness first**: skipping must never hide real writes.
2. **Locality**: detection logic should live near commit orchestration, not scattered across callers.
3. **Single source of truth**: derive “changed vs unchanged” from the transaction/batch structures already used for commit.
4. **Observability via tests**: add explicit tests for no-op behavior.
5. **No API shortcuts**: preserve transaction model and mutex discipline.

## Strategy

### A) Define “no-op transaction” precisely

A transaction is no-op iff:

- its batch operation list is empty, and
- its identifier overlay contains zero newly allocated entries.

Only under this conjunction may commit persistence steps be skipped.

### B) Centralize decision in `withTransaction` commit path

At the end of transaction execution, compute two booleans:

- `hasPendingOperations`
- `hasPendingAllocations`

Then derive `hasPersistentDelta = hasPendingOperations || hasPendingAllocations`.

If false, return directly (no batch flush, no identifier serialization, no volatile merge).

### C) Preserve existing behavior for real deltas

If there is any persistent delta:

- include identifier-lookup write only when allocations exist,
- flush one atomic batch,
- publish overlay to base lookup only after successful flush.

### D) Verify with targeted + full checks

- Add/adjust tests to assert no extra batch flush on no-op pull paths.
- Run focused tests for volatile consistency behavior.
- Run full project checks required by repo workflow.

## Non-goals

- No redesign of recomputation heuristics.
- No speculative caching unrelated to transaction commit.
- No changes to external data format.
