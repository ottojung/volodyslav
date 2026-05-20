# Strategy to Address PR #1335 Review1 Feedback

## Principles
1. **Convergence over allocation provenance**
   - Semantic-node identity is canonical; identifier choice must converge even when allocated independently.

2. **Lookup map is authoritative metadata**
   - Any persisted identifier-keyed record must have a persisted key↔id mapping in the same logical outcome.

3. **Preserve strict local invariants while adding explicit reconciliation boundaries**
   - Keep `mergeIdentifierLookups` strict.
   - Resolve known cross-replica legitimate conflicts *before* calling strict merge.

4. **Determinism and inspectability**
   - Reconciliation policy must be deterministic and documented.
   - Migration key plan must remain deterministic and serializable.

## Strategy for Problem 1 (sync collision)

### Reconciliation policy
At the sync call site, before `mergeIdentifierLookups`:
- For every semantic key present in both target and host maps with differing identifiers:
  - canonicalize to target’s identifier for that key.
  - rewrite host-side in-memory lookup assignment for that key to target identifier.

This makes host overlay compatible with target base, preserving target-local persisted identity and preventing merge aborts on legitimate concurrent allocation.

### Why this policy
- Target is the merge destination, so its persisted records already reference its identifiers.
- Choosing target identifier avoids requiring broad rewrite of target graph-state keys in this merge phase.

## Strategy for Problem 2 (migration map persistence)

### Live key-plan accumulation
In legacy migration mode:
- Replace fixed `outputEntries` snapshot semantics with a mutable lookup structure.
- Ensure `keyToOutputKey(...)` always allocates/inserts into that mutable lookup.
- Expose `outputEntries` via getter serialization from current lookup state.

This guarantees nodes introduced at any point during migration are persisted in `identifiers_keys_map`.

## Verification strategy
1. Add/extend focused tests for:
   - sync merge with same semantic key, different IDs across replicas, expecting success and converged map.
   - legacy migration path where callback creates new node and final map includes new mapping.
2. Run focused tests first.
3. Run full suite + static analysis + build.

