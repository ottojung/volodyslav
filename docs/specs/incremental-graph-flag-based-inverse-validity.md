# Flag-Based Inverse Validity Algorithm

## Purpose

The incremental graph stores materialized node values. A node may depend on other nodes, and its
computor may either produce a new value or report that the current materialized value is unchanged.

The graph needs a way to decide whether a node can safely reuse its current materialized value.
This specification uses a single inverse edge-validity relation (`valid`) as both the cache-proof
frontier and the invalidation propagation index.

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
freshness : Map<NodeIdentifier, "up-to-date" | "potentially-outdated">
valid     : Map<NodeIdentifier, Array<NodeIdentifier>>
```

- `values` — persisted materialized node values. `values.keys()` is the materialized-node registry.
- `freshness` — persisted fast-path guard: an up-to-date node may be returned immediately.
  The invariant `freshness[N] = "up-to-date"` implies `N` has a materialized value.
- `valid` — persisted inverse validity flags. `valid[D]` is an array of dependents `N` such that
  `N` has been validated with respect to the current value of `D`. `valid[D]` is both the
  cache-proof frontier and the invalidation propagation index.

There is no persisted per-node input storage. Structural dependency edges are derived from the
stored `graph_scheme`, the `identifiers_keys_map`, and the node's semantic key.

## Input Terminology

There are two related but distinct concepts, both derived (not persisted per node):

**inputPositions(N)** — the ordered concrete input positions derived from the node definition and
bindings. Duplicates are preserved. This list drives recursive pulls and the argument array passed
to the computor.

Example: `inputPositions(N) = [A, A, B]` means the computor receives `[value(A), value(A), value(B)]`.

**inputEdges(N)** — the normalized structural dependency-edge list. Duplicate input positions
collapse to one edge, preserving first occurrence for deterministic ordering. This list drives the
`valid` relation (via the cache predicate and the `addValidityFlags` helper).

Example: `inputPositions(N) = [A, A, B]` → `inputEdges(N) = [A, B]`.

`inputEdges(N)` is always derived from the graph scheme and identifier lookup; it is not persisted.
The derivation uses three sources:

1. The persisted `global/graph_scheme` record, which maps each node head to its input templates.
2. The `identifiers_keys_map`, which maps semantic node keys to runtime identifiers.
3. The node's own semantic key (head + bindings).

### Edge immutability

For a stable schema and a stable `NodeIdentifier`, `inputEdges(N)` is immutable. A node's
schema-derived dependency edges cannot change without changing the node's schema or bindings, both
of which are fixed for the lifetime of the `IncrementalGraph` instance.

## Invariants

For every materialized node `N` and every `D` in `inputEdges(N)`:

- If `freshness[N] == "up-to-date"`, then `valid[D]` contains `N`.
- Every entry `N ∈ valid[D]` implies `D ∈ inputEdges(N)` and `N` is a known materialized node.
- No `valid` entry points to discarded identifiers after merge or migration.

The reverse implication is also operationally important:

- If `N` is `potentially-outdated` and every current input `D` has `valid[D].has(N)`,
  then `N`'s stored value may be reused without invoking `N`'s computor.

This means valid flags for stale nodes are meaningful cache proofs. They are not discarded merely
because the node is stale.

## Correctness model for "valid"

### Terminology

- A **structural edge** `D -> N` exists iff `D ∈ inputEdges(N)`.
- A **validity edge** `D ⇝ N` exists iff `N ∈ valid[D]`.
- `inputEdges` is the derived structural dependency relation across all materialized nodes.
- `valid` is not the complete reverse dependency relation. It is a cache-proof and invalidation-frontier relation.
- `valid[D]` is the **outgoing validity frontier** of `D`: the nodes whose cached values are authorized relative to `D`'s current stored value.
- The **incoming validity proofs** of a node `N` are the edges `D ⇝ N` for every `D ∈ inputEdges(N)`.

### Invariants

#### 1. Structural soundness of validity

If `N ∈ valid[D]`, then both identifiers are known materialized identifiers and `D ∈ inputEdges(N)`.

This prevents validity edges from pointing to nonexistent nodes or to nodes that do not structurally depend on the key.

#### 2. Required incoming validity for clean nodes

If `freshness[N] === "up-to-date"` and `D ∈ inputEdges(N)`, then `N ∈ valid[D]`.

This means every clean non-source materialized node carries the proofs needed for cache reuse.

#### 3. Cache return is authorized

A cached value for `N` may be returned in exactly two situations:

**Up-to-date path (no validity check):**

- `freshness[N] === "up-to-date"`;
- a value for `N` exists.

The completeness of validity flags for up-to-date nodes is a storage invariant enforced by
writers (handleUnchanged, handleChanged), migrations, sync merge, and validation, not by
the read fast path.

**Potentially-outdated path (validity check):**

- `freshness[N] === "potentially-outdated"`;
- a materialized value for `N` exists;
- `inputEdges(N)` is non-empty;
- for every `D ∈ inputEdges(N)`, `N ∈ valid[D]`.

For zero-input nodes, `inputEdges(N)` is empty, so the potentially-outdated predicate
cannot pass. An up-to-date zero-input node returns immediately through the up-to-date path.
A potentially-outdated zero-input node must recompute.

#### 4. Validity is allowed to be incomplete

Missing `D ⇝ N` does not mean `N` is not a structural dependent of `D`. It only means `N` does not currently have a cache proof with respect to `D`.

Therefore, operations that need the full structural graph, such as migration delete/fan-in checks, must use the derived `inputEdges`, not `valid`.

#### 5. Stale nodes may retain conditional outgoing proofs

A potentially-outdated node may still have a nonempty `valid[N]`. These outgoing edges are conditional proofs for downstream nodes. They are not enough to return `N` itself from cache, because `N`'s own freshness blocks that.

These edges become useful only after `N` is pulled:

- if `N` recomputes and changes value, `valid[N]` is cleared and downstream nodes remain stale;
- if `N` returns "unchanged", the preserved outgoing proofs are still sound.

## Pull Algorithm

```
pull(N):

1. If freshness[N] is "up-to-date":
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

For an up-to-date node, the stored value is returned directly. Validity flags are not
consulted because the invariant `freshness[N] === "up-to-date"` implies that all validity
flags are complete for `N` in well-formed storage.

If the invariant is violated — an up-to-date node lacks a materialized value — the
implementation throws an error. This is not a runtime recovery scenario but a
corruption/integrity check.

Zero-input nodes follow the same fast path: an up-to-date zero-input node returns its
value immediately.

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

for every D in inputEdges:
    valid[D].add(N)

freshness[N] = "up-to-date"
```

- `values[N]` is unchanged.
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

### Explicit invalidation semantics

The `invalidate(N)` operation has two possible semantics:

1. **Soft invalidation:** mark `N` and downstream as potentially-outdated, but allow `N` to reuse its old value if all dependencies are pulled and all incoming validity proofs still hold.

2. **Hard invalidation:** force `N`'s computor to run next time, regardless of incoming validity proofs.

The current algorithm implements **soft invalidation for non-zero-input nodes** and **hard invalidation for zero-input nodes**.

For non-zero-input nodes, invalidation preserves existing validity flags (Invariant 5). If all incoming validity proofs are intact after the node is pulled, the cache predicate succeeds and the computor is not invoked. This is the soft semantics.

For zero-input nodes, `inputs[N]` is empty, so there are no incoming validity proofs to check. The cache predicate explicitly rejects zero-input nodes (`inputEdges.length > 0` is required for the cache predicate to pass). Therefore an invalidated zero-input node always runs its computor on the next pull. This is the hard semantics.

No additional mechanism is needed because the existing cache predicate enforces this distinction: non-zero-input nodes can cache-hit through preserved validity flags, while zero-input nodes have no dependencies to validate against and must recompute.

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
mutations to `valid`, `values`, `freshness`, and `inputs` caused by recomputing `N`
must be committed only after the computor successfully returns a valid result.

If the computor throws or returns an invalid value:

- do not write `values[N]`,
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
- No per-node input storage exists. `inputEdges(N)` is always derived from the stored
  `graph_scheme` and the `identifiers_keys_map`.

Sorting of `valid[D]` is required for stable storage, stable rendered output, snapshots, merges,
and diffs.

## Sync Merge and Migration

Sync merge and migration may rebuild `valid` in isolated replica contexts where no concurrent graph
transactions are active. In these contexts, raw full-array writes to `valid[D]` are acceptable.

### Sync merge

After applying precise merge decisions, the merge flow:

1. Preserves compatible `valid` entries from the surviving side where both the dependent and its
   dependency have unchanged value identity and the dependent's derived `inputEdges` still include
   the dependency.
2. Removes entries for deleted or discarded identifiers.
3. Removes entries whose dependent's value was changed, taken from an incompatible side, or whose
   derived input edges no longer contain the dependency.
4. Adds required missing flags for every up-to-date node per the invariant:
   for every `D` in `inputEdges(N)`, `valid[D]` contains `N`.

### Migration

Migration rebuilds `valid` from the final migrated graph state:

- `create` and `override` nodes receive incoming valid flags for their current derived inputs.
- `keep` nodes receive incoming valid flags only if their previous freshness is `"up-to-date"`.
- Existing compatible valid proofs for stale kept nodes are preserved when they remain true
  after migration (the dependent survives, the dependency survives with unchanged value identity,
  and the derived input edges still contain the dependency).
- `invalidate` nodes do not receive incoming valid flags.
- `delete` nodes do not appear in `valid`.
- Any `valid` entry pointing to a deleted identifier is absent after migration.

The migration path validates the target replica before activating it, checking the invariants
described in the Invariants section above.

## Proof Sketches

### Theorem 1: Cache safety

**Claim:** If `pull(N)` returns a cached value for `N`, then every current dependency value used to justify that cache is the same stored value relative to which `N` was last authorized.

**Proof sketch:**

- A direct fast-path cache return requires `freshness[N] === "up-to-date"`.
- The invariant `freshness[N] === "up-to-date"` implies all incoming validity proofs exist
  (by the writer contract: handleUnchanged and handleChanged always write validity flags
  before marking up-to-date).
- In the potentially-outdated recompute path, dependencies are pulled before `N` checks
  whether it can reuse its old value. The cache predicate verifies all incoming validity
  proofs.
- Therefore `N` cannot be returned merely because some old outgoing validity edge exists.
  Its own freshness and incoming validity must be established.

### Theorem 2: Changed values revoke downstream authorization

**Claim:** If a node `D` is recomputed and its value changes, then cached values depending on the old value of `D` cannot be returned as clean without recomputation or proof repair.

**Proof sketch:**

- On changed result, the algorithm reads `valid[D]` as the downstream frontier.
- It clears `valid[D]`.
- It marks direct downstream nodes potentially-outdated.
- It propagates through preserved outgoing validity frontiers to mark transitive clean dependents stale.
- Since `valid[D]` is cleared, any direct dependent requiring `D ⇝ N` cannot pass the cache authorization predicate until it recomputes or re-establishes the proof.

### Theorem 3: Preserved stale outgoing validity is safe

Consider the concrete trace `A -> B -> C`.

**Initial state:**

```
freshness[A] = up-to-date
freshness[B] = up-to-date
freshness[C] = up-to-date

inputEdges(B) = [A]
inputEdges(C) = [B]

valid[A] = [B]
valid[B] = [C]
```

Now `A` changes.

**After handling the changed value of `A`:**

```
freshness[A] = up-to-date
freshness[B] = potentially-outdated
freshness[C] = potentially-outdated

valid[A] = []
valid[B] = [C]
```

**Why this is safe:**

- `valid[B] = [C]` does not authorize returning `B`; `B` is stale.
- Pulling `C` must pull `B` first.
- If `B` changes, `valid[B]` is cleared and `C` cannot use its cached value.
- If `B` returns "unchanged", then `C`'s old cached value is still valid relative to `B`, so preserving `valid[B] = [C]` was correct.

This is the central vocabulary point: `valid[B] = [C]` is not a global claim that `C` is clean. It is a conditional proof that can only be used after the upstream node's own freshness and proof obligations have been satisfied.

### Theorem 4: Runtime invalidation can use "valid" as a frontier

**Claim:** For runtime invalidation of a changed or potentially changed node, walking `valid[D]` is sufficient to find clean cached nodes that need to be marked stale.

**Proof sketch:**

- By the required incoming validity invariant (enforced by writers, not the read path), any up-to-date node `N` structurally depending on `D` must have `N ∈ valid[D]`.
- Therefore every clean dependent that can be returned from cache is on the `valid` frontier.
- If a structural dependent is absent from `valid[D]`, it lacks an incoming cache proof relative to `D`; it is already unable to pass cache authorization through that dependency.
- Therefore it does not need to be discovered for the purpose of preventing unsound cache return.

This theorem is about runtime cache invalidation, not about structural graph operations.

### Theorem 5: "valid" is not a structural graph replacement

**Claim:** `valid` is safe as a cache-authorization and runtime invalidation frontier, but it is not safe as the complete structural reverse dependency graph.

**Proof sketch:**

- Stale nodes may lack some incoming validity proofs.
- Missing validity does not imply missing structural dependency.
- Therefore migration deletion, fan-in checks, and any operation that needs all structural dependents must use the derived `inputEdges`.

Document this explicitly because it prevents a future reader from treating `valid` as a renamed reverse-dependency index.

### Theorem 6: Merge validity reconstruction preserves soundness

**Claim:** After sync merge validity reconstruction, the final state satisfies:

- every `valid[D]` entry points only to known identifiers;
- every validity edge is compatible with the derived `inputEdges`;
- every up-to-date node has all required incoming validity proofs;
- stale nodes are not accidentally promoted to clean by validity preservation.

**Proof sketch:**

- Previous validity entries are captured before clearing.
- A previous validity edge is preserved only when both sides map through the target lookup, both final identifiers exist, both decisions are compatible with keeping the old value identity, and the dependent's derived input edges still include the dependency.
- Required incoming validity is then added for every node whose final freshness is `"up-to-date"`.
- Final validation checks unknown identifiers, compatibility with derived input edges, and required incoming validity for clean nodes.

### Theorem 7: Validity mutation logs avoid lost updates

**Claim:** Concurrent transactions modifying the same `valid[D]` array do not lose each other's add/remove/clear operations merely because they started from the same old array.

**Proof sketch:**

- Transactions record validity mutations rather than writing full arrays directly.
- At commit time, under the per-replica commit lock, each mutation list is replayed against the latest committed `valid[D]`.
- Therefore two concurrent additions to the same `valid[D]` are merged instead of one overwriting the other.
- Clear/remove/add order is still meaningful within a single transaction's mutation list; a `clear` followed by `add` within the same transaction produces a set containing only the added elements.

## Non-Goals

This spec does not cover schema migration, repair of stale dependency records, dynamic dependency
discovery, direct value replacement.
