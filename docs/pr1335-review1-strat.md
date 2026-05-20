# Strategy to address PR #1335 review feedback (review set 1)

## Principles
1. Preserve convergence under benign concurrent materialization.
2. Preserve strict bijection invariants at persistence boundaries.
3. Ensure migration output is self-contained and replay-stable.
4. Avoid introducing ad-hoc exceptions to core lookup merge rules.

## Strategy for sync collision handling
- Keep `mergeIdentifierLookups` strict and invariant-focused.
- At the sync call site, pre-reconcile host lookup against target lookup by semantic key:
  - For each semantic key already known in target, if host maps same key to a different identifier, rewrite host mapping to target identifier.
- Then run strict merge on reconciled host map.

This confines policy (“target identifier wins for already-known semantic key”) to sync orchestration, not generic lookup primitives.

## Strategy for legacy migration mapping persistence
- Replace legacy fixed-array output entry accumulation with a mutable in-memory lookup object.
- Route all `keyToOutputKey` allocations through `allocateNodeIdentifier` against that mutable lookup.
- Expose `outputEntries` as a computed serialization of current lookup state (getter), so any migration-created node mapping is included automatically.

## Validation strategy
- Add regression tests for both cases:
  - Sync succeeds and converges when host/target use different identifiers for same semantic key.
  - Legacy migration persists mappings for nodes created during callback.
- Run focused tests first, then full project checks.
