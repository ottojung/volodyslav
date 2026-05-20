# Detailed Implementation Plan for PR #1335 Review1

## 1) Sync merge collision reconciliation

### Files
- `backend/src/generators/incremental_graph/database/sync_merge.js`

### Steps
1. Introduce a helper in module scope (or near merge logic):
   - Input: `targetLookup`, `hostLookup`
   - Behavior:
     - clone host lookup
     - iterate target `keyToId` entries
     - if host also has same key with different id, delete host old mapping for that key and set mapping to target id
   - Return normalized host lookup.

2. In `mergeHostIntoReplica`, after parsing both lookup snapshots:
   - call helper to normalize host lookup against target.
   - pass normalized host lookup to `mergeIdentifierLookups`.

3. Keep strict merge logic unchanged in `identifier_lookup.js`.

### Expected effect
- No exception for legitimate `K->idA` vs `K->idB` case.
- Merge succeeds and target mapping remains stable.

## 2) Legacy migration map persistence completeness

### Files
- `backend/src/generators/incremental_graph/migration_runner.js`

### Steps
1. In `makeMigrationKeyPlan` legacy branch (`persistedEntries` absent):
   - create mutable `legacyLookup` via `makeIdentifierLookup` from initial materialized mappings.
   - keep existing `decisionKeyByOutputKey` population.

2. Change `keyToOutputKey(nodeKey)` implementation to:
   - canonicalize semantic key
   - allocate/reuse identifier via `allocateNodeIdentifier(legacyLookup, canonicalKey, ...)`
   - update `decisionKeyByOutputKey`
   - return output identifier

3. Change returned `outputEntries` from static array to getter:
   - `get outputEntries() { return serializeIdentifierLookup(legacyLookup); }`

### Expected effect
- Any nodes introduced during migration execution are guaranteed persisted in final map.

## 3) Tests

### Files (likely)
- `backend/tests/sync_merge.test.js`
- `backend/tests/migration_runner.test.js`

### Steps
1. Add regression test for sync identifier collision reconciliation.
2. Add regression test for legacy migration node creation mapping persistence.
3. Run targeted tests.

## 4) Validation sequence
1. `npx jest backend/tests/sync_merge.test.js`
2. `npx jest backend/tests/migration_runner.test.js`
3. `npm test`
4. `npm run static-analysis`
5. `npm run build`

