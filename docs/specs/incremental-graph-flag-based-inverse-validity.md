# Flag-Based Inverse Validity Algorithm

## Context

The incremental graph stores materialized node values. A node may depend on other nodes, and its computor may either produce a new value or report that the current materialized value is unchanged.

The graph needs a way to decide whether a potentially outdated node can safely reuse its current materialized value. This specification uses an inverse edge-validity relation. The structural dependency graph records which nodes depend on which inputs. A separate validity relation records which dependency edges are valid for the current materialized values of both endpoints.

The central idea is:

```text
valid[D].has(N)
```

means:

```text
The current materialized value of N has been validated with respect to
the current materialized value of D.
```

A node can reuse its materialized value when this condition holds for every current dependency.

## Fixed Schema

For one `IncrementalGraph` instance, the schema is fixed and does not change.

A node's concrete input list is determined by:

1. the node definition schema,
2. the node's bindings,
3. the existing compilation/instantiation logic.

The computor does **not** discover dependencies at runtime. It receives already-pulled input values. It does not receive a dependency-registration API, and it does not return a dependency list.

The schema-derived concrete inputs are the source of truth for what a node depends on. All structural metadata in the graph is derived from this fixed list.

## State

The graph maintains the following state.

```text
values : Map<NodeIdentifier, Value>
```

Stores the current materialized value of each node.

```text
counters : Map<NodeIdentifier, RecomputeCounter>
```

Stores the current value-version counter of each node. The counter increments when the node's own materialized value changes.

The validity algorithm does not use counters for cache validation. Counters may still be used for rendering, debugging, external consistency, and other graph invariants.

```text
freshness : Map<NodeIdentifier, "up-to-date" | "potentially-outdated">
```

Stores whether a node can be returned immediately or must be validated before reuse.

```text
inputs : Map<NodeIdentifier, Array<NodeIdentifier>>
```

Stores the materialized structural dependencies of a node. For a materialized node `N`, `inputs[N]` holds the schema-derived concrete input list computed at instantiation time.

Example:

```text
inputs[N] = [A, B, C]
```

means:

```text
N depends on A, B, and C.
```

The persisted order must be deterministic. If dependency order has semantic meaning, preserve that order. If it has no semantic meaning, store a stable canonical order.

The schema-derived concrete input list is the source of truth. The persisted `inputs` record stores the materialized structural index for that list. Normal validity refresh must not rewrite the `inputs` record merely to record validity. Implementations may create or idempotently ensure the structural record when materializing a node.

```text
revdeps : Map<NodeIdentifier, Set<NodeIdentifier>>
```

Stores the reverse dependency relation.

Example:

```text
revdeps[A].has(N)
```

means:

```text
N depends on A.
```

```text
valid : Map<NodeIdentifier, Set<NodeIdentifier>>
```

Stores inverse validity flags.

Example:

```text
valid[A] = { B, C }
```

means:

```text
The current value of B has been validated with respect to the current value of A.
The current value of C has been validated with respect to the current value of A.
```

Persisted `valid[X]` sets must serialize in deterministic sorted order.

## Structural Invariants

For every materialized node `N` and every `D` in its schema-derived concrete inputs:

```text
D is in inputs[N]
iff
N is in revdeps[D]
```

The validity relation is a subset of the reverse dependency relation:

```text
valid[D].has(N) implies revdeps[D].has(N)
```

A validity flag only has meaning for an existing dependency edge.

## Validity Invariant

The soundness invariant is:

```text
valid[D].has(N)
```

implies:

```text
The current materialized value of N has been successfully validated
with respect to the current materialized value of D.
```

The algorithm may safely omit valid flags. A missing flag may cause extra computation, but it must not cause an incorrect cache hit. A present flag must never be stale.

Validity flags are current-edge facts. They are invalidated when either endpoint value changes:

```text
D changes value -> clear valid[D]
N changes value -> remove N from valid[D] for every D in inputs[N]
```

## Cache Predicate

A potentially outdated node `N` may reuse its current materialized value iff:

1. `N` has a materialized value,
2. `inputs[N]` is non-empty,
3. for every `D` in `inputs[N]`: `valid[D].has(N)`.

Condition 2 excludes zero-input nodes. For a zero-input node there are no dependencies to validate against, so the predicate cannot pass: the node must run its computor unless the graph defines a separate explicit rule for that node kind.

If the predicate holds:

```text
freshness[N] = "up-to-date"
return values[N]
```

## Value-Change Cleanup

Whenever a node `N` changes its own materialized value, the graph must remove validity flags involving the old value of `N`.

```text
onValueChanged(N):

1. For every D in inputs[N]:
       valid[D].delete(N)

2. Clear valid[N].

3. Increment counters[N].

4. Propagate potentially-outdated freshness to dependents through revdeps[N].
```

The two validity cleanup steps remove different claims.

This step:

```text
for every D in inputs[N]:
    valid[D].delete(N)
```

removes claims of the form:

```text
N is valid with respect to D.
```

Those claims refer to the old value of `N`.

This step:

```text
clear valid[N]
```

removes claims of the form:

```text
Some dependent M is valid with respect to N.
```

Those claims also refer to the old value of `N`.

Both cleanup operations are required.

## Direct Value Replacement

There must not be direct value replacement. Only `pull`s can mutate `values` sublevel.

## Pull Algorithm

The `pull(N)` operation returns the materialized value of `N`, validating or recomputing it when necessary.

The graph maintains this invariant:

```text
freshness[N] = "up-to-date" implies N has a materialized value.
```

An up-to-date node without a materialized value is an invariant violation. The implementation should treat this as an error.

```text
pull(N):

1. If freshness[N] is "up-to-date":
       return values[N]

2. Let inputs[N] be the schema-derived concrete inputs of N.

3. For every D in inputs[N]:
       pull(D)

4. If N has a materialized value,
   and inputs[N] is non-empty,
   and every D in inputs[N] satisfies valid[D].has(N):

       freshness[N] = "up-to-date"
       return values[N]

5. Run N's computor using the values returned for inputs[N].

6. If the computor returns Unchanged:
       handleUnchangedResult(N)

7. If the computor returns newValue:
       handleChangedResult(N, newValue)

8. Return values[N].
```

Dependency pulls in step 3 ensure that dependencies are current before `N` is checked against them.

The cache predicate in step 4 is checked only after dependency pulls complete.

A computor must not return `Unchanged` when `N` has no materialized value.

## Handling `Unchanged`

If the computor returns `Unchanged`, the materialized value of `N` did not change.

Therefore:

```text
values[N] does not change
counters[N] does not change
valid[N] is not cleared
```

Validity facts from `N` to its dependents remain valid because `N`'s value remains unchanged.

```text
handleUnchangedResult(N):

1. Ensure inputs[N] records the schema-derived concrete inputs.
   For every D in inputs[N]:
       ensure revdeps[D].has(N)

2. For every D in inputs[N]:
       valid[D].add(N)

3. freshness[N] = "up-to-date"
```

Do not clear `valid[N]`.

Do not increment `counters[N]`.

## Handling a Changed Value

If the computor returns a new value, the materialized value of `N` changes. All validity flags involving the old value of `N` must be removed before new validity facts are recorded.

```text
handleChangedResult(N, newValue):

1. For every D in inputs[N]:
       valid[D].delete(N)

2. Clear valid[N].

3. values[N] = newValue

4. Increment counters[N].

5. Ensure inputs[N] records the schema-derived concrete inputs.
   For every D in inputs[N]:
       ensure revdeps[D].has(N)

6. For every D in inputs[N]:
       valid[D].add(N)

7. freshness[N] = "up-to-date"

8. Propagate potentially-outdated freshness to dependents through revdeps[N].
```

Step 1 removes claims that the old value of `N` was valid with respect to its inputs.

Step 2 removes claims that other nodes were valid with respect to the old value of `N`.

Step 6 records that the new value of `N` has been computed with respect to the current values of its inputs.

Step 8 is required because dependents of `N` may no longer be valid.

## Freshness Propagation

Freshness propagation is separate from validity flags.

When a node `N` changes value, its dependents must be marked potentially outdated.

```text
propagateOutdated(N):

1. For every M in revdeps[N]:

       if freshness[M] is "up-to-date":
           freshness[M] = "potentially-outdated"
           propagateOutdated(M)

       otherwise:
           do not rewrite freshness[M]
           do not continue through M
```

The traversal must preserve the graph's existing freshness propagation semantics.

Validity flags are used when a potentially outdated node is pulled. They are not used for eager freshness propagation.

## External Invalidation Without Value Change

Marking a node potentially outdated does not by itself change its materialized value.

Therefore, external invalidation without value change must not modify `valid`.

```text
markPotentiallyOutdated(N):

1. freshness[N] = "potentially-outdated"

2. Propagate potentially-outdated freshness through revdeps[N]
   according to the graph's freshness propagation rules.

3. Do not modify valid.
```

A node may be potentially outdated while its value remains unchanged.

## Transactional Behavior

All mutations to `valid`, `values`, `counters`, `freshness`, `inputs`, and `revdeps` caused by recomputing `N` must be committed only after the computor successfully returns a valid result.

If the computor throws or returns an invalid value:

- do not write `values[N]`,
- do not increment `counters[N]`,
- do not add validity flags,
- do not mark `freshness[N]` as up-to-date,
- do not partially mutate structural metadata for `N`.

Dependency pulls may already have committed independently according to the existing transaction model. That is acceptable, but `N`'s own recomputation effects must not be partially committed.

## Duplicate and Order Semantics

The concrete input list is ordered by the node definition. For validity purposes, it is treated as a set of dependency edges. Duplicate dependency references collapse to one edge, preserving the first occurrence for deterministic materialized storage.

Validity flags are set-like:

```text
valid[D] is a set of dependents.
```

Reverse dependencies are also set-like, persisted deterministically.

## Persistence Requirements

The semantic type of `valid[N]` is a set.

The persisted representation must be deterministic. When serializing:

```text
valid[N]
```

write node identifiers in canonical sorted order.

Example semantic state:

```text
valid[A] = { C, B, E }
```

must serialize as a stable ordered list, for example:

```text
valid[A] = [B, C, E]
```

Sorting is not part of algorithmic correctness. It is required for stable storage, stable rendered output, snapshots, merges, and diffs.

Persisted `revdeps[D]` sets must also serialize in canonical sorted order.

Materialized `inputs[N]` must serialize deterministically according to the schema-derived input order after duplicate normalization.

## Required Mutations Summary

### When `N` is marked potentially outdated

```text
freshness[N] = "potentially-outdated"
```

No `valid` mutation.

### When `N` is pulled and the cache predicate passes

```text
freshness[N] = "up-to-date"
```

No `valid` mutation is required.

### When `N` recomputes and returns `Unchanged`

```text
ensure inputs[N] records the schema-derived concrete inputs
for every D in inputs[N]:
    ensure revdeps[D].has(N)
    valid[D].add(N)

freshness[N] = "up-to-date"
```

Do not clear `valid[N]`.

Do not increment `counters[N]`.

### When `N` recomputes and returns a new value

```text
for every D in inputs[N]:
    valid[D].delete(N)

clear valid[N]

values[N] = newValue
counters[N] += 1

ensure inputs[N] records the schema-derived concrete inputs
for every D in inputs[N]:
    ensure revdeps[D].has(N)
    valid[D].add(N)

freshness[N] = "up-to-date"

propagate potentially-outdated freshness through revdeps[N]
```

## Correctness Summary

The algorithm is sound when these rules are maintained:

```text
1. valid[D].has(N) implies N's current value is valid with respect to D's current value.

2. When D changes value:
       clear valid[D]

3. When N changes value:
       delete N from valid[D] for every D in inputs[N]

4. After N is successfully computed or validated against D:
       valid[D].add(N)
```

The cache predicate is sound because:

```text
N can be reused only when every current input D satisfies valid[D].has(N).
```

Therefore, the current materialized value of `N` has been validated with respect to every current materialized input value.

## Non-Goals

This specification assumes a fixed schema for the lifetime of the `IncrementalGraph` instance. Migration from older dependency records or schema changes is outside this algorithm.

The computor does not discover, add, remove, or return dependencies at runtime. The schema-derived concrete input list is the sole source of truth for a node's dependencies.

## Test Obligations

The implementation must satisfy these test obligations:

1. **Cache hit**: When all input validity flags exist, a potentially outdated node returns its cached value without running the computor.

2. **No vacuous cache hit**: A potentially outdated zero-input node must run its computor. An empty input list does not make the cache predicate pass by vacuity.

3. **`Unchanged` adds validity flags**: When the computor returns `Unchanged`, `valid[D].add(N)` is recorded for every input `D`, and the counter does not increment.

4. **Changed value clears validity**: When the computor returns a new value, `valid[D]` is cleared of `N` for every input `D`, `valid[N]` is cleared, and the counter increments.

5. **Changed dependency invalidates cache**: When a dependency `D` changes value, `valid[D]` is cleared. A dependent node that previously had a cache hit must validate or recompute on the next pull.

6. **External invalidation preserves validity**: Marking a node potentially outdated does not mutate `valid`. A node remains valid with respect to its inputs even after external invalidation.

7. **Direct replacement clears validity conservatively**: A direct replacement that cannot prove the value is unchanged clears validity flags. A direct replacement that proves the value is unchanged does not clear validity.

8. **Deterministic serialization**: `valid` and `revdeps` serialize in canonical sorted order. Materialized `inputs` serialize in schema-derived order after duplicate collapse.

9. **Failed computor rolls back**: If the computor throws or returns an invalid value, `values[N]`, `counters[N]`, `valid`, `freshness[N]`, and structural metadata for `N` are not mutated.

10. **`Unchanged` requires materialized value**: A computor that returns `Unchanged` when `N` has no materialized value is an error.

11. **Duplicate input collapse**: When the schema-derived input list contains duplicate dependency references, they collapse to one edge for validity and structural indexing purposes.

12. **No structural rewrite on validity refresh**: Refreshing validity for an already-materialized node must not rewrite the materialized `inputs` record when the schema-derived concrete inputs are unchanged.
