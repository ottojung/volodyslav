# PR #1335 Review Thread 1 — Detailed Implementation Plan

## Step 1: Fix merge durability for identifier lookup persistence

### File
`backend/src/generators/incremental_graph/database/sync_merge.js`

### Change
- In `hasChanges` branch, after computing `mergedLookup`, replace:
  - `pendingOps.push(T.global.putOp(...))` + `flushPendingOps()`
- with:
  - `await T.global.put(...)`

### Expected effect
- Guarantees `identifiers_keys_map` persistence immediately and unconditionally before `unifyRevdeps()` and `setCurrentReplicaPointer()`.

## Step 2: Fix allocation retry callback plumbing

### File
`backend/src/generators/incremental_graph/identifier_resolver.js`

### Change
- Update allocator callback from `() =>` to `(attempt) =>`.
- Route fallback generation through `deterministicNodeIdentifierFromNodeKey(nodeKey, attempt)`.

### Expected effect
- Retry attempts produce distinct deterministic candidates under collisions.

## Step 3: Normalize semantic key usage in pull flow

### File
`backend/src/generators/incremental_graph/pull.js`

### Change
- In `internalPullByNodeIdentifierWithStatusDuringPull(...)`, after resolution:
  - use resolved `nodeKeyIdentifier` when calling `getOrCreateConcreteNode(...)`.
  - use resolved `nodeKeyIdentifier` for `withPullNodeMutex(...)` key.
  - use resolved `nodeKeyIdentifier` in invariant error message for missing cached value.

### Expected effect
- Avoids treating persisted identifier as semantic key in concrete-node and mutex paths.

## Step 4: Execute validation workflow

Run in order:
1. `npm install`
2. Focused tests:
   - `npx jest backend/tests/identifier_resolver.test.js`
   - `npx jest backend/tests/sync_merge.test.js`
3. Full validation:
   - `npm test`
   - `npm run static-analysis`
   - `npm run build`

## Step 5: Commit and PR metadata

- Commit all document + code updates with a message describing review-thread fixes.
- Create PR message via `make_pr` summarizing defects addressed and validation evidence.
