# Strategy to address Review #1 feedback for PR #1335

## Guiding principles
1. **Invariant first, optimization second.**
2. **Make illegal states unrepresentable at API boundaries.**
3. **Centralize side-effectful lookup mutations.**
4. **Fail loudly with precise errors when identity mapping is missing/ambiguous.**
5. **Test the behavioral contracts, not just happy paths.**

## Target outcome
A system where a maintainer can quickly answer:
- “Is this value a semantic key or a persisted identifier?”
- “Where do mappings get committed?”
- “What guarantees hold after transaction success/failure?”

## Strategic workstreams

### A) Clarify types and naming semantics
- Reserve `NodeIdentifier` for persisted opaque IDs only.
- Use explicit semantic key types (`NodeKeyString`) in runtime graph construction and parsing.
- Eliminate APIs that silently coerce raw strings between the two domains.

### B) Consolidate lookup mutation authority
- Route all lookup changes through invariant-checking helpers.
- Ensure no call site can overwrite full map snapshots without merge/reconcile policy.
- Keep transactional overlay + commit flow as the only mutation channel.

### C) Strengthen cutover atomicity model
- Ensure replica pointer changes happen only after all required writes flush.
- Keep in-memory cached replica state synchronized with persisted pointer updates.
- Preserve deterministic recovery semantics after crash/restart.

### D) Harden migration/sync completeness guarantees
- Any newly created or merged node with persisted state must also produce durable identifier mapping.
- Reconciliation policy for host/target collisions must be explicit and deterministic.

### E) Improve observability and docs
- Document invariant checklist near critical modules.
- Tighten error payload names for debug clarity (e.g., `nodeIdentifier` vs `nodeKey`).
- Add a maintainer-oriented troubleshooting section.

## Non-goals for this cycle
- Broad performance redesign.
- External storage format breakage.
- Ad hoc compatibility hacks that hide invariant violations.
