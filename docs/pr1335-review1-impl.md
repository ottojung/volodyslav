# Detailed implementation plan for PR #1335 review feedback #1

## 1) Code changes

### File
`backend/src/generators/incremental_graph/database/reconcile_identifier_lookup.js`

### Planned edits
1. Keep cloning behavior intact (`makeIdentifierLookup(serializeIdentifierLookup(hostLookup))`).
2. Iterate `targetLookup.keyToId.entries()` as before.
3. On conflict (`hostIdentifier !== undefined && hostIdentifier !== targetIdentifier`):
   - Read host node key via reconciled host `idToKey` map keyed by host identifier string.
   - If host key exists, remove stale mapping with `deleteIdentifierMappingForNodeKey`.
   - Read target node key via target lookup `idToKey` keyed by target identifier string.
   - If target key exists, call `setIdentifierMapping(reconciledHostLookup, targetIdentifier, targetNodeKey)`.
4. Remove semantic-key-string parsing through `nodeIdentifierFromString`.
5. Update imports accordingly.

## 2) Regression test additions

### New file
`backend/tests/reconcile_identifier_lookup.test.js`

### Test cases
1. **Primary regression case**
   - Build host lookup with identifier A -> semantic key K.
   - Build target lookup with identifier B -> same semantic key K.
   - Ensure K string is not a 9-letter identifier-like token.
   - Reconcile and assert:
     - no throw;
     - resulting `keyToId[K]` is identifier B;
     - stale identifier A mapping removed.

2. **Sanity case: unchanged mapping**
   - Host and target share mapping for K.
   - Reconcile leaves mapping unchanged.

## 3) Validation commands
1. `npm install`
2. `npx jest backend/tests/reconcile_identifier_lookup.test.js`
3. `npm test`
4. `npm run static-analysis`
5. `npm run build`

## 4) Completion criteria
- Reconciliation handles divergent identifier allocations for same semantic key without identifier parse errors.
- New regression tests pass and protect against regression.
- Full test/static-analysis/build checks pass.
