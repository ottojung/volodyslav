# PR #1335 Review Thread 1 — Remediation Strategy

## Guiding principles

1. **Durability before phase transitions**
   Any global-lookup mutation must be durably written before revdep rewrite and replica pointer mutation.

2. **Contract fidelity**
   If an API provides retry-attempt state (`attempt`), pass it through exactly where deterministic fallback logic depends on it.

3. **Single normalization point**
   Pull entrypoints receiving “identifier-or-key” should normalize once and then use the normalized semantic form consistently in cache and synchronization paths.

4. **Minimal blast radius**
   Keep changes local to commented paths; avoid incidental refactors while preserving behavior elsewhere.

## Strategic changes

### A) Sync merge durability fix
- Replace buffered pending-op usage for `identifiers_keys_map` with an explicit immediate `T.batch([putOp])` write.
- This removes chunk-threshold dependence for this critical singleton write.

### B) Allocation retry propagation fix
- Update callback signature to `(attempt) => ...`.
- Pass `attempt` to deterministic fallback derivation.
- Keep random generator path behavior unchanged.

### C) Pull key/identifier consistency fix
- Continue tolerant resolution (`try requireNodeKey` else fallback).
- After resolution, use normalized value for:
  - concrete-node cache key,
  - pull mutex key,
  - related invariant error message context.

## Verification strategy

1. Run focused tests touching modified units (`identifier_resolver`, `sync_merge`).
2. Run full test suite.
3. Run static analysis.
4. Run build.
5. If failures occur, iterate only with principled fixes (no disabling tests/lints, no bypass shortcuts).
