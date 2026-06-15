# Flag-Based Inverse Validity Algorithm

## Purpose

The incremental graph stores materialized node values. A node may depend on other nodes, and its
computor may either produce a new value or report that the current materialized value is unchanged.

The graph needs a way to decide whether a node can safely reuse its current materialized value.
This specification uses a single inverse edge-validity relation (`valid`) as both the cache-proof
frontier and the invalidation propagation index.

The implementation has no separate reverse-dependency index. The `valid` relation is the sole
source of truth for both cache authorization and invalidation propagation.

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
valid     : Map<NodeIdentifier, Array<NodeIdentifier>>
```

- `values` — current materialized values.
- `counters` — monotonic recompute counters incremented on value change. Not used for cache
  validation.
- `freshness` — fast-path guard: an up-to-date node may be returned immediately. The invariant
  `freshness[N] = "up-to-date"` implies `N` has a materialized value.
- `inputs` — persisted normalized structural dependency-edge list for a materialized node.
- `valid` — inverse validity flags. `valid[D]` is an array of dependents `N` such that `N` has been
  validated with respect to the current value of `D`. `valid[D]` serves as both the cache-proof
  frontier and the invalidation propagation index.

## Input Terminology

There are two related but distinct concepts:

**inputPositions(N)** — the ordered concrete input positions derived from the node definition and
bindings. Duplicates are preserved. This list drives recursive pulls and the argument array passed
to the computor.

Example: `inputPositions(N) = [A, A, B]` means the computor receives `[value(A), value(A), value(B)]`.

**inputEdges(N)** — the normalized structural dependency-edge list. Duplicate input positions
collapse to one edge, preserving first occurrence for deterministic storage. This list drives
`inputs[N]` and `valid`.

Example: `inputPositions(N) = [A, A, B]` → `inputEdges(N) = [A, B]`.

`inputs[N]` stores `inputEdges(N)` for a materialized node.

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

- If `freshness[N] == "up-to-date"`, then `valid[D]` contains `N`.
- Every entry `N ∈ valid[D]` implies `inputs[N]` contains `D` and `N` is a known materialized node.
- No `valid` entry points to discarded identifiers after merge or migration.

The reverse implication is also operationally important:

- If `N` is `potentially-outdated` and every current input `D` has `valid[D].has(N)`,
  then `N`'s stored value may be reused without invoking `N`'s computor.

This means valid flags for stale nodes are meaningful cache proofs. They are not discarded merely
because the node is stale.

## Pull Algorithm

```
pull(N):

1. If freshness[N] is "up-to-date":
       Derive current inputEdges from schema.
       Verify persisted inputs[N] matches current inputEdges.
       For every D in inputEdges: verify valid[D].has(N).
       Return values[N].

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

### Up-to-date fast path (step 1)

For an up-to-date node with declared inputs, the fast path validates the current schema-derived
input edges against persisted `inputs[N]` and checks every `valid[D].has(N)` before returning
the cached value. This ensures structural consistency without pulling dependencies.

A zero-input node may use the fast path only if it has a persisted empty `inputs` record and a
materialized value.

If persisted `inputs[N]` does not match the current schema-derived `inputEdges`, or if any
`valid[D]` is missing `N` for an input `D`, the fast path falls through to full recomputation.

### Cache predicate (step 5)

A potentially-outdated node `N` may reuse its materialized value iff:

1. `N` has a materialized value,
2. `inputEdges(N)` is non-empty,
3. for every `D` in `inputEdges(N)`: `valid[D].has(N)`.

Condition 2 excludes zero-input nodes. A zero-input node has no dependencies to validate against,
so the predicate cannot pass and the node must run its computor.

## Handling `Unchanged`

When the computor returns `Unchanged`, the materialized value of `N` did not change.

```
handleUnchanged(N, inputEdges):

require N has a materialized value

inputs[N] = inputEdges
for every D in inputEdges:
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
    valid[D].remove(N)

let downstream = valid[N]
clear valid[N]

values[N] = newValue
counters[N] += 1

inputs[N] = inputEdges
for every D in inputEdges:
    valid[D].add(N)

freshness[N] = "up-to-date"
for every M in downstream:
    if freshness[M] is "up-to-date":
        freshness[M] = "potentially-outdated"
        propagate potentially-outdated through valid[M] recursively
```

Removing `N` from each `valid[D]` removes claims that the old value of `N` was valid with respect
to its dependencies. Clearing `valid[N]` removes claims that dependents were valid with respect to
the old value of `N`. The downstream set for propagation is captured from `valid[N]` before
clearing it. Propagation is recursive: marking a dependent potentially-outdated continues through
that dependent's own `valid` set.

## Freshness Invalidation

### Value-change propagation

When a node `N` changes value, its dependents are marked potentially-outdated as shown in
`handleChanged` above. Propagation walks the `valid` relation starting from `N`.

### External invalidation without value change

Marking a node potentially-outdated does not by itself change its materialized value:

```
invalidate(D):

if D is not materialized:
    return

freshness[D] = "potentially-outdated"

for every N in valid[D]:
    if freshness[N] is "up-to-date":
        freshness[N] = "potentially-outdated"
        continue propagation through valid[N] recursively
```

Invalidation does not modify `valid`. Existing validity flags are edge facts about current
materialized values. Marking freshness as potentially-outdated does not by itself falsify those
edge facts. On subsequent `pull`, the cache predicate checks `valid[D].has(N)` for every input
`D`. Even if `valid` still contains the flag, if the input's value actually changed, the
`handleChanged` path would have cleared the flag.

This rule is sound because invalidation does not directly replace `values[N]`. There is no direct
value replacement operation in this algorithm (see Fixed Model). If a value were replaced without
running the computor, validity flags involving the old value would become stale. Since the only way
to change a value is through a successful recomputation, and recomputation always performs the
validity cleanup in `handleChanged`, validity flags never survive across value changes.

## Concurrent Validity Updates

Updates to `valid[D]` must be linearizable with respect to concurrent graph transactions.
Blind read-modify-write on whole `valid[D]` arrays outside a serialized commit section can lose
concurrent additions.

### Mutation-logged validity operations

Graph transactions record high-level validity mutations instead of computing final arrays:

- `add(depId, dependentId)` — record the intent to add `dependentId` to `valid[depId]`.
- `remove(depId, dependentId)` — record the intent to remove `dependentId` from `valid[depId]`.
- `clear(depId)` — record the intent to clear `valid[depId]`.

### Commit-time resolution

Under the per-replica darkroom commit lock, the implementation:

1. Reads the latest committed `valid[D]` from storage.
2. Applies all recorded mutations in order (clear first, then adds and removes).
3. Sorts and deduplicates the resulting array.
4. Writes the final array (or deletes the key if empty).

Both `withTransaction()` and `withBatch()` use the same validity-mutation finalization path.
This guarantees that concurrent additions to the same `valid[D]` are merged, not overwritten.

### Transaction-local reads

Reads of `valid[D]` inside the same transaction see the transaction's own pending mutations merged
over the committed state. This ensures that propagation logic and cache-predicate checks within
the transaction are consistent with the transaction's uncommitted changes.

### Concurrency safety

- Concurrent additions to the same `valid[D]` are merged under the darkroom lock.
- Removals and clears are applied in a well-defined transaction order.
- Invalidation propagation sees the correct committed validity frontier.
- Failed transactions do not mutate `valid`.
- Raw `SchemaStorage.valid.putOp` / `SchemaStorage.valid.delOp` are only safe in isolated rebuild
  contexts such as migration or sync merge, not in live graph transactions.

## Transactional Semantics

During recomputation of `N`, the implementation may compute candidate `inputEdges`, but it must not
commit changes to `inputs[N]` or `valid` for `N` until the computor result has been accepted. All
mutations to `valid`, `values`, `counters`, `freshness`, and `inputs` caused by recomputing `N`
must be committed only after the computor successfully returns a valid result.

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

- `valid[D]` serializes as an array of `NodeIdentifier` values in canonical sorted order.
- `inputs[N]` serializes as the normalized dependency-edge list in deterministic first-occurrence
  order (after duplicate collapse).

Sorting is required for stable storage, stable rendered output, snapshots, merges, and diffs.

## Sync Merge and Migration

Sync merge and migration may rebuild `valid` in isolated replica contexts where no concurrent graph
transactions are active. In these contexts, raw full-array writes to `valid[D]` are acceptable.

### Sync merge

After applying precise merge decisions, the merge flow:

1. Preserves compatible `valid` entries from the surviving side where both the dependent and its
   dependency have unchanged value identity and the dependent's `inputs` still includes the
   dependency.
2. Removes entries for deleted or discarded identifiers.
3. Removes entries whose dependent's value was changed, taken from an incompatible side, or whose
   inputs no longer contain the dependency.
4. Adds required missing flags for every up-to-date node per the invariant:
   for every `D` in `inputs[N]`, `valid[D]` contains `N`.

### Migration

Migration rebuilds `valid` from the final migrated graph state:

- `create` and `override` nodes receive incoming valid flags for their current inputs.
- `keep` nodes receive incoming valid flags only if their previous freshness is `"up-to-date"`.
- Existing compatible valid proofs for stale kept nodes are preserved when they remain true
  after migration (the dependent survives, the dependency survives with unchanged value identity,
  and the inputs still contain the dependency).
- `invalidate` nodes do not receive incoming valid flags.
- `delete` nodes do not appear in `valid`.
- Any `valid` entry pointing to a deleted identifier is absent after migration.

The migration path validates the target replica before activating it, checking the invariants
described in the Invariants section above.

## Non-Goals

This spec does not cover schema migration, repair of stale dependency records, dynamic dependency
discovery, direct value replacement, or counter-snapshot cache validation.
