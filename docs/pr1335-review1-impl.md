# Detailed implementation plan for PR #1335 review set 1

## 1) Sync reconciliation implementation
### File
`backend/src/generators/incremental_graph/database/sync_merge.js`

### Steps
1. Import lookup helpers needed for controlled rewrites:
   - `nodeKeyToIdFromLookup`
   - `deleteIdentifierMappingForNodeKey`
   - `setIdentifierMapping`
2. Add helper `reconcileHostLookupToTarget(targetLookup, hostLookup)`:
   - Clone host lookup.
   - Iterate semantic keys present in target.
   - If same semantic key exists in host under different identifier, remove host mapping and set mapping to target identifier.
3. At merge point:
   - Build `reconciledHostLookup`.
   - Call `mergeIdentifierLookups(targetLookup, reconciledHostLookup)`.

### Expected behavior
- No `IdentifierLookupError` for benign same-key identifier divergence.
- Merged lookup preserves target identifiers for overlapping semantic keys.

## 2) Legacy migration mapping persistence implementation
### File
`backend/src/generators/incremental_graph/migration_runner.js`

### Steps
1. In legacy branch (no persisted `identifiers_keys_map`), initialize mutable `lookup = makeEmptyIdentifierLookup()`.
2. Seed lookup with deterministic mappings for preexisting materialized nodes.
3. Update `keyToOutputKey` to allocate through `allocateNodeIdentifier(lookup, canonicalKey, deterministic...)`.
4. Keep `decisionKeyByOutputKey` updated for all allocations.
5. Replace static `outputEntries` array with getter returning `serializeIdentifierLookup(lookup)`.

### Expected behavior
- Any node touched/created during migration and assigned an output identifier has a persisted mapping.

## 3) Tests
### Sync regression test
- Add test in `backend/tests/sync_merge.test.js`:
  - Local and host both contain same semantic node key.
  - Each has distinct identifier mapping.
  - Merge should succeed and persisted `identifiers_keys_map` should converge to target identifier mapping.

### Migration regression test
- Add test in `backend/tests/migration_runner.test.js`:
  - Legacy source without identifier map.
  - Migration callback creates new node via `storage.create(...)`.
  - Output `identifiers_keys_map` includes both original and newly created semantic keys.

## 4) Validation commands
1. `npm install`
2. Focused tests:
   - `npx jest backend/tests/sync_merge.test.js`
   - `npx jest backend/tests/migration_runner.test.js`
3. Full checks:
   - `npm test`
   - `npm run static-analysis`
   - `npm run build`
