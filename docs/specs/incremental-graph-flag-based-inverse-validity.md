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

### Edge immutability

For a stable schema and a stable `NodeIdentifier`, `inputEdges(N)` is immutable. A node's
schema-derived dependency edges cannot change without changing the node's schema or bindings, both
of which are fixed for the lifetime of the `IncrementalGraph` instance.

If an implementation ever observes persisted `inputs[N]` differing from the schema-derived
`inputEdges(N)`, that is schema migration or repair territory and is outside this algorithm.
The handlers in this spec do not reconcile removed or added edges; they assume the input edge set
is identical at every materialization of the same node.

## Invariants

For every materialized node `N` and every `D` in `inputs[N]`:

```
D in inputs[N]  iff  N in revdeps[D]
valid[D].has(N) implies revdeps[D].has(N)
```

A validity flag only has meaning for an existing dependency edge.

The algorithm may safely omit valid flags. A missing flag may cause extra computation but must not
cause an incorrect cache hit. A present flag must never be stale.

### Why `revdeps` still exists

`revdeps` is the conservative structural traversal index. `valid` is an optional cache-proof
relation. Because valid flags may be omitted (a missing flag is not a cache hit, not a structural
error), `valid[D]` is NOT a complete reverse dependency index.

`valid` MUST NOT be used as the invalidation freshness-propagation index unless the implementation
strengthens the invariant so that every up-to-date structural dependent is guaranteed present in
`valid[D]`. This specification does not require that stronger invariant; therefore invalidation
walks `revdeps`.

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

### External invalidation without value change

Marking a node potentially-outdated does not by itself change its materialized value. External
invalidation must not mutate `valid`:

```
markPotentiallyOutdated(N):

freshness[N] = "potentially-outdated"
propagate potentially-outdated freshness through revdeps[N]
do not modify valid
```

Existing validity flags are edge facts about current materialized values. Marking freshness as
potentially-outdated does not by itself falsify those edge facts.

This rule is sound because external invalidation does not directly replace `values[N]`. There is no
direct value replacement operation in this algorithm (see Fixed Model). If a value were replaced
without running the computor, validity flags involving the old value would become stale. Since the
only way to change a value is through a successful recomputation, and recomputation always
performs the validity cleanup in `handleChanged`, validity flags never survive across value
changes.

## Transactional Semantics

During recomputation of `N`, the implementation may compute candidate `inputEdges`, but it must not
commit changes to `inputs[N]`, `revdeps`, or `valid` for `N` until the computor result has been
accepted. All mutations to `valid`, `values`, `counters`, `freshness`, `inputs`, and `revdeps`
caused by recomputing `N` must be committed only after the computor successfully returns a valid
result.

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
discovery, or direct value replacement.

## Implementation Note

The `valid` relation is optional proof metadata. Implementations may safely omit validity
flags — a missing flag causes extra recomputation but must not cause an incorrect cache
hit. Counters are value-change metadata only and are not used for cache validation.