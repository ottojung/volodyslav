# PR #1335 Review Feedback #1 — Implementation Plan

## 1) RootDatabase cutover fix

### File
- `backend/src/generators/incremental_graph/database/root_database.js`

### Changes
1. In `setCurrentReplicaPointer(name)`, after successful `_rootMetaSublevel.put(...)`:
   - set `this._cachedValueOfCurrentReplica = name`;
   - call `await this.initializeActiveIdentifierLookup()` to refresh active lookup cache.
2. Keep existing validation of `name` and existing error wrapping for persistence failures.
3. Update JSDoc comment for `setCurrentReplicaPointer` to clarify that it updates in-memory active routing state as part of the successful transition.

## 2) Regression tests for immediate in-process correctness

### File
- `backend/tests/database.test.js`

### New assertions
Add a focused test that:
1. Opens DB and confirms active replica is `x`.
2. Calls `setCurrentReplicaPointer('y')`.
3. Asserts **without reopening**:
   - `currentReplicaName()` is `y`.
   - `getSchemaStorage()` equals `schemaStorageForReplica('y')` and differs from x storage.

This directly proves cache freshness immediately after cutover.

## 3) Validation execution
Run project checks in required order for this repository context:
1. `npm install`
2. `npm test`
3. `npm run static-analysis`
4. `npm run build`

Then run any targeted test(s) as needed while iterating.

## 4) Commit and PR metadata
1. Commit with a message describing cache refresh after pointer writes.
2. Record a PR title/body via `make_pr` summarizing:
   - bug and impact,
   - fix in `setCurrentReplicaPointer`,
   - regression coverage and checks.
