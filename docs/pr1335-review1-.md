# PR #1335 review thread analysis (review id 4321392820)

## Context

The review feedback identifies two concurrency/correctness issues in identifier lookup persistence for parallel pull mode.

## Problem 1 (P1): lookup persistence overwrites from stale snapshot

### Symptom

Each resolver persists the whole `identifiers_keys_map` from its own per-operation snapshot. In parallel pulls:

- Resolver A snapshot: `S0` -> allocates `a1`
- Resolver B snapshot: `S0` -> allocates `b1`
- A writes `S0 + {a1}`
- B later writes `S0 + {b1}`

B overwrites A’s committed mapping. A node record may still exist in value/freshness/inputs tables keyed by `a1`, but the semantic-key lookup can no longer reach `a1`.

### Impact

- Lost key↔identifier mappings.
- Persisted node records can become semantically unreachable.
- Parallel pulls violate lookup durability guarantees.

## Problem 2 (P2): mutable reference stored in RootDatabase cache

### Symptom

After persistence, `RootDatabase` is updated with resolver-owned mutable lookup by reference.

If the same resolver object is reused recursively or across subsequent allocations:

- In-memory lookup mutates ahead of durable batch success.
- If a later batch fails, memory may contain mappings not in persisted `identifiers_keys_map`.

### Impact

- In-memory/persisted divergence.
- Future lookups can observe mappings that were never committed.
- Hard-to-debug state skew after failures.

## Constraint from user direction

Do **not** add additional `NodeIdentifier` validation in this change.

Rationale explicitly required in this branch: validating every identifier at this layer is a compute tax with negligible correctness gain, because identifiers are already produced and validated by existing typed/factory paths; repeated validation here would be redundant and wasteful.
