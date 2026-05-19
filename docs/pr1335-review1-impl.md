# Detailed implementation plan for PR #1335 review feedback

## 1) Extend identifier lookup utilities

### File
- `backend/src/generators/incremental_graph/database/identifier_lookup.js`

### Changes
1. Add `mergeIdentifierLookups(base, overlay)` helper:
   - Clone `base` via existing clone helper.
   - Apply all mappings from `overlay` onto cloned base using `setIdentifierMapping`.
   - Return merged lookup.
2. Export the new helper.

### Notes
- No additional `NodeIdentifier` validation loops are introduced (explicitly intentional).

## 2) Use merge semantics in resolver persistence path

### File
- `backend/src/generators/incremental_graph/identifier_resolver.js`

### Changes
1. Import `mergeIdentifierLookups`.
2. In `queueLookupPersistence`:
   - Pull latest active lookup from `rootDatabase`.
   - Merge latest active + resolver snapshot.
   - Persist merged serialization (`IDENTIFIERS_KEY`).
   - Retain merged lookup for later commit publication.
3. In `commitPersistedLookup`:
   - Publish a clone of the merged persisted lookup (or resolver lookup fallback) into root database, not mutable reference.

### Interface updates
- `queueLookupPersistence` will receive `rootDatabase` so it can merge against latest active state.

## 3) Update call sites for new resolver interface

### File
- `backend/src/generators/incremental_graph/class.js`

### Changes
- In `withIdentifierBatch`, pass `this.rootDatabase` into resolver `queueLookupPersistence`.

## 4) Add tests for merge + clone behavior

### File
- `backend/tests/identifier_resolver.test.js` (new)

### Cases
1. **merge-write case**:
   - Root DB lookup starts with base mapping.
   - Resolver A allocates id A; Resolver B allocates id B from old base.
   - Each queues persistence in sequence; second write should include both A and B.
2. **clone-on-commit case**:
   - Commit resolver lookup.
   - Mutate resolver afterwards.
   - Root DB lookup must not reflect post-commit mutation.

## 5) Validation workflow

Run in order:
1. `npm install`
2. `npx jest backend/tests/identifier_resolver.test.js`
3. `npm test`
4. `npm run static-analysis`
5. `npm run build`

Fix failures until all pass.

## 6) Finalization

1. `git add` updated docs/code/tests.
2. `git commit` with concise message.
3. Use `make_pr` tool with title/body summarizing review fixes.
