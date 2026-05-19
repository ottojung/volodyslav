# PR #1335 Review Thread 1 — Detailed Implementation Plan

## Step 1 — Fix merge write persistence ordering
File: `backend/src/generators/incremental_graph/database/sync_merge.js`

- Locate `hasChanges` branch where merged identifier lookup is queued.
- Keep existing `pendingOps.push(T.global.putOp(...))` and `await flushPendingOps()`.
- Immediately add a residual flush guard:
  - `if (pendingOps.length > 0) await T.batch(pendingOps); pendingOps = [];`
- Ensure this happens before `unifyRevdeps(...)` and `setCurrentReplicaPointer(...)`.

## Step 2 — Fix deterministic retry handling
File: `backend/src/generators/incremental_graph/identifier_resolver.js`

- Update `allocateNodeIdentifier(... callback ...)` callback signature from `() =>` to `(attempt) =>`.
- In deterministic fallback branch, call `deterministicNodeIdentifierFromNodeKey(nodeKey, attempt)`.
- Preserve existing `rootDatabase.generateNodeIdentifier()` path unchanged.

## Step 3 — Enforce semantic-key usage in pull path
File: `backend/src/generators/incremental_graph/pull.js`

- Replace ambiguous local variable flow with a single resolved semantic key variable.
- Compute:
  - default to input identifier;
  - attempt `identifierResolver.requireNodeKey(input)`;
  - on lookup miss, retain input (compatibility path).
- Use resolved semantic key for:
  - `deserializeNodeKey` input,
  - `getOrCreateConcreteNode` first argument,
  - `withPullNodeMutex` key argument,
  - relevant error string interpolation.

## Step 4 — Validate
- Run focused incremental-graph test command(s).
- Run required full checks:
  - `npm test`
  - `npm run static-analysis`
  - `npm run build`

## Step 5 — Finalize
- Stage docs + code changes.
- Commit with message summarizing review1 fixes.
