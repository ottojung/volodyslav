# Implementation plan for review feedback

## Scope

Primary code target:

- `backend/src/generators/incremental_graph/database/root_database.js`

Primary test target:

- `backend/tests/database.test.js`

## Step-by-step plan

1. **Patch `setCurrentReplicaPointer(name)` in RootDatabase**
   - Keep replica-name validation as-is.
   - Keep persisted write to `_rootMetaSublevel.put('current_replica', name)`.
   - After successful write:
     - assign `this._cachedValueOfCurrentReplica = name`;
     - call `await this.initializeActiveIdentifierLookup()` to sync active lookup cache.
   - Preserve existing error behavior: persistence failure continues to throw `SwitchReplicaError`.

2. **Add regression test for same-instance visibility**
   In `database.test.js`, add a test that:
   - opens db,
   - captures pre-switch active storage,
   - calls `setCurrentReplicaPointer('y')`,
   - asserts `currentReplicaName()` is `'y'` immediately,
   - asserts `getSchemaStorage()` now resolves to y storage (not equal to pre-switch x storage),
   - optionally confirms `schemaStorageForReplica('y')` is identical to active storage.

3. **Run focused tests first**
   - Run `npx jest backend/tests/database.test.js`.

4. **Run required full validation workflow**
   - `npm test`
   - `npm run static-analysis`
   - `npm run build`

5. **If failures occur, iterate**
   - Diagnose first failing check.
   - Make minimal principled fixes.
   - Re-run checks until all pass.

## Expected outcome

After change, `setCurrentReplicaPointer()` will be safe for in-process cutover flows: active-replica readers and lookup-dependent paths will immediately observe the switched replica, including migration checkpoint rendering paths.
