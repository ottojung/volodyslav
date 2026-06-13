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

The validity algorithm does not use counters for cache validation. Counters may still be used for rendering, debugging, migration, external consistency, and other graph invariants.

```text
freshness : Map<NodeIdentifier, "up-to-date" | "potentially-outdated">
```

Stores whether a node can be returned immediately or must be validated before reuse.

```text
inputs : Map<NodeIdentifier, Array<NodeIdentifier>>
```

Stores the current structural dependencies of a node.

Example:

```text
inputs[N] = [A, B, C]
```

means:

```text
N currently depends on A, B, and C.
```

The persisted order must be deterministic. If dependency order has semantic meaning, preserve that order. If it has no semantic meaning, store a stable canonical order.

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
N currently depends on A.
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

For every dependency edge:

```text
D -> N
```

the structural indexes must agree:

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

A potentially outdated node `N` may reuse its current materialized value when every current dependency has a validity flag pointing to `N`.

Given:

```text
inputs[N] = [D1, D2, ..., Dk]
```

the cache predicate is:

```text
for every D in inputs[N]:
    valid[D].has(N)
```

If the predicate holds:

```text
freshness[N] = "up-to-date"
return values[N]
```

The cache predicate must not pass vacuously for zero-input nodes. A zero-input node that is potentially outdated must run its computor unless the graph defines a separate explicit rule for that node kind.

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

Any operation that replaces or may replace the materialized value of `N` without running `N`'s normal computor must use value-change cleanup.

```text
replaceValue(N, newValue):

1. If the operation changes or may change values[N]:
       onValueChanged(N)

2. values[N] = newValue

3. Set freshness[N] according to the semantics of the replacement operation.
```

A direct replacement must not add `N` to `valid[D]` for any dependency `D` unless the replacement operation actually validates `N` against `D`.

## Pull Algorithm

The `pull(N)` operation returns the materialized value of `N`, validating or recomputing it when necessary.

```text
pull(N):

1. If freshness[N] is "up-to-date":
       return values[N]

2. Let oldValue = values[N].
   Let oldInputs = inputs[N], or [] if no dependency record exists.

3. For every D in oldInputs:
       pull(D)

4. If oldValue exists,
   and oldInputs is non-empty,
   and every D in oldInputs satisfies valid[D].has(N):

       freshness[N] = "up-to-date"
       return oldValue

5. Run N's computor.
   During computation, collect actualInputs.

6. If the computor returns Unchanged:
       handleUnchangedResult(N, oldInputs, actualInputs)

7. If the computor returns newValue:
       handleChangedResult(N, oldInputs, actualInputs, newValue)

8. Return values[N].
```

Dependency pulls in step 3 ensure that dependencies are current before `N` is checked against them.

The cache predicate in step 4 is checked only after dependency pulls complete.

A computor must not return `Unchanged` when no materialized value exists for `N`.

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
handleUnchangedResult(N, oldInputs, actualInputs):

1. Reconcile dependency structure:

   a. For every D in oldInputs that is not in actualInputs:
          valid[D].delete(N)
          revdeps[D].delete(N)

   b. For every D in actualInputs that is not in oldInputs:
          revdeps[D].add(N)

   c. If oldInputs and actualInputs differ:
          inputs[N] = actualInputs

2. For every D in actualInputs:
       valid[D].add(N)

3. freshness[N] = "up-to-date"
```

The graph must not rewrite `inputs[N]` when `oldInputs` and `actualInputs` are equal.

## Handling a Changed Value

If the computor returns a new value, the materialized value of `N` changes. All validity flags involving the old value of `N` must be removed before new validity facts are recorded.

```text
handleChangedResult(N, oldInputs, actualInputs, newValue):

1. For every D in oldInputs:
       valid[D].delete(N)

2. Clear valid[N].

3. values[N] = newValue

4. Increment counters[N].

5. Reconcile dependency structure:

   a. For every D in oldInputs that is not in actualInputs:
          revdeps[D].delete(N)

   b. For every D in actualInputs that is not in oldInputs:
          revdeps[D].add(N)

   c. If oldInputs and actualInputs differ:
          inputs[N] = actualInputs

6. For every D in actualInputs:
       valid[D].add(N)

7. freshness[N] = "up-to-date"

8. Propagate potentially-outdated freshness to dependents through revdeps[N].
```

Step 1 removes claims that the old value of `N` was valid with respect to old inputs.

Step 2 removes claims that other nodes were valid with respect to the old value of `N`.

Step 6 records that the new value of `N` has been computed with respect to the current values of its actual inputs.

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

## Dependency Structure Reconciliation

When `inputs[N]` changes from `oldInputs` to `actualInputs`:

```text
removedInputs = oldInputs - actualInputs
addedInputs = actualInputs - oldInputs
```

For every removed input `D`:

```text
revdeps[D].delete(N)
valid[D].delete(N)
```

For every added input `D`:

```text
revdeps[D].add(N)
```

After `N` is successfully computed or validated against `actualInputs`:

```text
for every D in actualInputs:
    valid[D].add(N)
```

The graph must not preserve validity flags for removed dependency edges.

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
for every removed input D:
    valid[D].delete(N)
    revdeps[D].delete(N)

for every added input D:
    revdeps[D].add(N)

if inputs changed:
    inputs[N] = actualInputs

for every actual input D:
    valid[D].add(N)

freshness[N] = "up-to-date"
```

Do not clear `valid[N]`.

Do not increment `counters[N]`.

### When `N` recomputes and returns a new value

```text
for every old input D:
    valid[D].delete(N)

clear valid[N]

values[N] = newValue
counters[N] += 1

reconcile inputs[N] and revdeps

for every actual input D:
    valid[D].add(N)

freshness[N] = "up-to-date"

propagate potentially-outdated freshness through revdeps[N]
```

### When `N` is directly replaced without normal recomputation

```text
for every D in inputs[N]:
    valid[D].delete(N)

clear valid[N]

values[N] = newValue
counters[N] += 1

propagate potentially-outdated freshness through revdeps[N]
```

Do not add `N` to any `valid[D]` unless the replacement operation validates `N` against `D`.

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
