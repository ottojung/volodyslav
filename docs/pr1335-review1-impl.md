# Detailed implementation plan for PR #1335 review feedback (round 1)

## 1) `synchronize_reset_snapshot.js`
- Update `importResetSnapshotIntoDatabase(...)`:
  1. Read `previousReplica = database.currentReplicaName()` before `setCurrentReplicaPointer(...)`.
  2. Perform pointer switch.
  3. Return `previousReplica !== nextReplica`.
- Keep behavior for empty snapshot directory unchanged.

## 2) `identifier_resolver.js` concurrency-safe merge semantics

### 2.1 Track allocation delta
- Add map/set structures to record mappings allocated during this resolver operation.
- Only new allocations should be part of delta; pre-existing mappings are excluded.

### 2.2 Merge against latest active lookup when queueing persistence
- In `queueLookupPersistence(...)`:
  1. If no pending allocation or no global DB, return.
  2. Get latest active lookup from root database (`getActiveLookup` clone).
  3. Apply allocation delta mappings into that latest clone using lookup helper that enforces bijection.
  4. Serialize merged clone and append single `rawPutOp(IDENTIFIERS_KEY, ...)`.
  5. Save merged clone as committed snapshot for later `commitPersistedLookup(...)`.

### 2.3 Rebase resolver-local view
- After computing merged lookup, update resolver-local `lookup` reference to merged clone so recursive usage in same operation sees committed union state.

### 2.4 Defensive commit publication
- In `commitPersistedLookup(...)`, publish clone of committed snapshot into RootDatabase.
- Never publish mutable reference.

## 3) `types.js` explicit no-validation comment for NodeIdentifier conversion
- Add short comment near `castToNodeIdentifier` / `stringToNodeIdentifier` stating:
  - No runtime format validation is intentionally performed on this hot internal path.
  - Validation is omitted by design to avoid wasted compute.

## 4) Tests
- Locate relevant tests for identifier resolver / incremental graph persistence.
- Add or update tests to cover:
  1. Merge behavior under simulated concurrent allocations from stale snapshots.
  2. RootDatabase commit uses clone semantics (later local mutations do not alter root cache unexpectedly).
  3. Reset snapshot switching return value correctness.

## 5) Validation sequence
1. `npm install`
2. Focused tests (targeted jest files).
3. `npm test`
4. `npm run static-analysis`
5. `npm run build`
6. If failures appear, iterate until green.
