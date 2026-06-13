# Flag-Based Inverse Validity Algorithm

## Purpose

The incremental graph stores materialized node values. A node may depend on other nodes, and its
computor may either produce a new value or report that the current materialized value is unchanged.

The graph needs a way to decide whether a potentially-outdated node can safely reuse its current
materialized value. This specification uses an inverse edge-validity relation: a separate validity
relation records which dependency edges are valid for the current materialized values of both
endpoints.

## Fixed Model

The schema is fixed for the lifetime of one `IncrementalGraph` instance. A node's concrete input
list is determined by the node definition, its bindings, and the compilation/instantiation logic.

The computor does **not** discover dependencies at runtime. It receives already-pulled input values.
It does not receive a dependency-registration API, and it does not return a dependency list.

Only successful `pull` / recompute operations may write `values[N]`. There is no direct value
replacement operation in this algorithm.

## State

```
values    : Map<NodeIdentifier, Value>
counters  : Map<NodeIdentifier, RecomputeCounter>
freshness : Map<NodeIdentifier, "up-to-date" | "potentially-outdated">
inputs    : Map<NodeIdentifier, Array<NodeIdentifier>>
revdeps   : Map<NodeIdentifier, Set<NodeIdentifier>>
valid     : Map<NodeIdentifier, Set<NodeIdentifier>>
```

- `values` — current materialized values.
- `counters` — monotonic recompute counters incremented on value change. Not used for cache
  validation.
- `freshness` — fast-path guard: an up-to-date node may be returned immediately. The invariant
  `freshness[N] = "up-to-date"` implies `N` has a materialized value.
- `inputs` — persisted normalized structural dependency-edge list for a materialized node.
- `revdeps` — reverse dependency index: `revdeps[D]` contains every `N` such that `D in inputs[N]`.
- `valid` — inverse validity flags: `valid[D].has(N)` means "the current value of `N` has been
  validated with respect to the current value of `D`".

## Input Terminology

There are two related but distinct concepts:

**inputPositions(N)** — the ordered concrete input positions derived from the node definition and
bindings. Duplicates are preserved. This list drives recursive pulls and the argument array passed
to the computor.

Example: `inputPositions(N) = [A, A, B]` means the computor receives `[value(A), value(A), value(B)]`.

**inputEdges(N)** — the normalized structural dependency-edge list. Duplicate input positions
collapse to one edge, preserving first occurrence for deterministic storage. This list drives
`inputs[N]`, `revdeps`, and `valid`.

Example: `inputPositions(N) = [A, A, B]` → `inputEdges(N) = [A, B]`.

`inputs[N]` stores `inputEdges(N)` for a materialized node. `inputPositions(N)` is not persisted as
`inputs[N]` unless an implementation chooses to store it separately under a different name.

## Invariants

For every materialized node `N` and every `D` in `inputs[N]`:

```
D in inputs[N]  iff  N in revdeps[D]
valid[D].has(N) implies revdeps[D].has(N)
```

A validity flag only has meaning for an existing dependency edge.

The algorithm may safely omit valid flags. A missing flag may cause extra computation but must not
cause an incorrect cache hit. A present flag must never be stale.

## Pull Algorithm

```
pull(N):

1. If freshness[N] is "up-to-date":
       require N has a materialized value
       return values[N]

2. Let inputPositions = schema-derived concrete input positions of N.
   Duplicates are preserved.

3. For every input position P in inputPositions:
       pull(P)
       collect values[P] for the computor argument array

4. Let inputEdges = normalize inputPositions as dependency edges.
   Duplicates collapse, preserving first occurrence.

5. If N has a materialized value,
   inputEdges is non-empty,
   and for every D in inputEdges: valid[D].has(N):

       freshness[N] = "up-to-date"
       return values[N]

6. Run N's computor with the values collected from inputPositions.

7. If the computor returns Unchanged:
       handleUnchanged(N, inputEdges)

8. If the computor returns newValue:
       handleChanged(N, inputEdges, newValue)

9. Return values[N]
```

Dependency pulls happen before the cache predicate. The cache predicate uses `inputEdges`, not
`inputPositions`.

A computor must not return `Unchanged` when `N` has no materialized value.

### Cache predicate

A potentially-outdated node `N` may reuse its materialized value iff:

1. `N` has a materialized value,
2. `inputEdges(N)` is non-empty,
3. for every `D` in `inputEdges(N)`: `valid[D].has(N)`.

Condition 2 excludes zero-input nodes. A zero-input node has no dependencies to validate against,
so the predicate cannot pass and the node must run its computor unless the graph defines a separate
explicit rule for that node kind.

## Handling `Unchanged`

When the computor returns `Unchanged`, the materialized value of `N` did not change.

```
handleUnchanged(N, inputEdges):

require N has a materialized value

inputs[N] = inputEdges
for every D in inputEdges:
    revdeps[D].add(N)
    valid[D].add(N)

freshness[N] = "up-to-date"
```

- `values[N]` is unchanged.
- `counters[N]` is unchanged.
- `valid[N]` is not cleared.
- Validity facts from `N` to its dependents remain valid.

## Handling Changed Value

When the computor returns a new value, all validity flags involving the old value of `N` must be
removed before new validity facts are recorded.

```
handleChanged(N, inputEdges, newValue):

for every D in inputEdges:
    valid[D].delete(N)

clear valid[N]

values[N] = newValue
counters[N] += 1

inputs[N] = inputEdges
for every D in inputEdges:
    revdeps[D].add(N)
    valid[D].add(N)

freshness[N] = "up-to-date"
propagate potentially-outdated freshness through revdeps[N]
```

Deleting `N` from each `valid[D]` removes claims that the old value of `N` was valid with respect
to its dependencies. Clearing `valid[N]` removes claims that dependents were valid with respect to
the old value of `N`. The propagation step is required because dependents of `N` may no longer be
valid.

## Freshness Invalidation

### Value-change propagation

When a node `N` changes value, its dependents are marked potentially-outdated:

```
propagateOutdated(N):

for every M in revdeps[N]:
    if freshness[M] is "up-to-date":
        freshness[M] = "potentially-outdated"
        propagateOutdated(M)
    otherwise:
        do not rewrite freshness[M]
        do not continue through M
```

Validity flags are not used during eager freshness propagation. They are used only when a
potentially-outdated node is pulled (cache predicate check).

### `invalidate(N)` — public invalidation

Public `invalidate(N)` forces `N` to recompute on the next pull. It removes incoming validity
flags so the cache predicate cannot pass for `N`, but preserves `valid[N]` so dependents may
still benefit from a future `Unchanged` result.

```
invalidate(N):

freshness[N] = "potentially-outdated"
for every D in inputs[N]:
    valid[D].delete(N)
propagate potentially-outdated freshness through revdeps[N]
do not clear valid[N]
```

- Removing `N` from each dependency's validity set forces `N` to recompute on the next
  `pull(N)`, because the cache predicate will fail.
- Preserving `valid[N]` is intentional: dependents may still cache-hit if `N` later
  recomputes and returns `Unchanged`.
- If `N` recomputes and changes value, the changed-value rule clears `valid[N]` and
  propagates freshness, forcing dependents to validate or recompute.
- If `N` recomputes and returns `Unchanged`, `valid[N]` remains valid, so dependents may
  avoid recomputation.

Key rule:

```
invalidate(N) forces recomputation of N.
A changed value invalidates dependents.
An unchanged recomputation preserves dependent validity.
```

## Transactional Semantics

All mutations to `valid`, `values`, `counters`, `freshness`, `inputs`, and `revdeps` caused by
recomputing `N` must be committed only after the computor successfully returns a valid result.

If the computor throws or returns an invalid value:

- do not write `values[N]`,
- do not increment `counters[N]`,
- do not add validity flags,
- do not mark `freshness[N]` as up-to-date,
- do not partially mutate structural metadata for `N`.

Dependency pulls may already have committed independently according to the existing transaction
model. That is acceptable, but `N`'s own recomputation effects must not be partially committed.

Persisted structural records for `N` are created or refreshed only after `N` is successfully
materialized or successfully validated. On a cache hit, do not rewrite structural records merely
to refresh validity.

## Persistence Requirements

- `valid[D]` serializes as a set in canonical sorted order.
- `revdeps[D]` serializes as a set in canonical sorted order.
- `inputs[N]` serializes as the normalized dependency-edge list in deterministic first-occurrence
  order (after duplicate collapse).

Sorting is required for stable storage, stable rendered output, snapshots, merges, and diffs.

## Non-Goals

This spec does not cover schema migration, repair of stale dependency records, dynamic dependency
discovery, direct value replacement, or counter-snapshot cache validation.

## Test Obligations

1. **Cache hit**: When all `valid[D].has(N)` flags exist for `inputEdges(N)`, a potentially-outdated
   node returns its cached value without running the computor.

2. **No vacuous cache hit**: A potentially-outdated zero-input node must run its computor.

3. **`Unchanged` adds validity flags**: `handleUnchanged` records `valid[D].add(N)` for every
   dependency edge and does not increment the counter.

4. **Changed value clears validity**: `handleChanged` deletes `N` from each `valid[D]`, clears
   `valid[N]`, writes the new value, increments the counter, records new valid flags, and propagates
   freshness.

5. **Changed dependency invalidates cache**: When a dependency `D` changes value, `valid[D]` is
   cleared. A dependent node that previously had a cache hit must validate or recompute on the next
   pull.

6. **`invalidate(N)` removes incoming validity flags**: Calling `invalidate(N)` removes `N` from
   `valid[D]` for every dependency `D`, so `pull(N)` reruns the computor even if all dependencies
   are otherwise unchanged.

7. **`invalidate(N)` preserves `valid[N]`**: Calling `invalidate(N)` does not clear `valid[N]`.
   Dependents that were valid with respect to `N` remain valid.

8. **Invalidate then `Unchanged` preserves dependent validity**: If `N` is invalidated then
   recomputes and returns `Unchanged`, `valid[N]` is preserved and dependents may still cache-hit.

9. **Invalidate then changed clears dependent validity**: If `N` is invalidated then recomputes
   and changes value, `valid[N]` is cleared and dependents must validate or recompute.

10. **Failed computor rolls back**: If the computor throws or returns an invalid value, `values[N]`,
    `counters[N]`, `valid`, `freshness[N]`, and structural metadata for `N` are not mutated.

11. **`Unchanged` requires materialized value**: A computor that returns `Unchanged` when `N` has no
    materialized value is an error.

12. **Duplicate input positions preserved for computor arguments, collapsed for edges**: Duplicate
    positions are preserved in the argument array but collapse to one dependency edge for `inputs`,
    `revdeps`, and `valid`.

13. **Deterministic serialization**: `valid` and `revdeps` serialize in canonical sorted order.
    Materialized `inputs` serialize in schema-derived order after duplicate collapse.
