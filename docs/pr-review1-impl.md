# PR #1376 Review Feedback 1 — implementation plan

## Step 1 — Audit commit path

- Inspect `backend/src/generators/incremental_graph/graph_state.js` transaction commit flow.
- Identify existing conditions around identifier serialization and batch flushing.

## Step 2 — Introduce explicit delta detection

In `withTransaction`:

1. Compute `hasPendingOperations = operations.length > 0`.
2. Compute `hasPendingAllocations = tx.identifierLookup.keyToId.size > 0`.
3. Compute `hasPersistentDelta = hasPendingOperations || hasPendingAllocations`.

Behavior:

- If `hasPersistentDelta` is false: return value immediately; skip `batch(...)`, skip serialization, skip lookup merge.
- If true:
  - append identifier put-op only when `hasPendingAllocations` is true,
  - run `batch(operations)` once,
  - run `commitTransactionLookup` only when `hasPendingAllocations` is true.

## Step 3 — Add regression test for no-op commit skip

In `backend/tests/incremental_graph_volatile_consistency.test.js`:

- Build a graph with a deterministic stable node.
- First pull materializes it.
- Instrument schema storage `batch` call count.
- Second pull of the same node should be a no-op.
- Assert no additional batch call was made by second pull.

## Step 4 — Execute required checks

Run in order:

1. `npm install`
2. `npx jest backend/tests/incremental_graph_volatile_consistency.test.js`
3. `npm test`
4. `npm run static-analysis`
5. `npm run build`

If any check fails, fix and re-run until all pass.
