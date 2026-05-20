# Strategy to address PR #1335 review feedback #1

## Guiding principles

1. **Preserve representation boundaries**
   - Semantic node key strings must stay semantic.
   - Opaque node identifiers must only be parsed/validated via identifier APIs.

2. **Reconcile via canonical in-memory values**
   - During lookup reconciliation, reuse node-key objects already present in lookup maps.
   - Avoid lossy or invalid string reinterpretation.

3. **Enforce behavior with regression tests**
   - Add tests that model independent identifier allocation for equal semantic keys.
   - Ensure no `InvalidNodeIdentifierError` path is reachable from this scenario.

4. **Keep bijection invariants explicit**
   - Any reassignment must first remove conflicting host mappings, then set target mapping.
   - Maintain one-to-one relation in both `keyToId` and `idToKey`.

## Strategic approach

### A) Refactor reconciliation flow
- In `reconcileHostLookupWithTargetLookup`, when a conflict is found:
  - Resolve host's existing node key through `idToKey` and remove it safely.
  - Resolve target node key from target lookup's canonical mapping, and reuse that value directly.
  - Set mapping with `setIdentifierMapping` using the canonical target node key.

### B) Remove invalid parsing dependency
- Eliminate the `nodeIdentifierFromString(nodeKeyString)` usage from this path.
- Keep identifier parsing only where actual identifier strings are handled.

### C) Add focused regression tests
- Construct lookups where semantic-key strings are non-identifier-like.
- Include different host/target identifiers for same semantic node key.
- Assert reconciliation completes and selects target identifier without throwing.

### D) Run full validation loop
- Run targeted Jest for new test file.
- Run full `npm test`.
- Run `npm run static-analysis`.
- Run `npm run build`.

If any validation fails, iterate implementation until all pass.
