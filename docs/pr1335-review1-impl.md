# Detailed implementation plan for Review 1

## 1) Refactor RootDatabase lookup loading API

### Current
- `initializeActiveIdentifierLookup()` reads lookup from whichever replica is currently cached active.

### Change
- Add a new helper:
  - `loadIdentifierLookupForReplica(name)`
  - Selects explicit global sublevel (`x` or `y`) and returns lookup.
- Re-implement `initializeActiveIdentifierLookup()` in terms of `loadIdentifierLookupForReplica(currentReplicaName())`.

### Rationale
This separates explicit target loading from active-state mutation, enabling safe staged cutover.

## 2) Make setCurrentReplicaPointer staged and atomic at method boundary

### Current (unsafe order)
1. write pointer
2. set cached replica
3. initialize active lookup

### New order
1. validate name
2. pre-load target lookup via `loadIdentifierLookupForReplica(name)`
3. write pointer
4. update cached replica
5. set `_identifierLookup` to preloaded lookup

### Guarantees
- If step 2 fails: no durable pointer change.
- If step 3 fails: no in-memory change.
- Steps 4/5 are in-process assignments after durable commit.

## 3) Extend tests for failure atomicity

Add a test in `backend/tests/database.test.js`:
- Seed database with invalid `y/global/identifiers_keys_map` shape.
- Confirm active replica starts at `x`.
- Call `setCurrentReplicaPointer('y')` and assert rejection with `SwitchReplicaError`.
- Reopen DB and verify `_meta/current_replica` is still `x`.

This directly asserts the review’s failure scenario is prevented.

## 4) Validation execution plan

1. `npm install`
2. Targeted: `npx jest backend/tests/database.test.js`
3. Full: `npm test`
4. `npm run static-analysis`
5. `npm run build`

Fix any failures and repeat until all pass.

## 5) Delivery

- Commit code + docs updates.
- Create PR message via `make_pr` summarizing atomic switch fix, tests, and docs.
