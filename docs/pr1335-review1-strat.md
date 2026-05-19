# Strategy to address PR #1335 review feedback

## Principles

1. **Durability-aligned state transitions**: in-memory active lookup should only advance to states that correspond to committed data.
2. **Monotonic merge semantics**: concurrent operations that allocate disjoint identifiers must compose rather than overwrite.
3. **Bijection invariants preserved**: any merge must reject conflicts (`id->key` mismatch or `key->id` mismatch).
4. **No redundant identifier validation**: avoid extra per-entry `NodeIdentifier` re-validation that burns compute without adding meaningful safety.

## Strategy outline

### A) Persist merged lookup snapshots, not blind per-resolver snapshots

Before appending the lookup write operation:

- Get the latest active lookup snapshot from `RootDatabase`.
- Merge resolver lookup changes onto that latest snapshot using bijection-safe merge logic.
- Persist the merged serialization.

This changes semantics from “overwrite with local snapshot” to “commit union of known committed state + local additions”.

### B) Commit defensive clones into RootDatabase

When publishing committed lookup back into RootDatabase:

- Pass/assign a clone, not resolver-owned mutable object references.
- Reset pending-write flags only after successful publish path.

This isolates future resolver mutations from previously committed in-memory state.

### C) Keep merge policy strict and explicit

Implement an explicit merge helper in `identifier_lookup`:

- Iterate overlay pairs.
- Reuse `setIdentifierMapping` so conflict checks remain centralized.
- Return a new lookup object.

This keeps invariant enforcement local and auditable.

### D) Add focused tests for regression-proofing

Cover:

1. Two resolver snapshots from same base with disjoint allocations -> merged persistence contains both.
2. Commit path stores clone semantics (post-commit resolver mutation does not mutate active DB lookup).

## Why no NodeIdentifier validation here

Per request, we avoid adding additional validation passes for every lookup merge/serialize path. Identifier construction/typing already validates at creation boundaries; re-validating every map entry in hot persistence paths adds cost and complexity with limited additional protection.
