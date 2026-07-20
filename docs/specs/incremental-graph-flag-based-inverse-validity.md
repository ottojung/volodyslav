# Flag-Based Inverse Validity Algorithm

## Purpose

The incremental graph stores materialized node records and cached values. A node may depend on other nodes, and its
computor may either produce a new value or report that the current cached value is unchanged.

The graph needs a way to decide whether a node can safely reuse its current cached value.
This specification uses a single inverse edge-validity relation (`valid`) as both the incoming proof relation for up-to-date dependents and the outgoing invalidation propagation frontier.

## Fixed Model

The schema is fixed for the lifetime of one `IncrementalGraph` instance. A node's concrete input
list is determined by the node definition, its bindings, and the compilation/instantiation logic.

The computor does **not** discover dependencies at runtime. It receives already-pulled input values.
It does not receive a dependency-registration API, and it does not return a dependency list.

Only successful `pull` / recompute operations may write `values[N]`. There is no direct value
replacement operation in this algorithm.

## State

```
identifiers_keys_map : Map<NodeIdentifier, NodeKeyString>
values               : Map<NodeIdentifier, Value>
freshness            : Map<NodeIdentifier, "potentially-outdated" | "up-to-date">
timestamps           : Map<NodeIdentifier, { createdAt: ISOString, modifiedAt: ISOString }>
valid                : Map<NodeIdentifier, Array<NodeIdentifier>>
```

- `identifiers_keys_map`, `values`, `freshness`, and `timestamps` share the same key set. A materialized node is exactly a cached node.
- `values` is cached value storage.
- `freshness` is the total materialized-node freshness table.
- `timestamps` is the total materialized-node timestamp table. `createdAt` is when the materialized node identity was first created; `modifiedAt` is a version timestamp for the stored semantic value (it advances only when the semantic value changes, not when freshness, validity, or other record metadata changes).
- `valid` is the inverse proof relation for up-to-date cached values. `valid[D]` contains dependents `N` whose current cached value has a proof with respect to `D`'s current cached value; `valid[D]` is also the outgoing frontier traversed when `D` is invalidated.

Terminology:

```text
unmaterialized node = semantic node with no identifier and no cached value
materialized node   = semantic node whose identifier exists in identifiers_keys_map, values, freshness, and timestamps
fresh node          = materialized node with freshness == "up-to-date"
stale node          = materialized node with freshness == "potentially-outdated"
```

Storage invariants:

```text
IdSet = keys(identifiers_keys_map)

keys(values)     == IdSet
keys(freshness)  == IdSet
keys(timestamps) == IdSet
keys(valid)      ⊆ IdSet

freshness[id] == "potentially-outdated" => id ∈ IdSet
freshness[id] == "up-to-date"           => id ∈ IdSet

valid[D] contains N =>
  D ∈ keys(values)
  N ∈ keys(values)
  D is a derived input edge of N
```

There is no persisted per-node input storage. Structural dependency edges are derived from the
stored `graph_scheme`, the `identifiers_keys_map`, and the node's semantic key.

## Two Questions

The algorithm answers two separate questions for every materialized node `N`:

```
Question 1: May the runtime return this node immediately?
Answer:    Yes, iff freshness[N] === "up-to-date" and values[N] exists.
           Validity flags are not consulted. The completeness of validity flags for
           up-to-date nodes is a storage invariant enforced by writers, not the read path.

Question 2: If the node is only potentially-outdated, may the runtime return
             its old value without calling the computor?
Answer:    Yes, iff all current inputs still validate it:
             values[N] exists,
             inputEdges(N) is non-empty,
             and for every D in inputEdges(N): valid[D].has(N).
           Zero-input nodes cannot pass this predicate and must recompute.
```

Distinguishing these two questions is the core of the flag-based design:

- `freshness[N]` is the **read-path state** — it decides whether the runtime can return `N` immediately.
- `valid[D]` is the **incoming proof set** for up-to-date dependents and the **outgoing proof frontier** traversed by invalidation propagation.
- `valid` is also the **invalidation propagation frontier** — it identifies all up-to-date dependents that must be marked stale when `D` changes value.

## Input Terminology

There are two related but distinct concepts, both derived (not persisted per node):

**inputPositions(N)** — the ordered concrete input positions derived from the node definition and
bindings. Duplicates are preserved. This list drives recursive pulls and the argument array passed
to the computor.

Example: `inputPositions(N) = [A, A, B]` means the computor receives `[value(A), value(A), value(B)]`.

**inputEdges(N)** — the normalized structural dependency-edge list. Duplicate input positions
collapse to one edge, preserving first occurrence for deterministic ordering. This list drives the
`valid` relation (via proof restoration in the `addValidityFlags` helper).

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
- Materialized nodes form a dependency-closed set: for every materialized `N`, every `D ∈ inputEdges(N)` is materialized.
- Every entry `N ∈ valid[D]` implies `D ∈ inputEdges(N)` and both endpoints are materialized nodes.
- No `valid` entry points to discarded identifiers after merge or migration.

No reverse invariants are enforced for stale nodes. A stale node may retain complete incoming proofs when its staleness was propagated rather than caused by a value change. It may retain nonempty outgoing validity because its stored value has not changed.

## Correctness model for "valid"

### Terminology

- A **structural edge** `D -> N` exists iff `D ∈ inputEdges(N)`.
- A **validity edge** `D ⇝ N` exists iff `N ∈ valid[D]`.
- `inputEdges` is the derived structural dependency relation across all materialized nodes.
- `valid` is not the complete reverse dependency relation. It is the proof relation for up-to-date dependents and the invalidation-frontier relation.
- `valid[D]` is the **outgoing validity frontier** of `D`: the nodes whose cached values are still provably valid with respect to `D`'s current stored value.
- The **incoming validity proofs** of a node `N` are the edges `D ⇝ N` for every `D ∈ inputEdges(N)`.
- `valid[D].has(N)` does **not** mean `N` structurally depends on `D` in general. It means the currently stored value of `N` has a proof with respect to the currently stored value of `D`. The structural dependency relation is `inputEdges(N)`, derived from `graph_scheme` and `identifiers_keys_map`.

### Invariants

#### 1. Structural soundness of validity

If `N ∈ valid[D]`, then both identifiers are materialized identifiers and `D ∈ inputEdges(N)`.

This prevents validity edges from pointing to nonexistent nodes or to nodes that do not structurally depend on the key.

#### 2. Clean-node validity invariant

For every materialized node `N`:

If `freshness[N] === "up-to-date"`, then:
- `values[N]` exists;
- every `D` in `inputEdges(N)` is materialized;
- `freshness[D] === "up-to-date"`;
- `N ∈ valid[D]`.

This invariant is maintained by writers (`handleUnchanged`, `handleChanged`), sync merge validity
rebuild, migration, and final validation. The pull fast path does not re-check `valid[D].has(N)`
for an up-to-date node — it relies on the invariant being enforced by mutation paths.

#### 3. Stale-node semantics

For every materialized node `N`:

- `freshness[N]` decides whether N may return immediately (`up-to-date`) or must revalidate.
- `valid[N]` is the outgoing proof frontier. A stale node may have nonempty `valid[N]` because its stored semantic value has not changed.
- `valid[D].has(N)` is an incoming proof. A stale node may retain complete incoming proofs when its staleness was recursively propagated rather than caused by a value change in a dependency.

A stale node's next pull:

1. Pulls every input position.
2. If `values[N]` exists, `inputEdges(N)` is non-empty, and every incoming proof `valid[D].has(N)` is present: cache-revalidate (mark `up-to-date`, return cached value).
3. Otherwise invokes `N`'s computor.

Zero-input stale nodes have no incoming proofs to check and always invoke their computor.

#### 4. Validity is allowed to be incomplete

Missing `D ⇝ N` does not mean `N` is not a structural dependent of `D`. It only means `N` does not currently have a cache proof with respect to `D`.

Therefore, operations that need the full structural graph, such as migration delete propagation, must use the derived `inputEdges`, not `valid`.

#### 5. Stale nodes may retain outgoing proofs

A stale node may have a nonempty `valid[N]` outgoing frontier because its stored semantic value has not changed. These outgoing proofs remain meaningful for downstream cache revalidation: when a downstream node later recomputes, it checks its incoming proofs, and if `valid[N].has(dependent)` survived, the dependent may cache-revalidate without invoking its own computor.

Recursive invalidation propagates freshness only, without removing validity edges. When `N` recomputes and returns `Unchanged`, the runtime restores `N`'s incoming proofs and marks `N` up-to-date. Outgoing proofs from `N` to dependents that were preserved through the invalidation remain available; each downstream dependent checks its own incoming proofs when it later pulls.

## Intuition

```
freshness decides whether a node is clean enough to return immediately.

valid records proofs for up-to-date dependents and provides the frontier traversed by invalidation propagation.

Explicit invalidation removes the named node's incoming proofs (forcing recomputation).
Recursive invalidation propagates freshness only — validity edges are preserved.

A changed value clears outgoing validity from that node, because dependents validated against
the old value can no longer trust it.

An Unchanged result preserves the node's cached value, restores its incoming proofs,
and preserves its outgoing proofs. Downstream dependents may cache-revalidate through
preserved incoming proofs.
```

## Pull Algorithm

```
pull(N):

1. If freshness[N] is "up-to-date":
       require values[N] exists;
       return values[N].

2. Pull all input nodes recursively.

3. Let inputEdges(N) be the deduplicated structural input list.

4. If values[N] exists
   and inputEdges(N) is non-empty
   and for every D in inputEdges(N): valid[D].has(N):
       freshness[N] = "up-to-date";
       return values[N].

5. Run N's computor with the pulled input values and values[N] as oldValue.

6. If the computor returns Unchanged:
       require oldValue exists;
       add incoming validity flags for N;
       set freshness[N] = "up-to-date".

7. If the computor returns a new value:
       remove old incoming validity for N;
       capture and clear valid[N];
       write the new value;
       mark captured dependents stale and propagate freshness transitively;
       add new incoming validity flags for N;
       set freshness[N] = "up-to-date".
```

## Up-to-date fast path (step 1)

For up-to-date nodes, the stored value is returned directly without consulting validity
flags. The completeness of validity flags for up-to-date nodes is a storage invariant
enforced by writers, not the read fast path.

If the invariant is violated — an up-to-date node lacks a cached value — the
implementation throws an error. This is not a runtime recovery scenario but a
corruption/integrity check.

Zero-input nodes follow the same fast path: an up-to-date zero-input node returns its
value immediately.

### Potentially-outdated cache revalidation

A potentially-outdated node `N` pulls all dependencies. If `N` has a cached value, has at least one input, and every incoming validity proof is still present, `N` may reuse its cached value without invoking the computor (cache revalidation). Otherwise the computor is invoked with the pulled input values and the cached value as `oldValue`.

## Handling `Unchanged`

When the computor returns `Unchanged`, the cached value of `N` did not change.

```
handleUnchanged(N, inputEdges):

require N has a cached value

for every D in inputEdges:
    valid[D].add(N)

freshness[N] = "up-to-date"
```

- `values[N]` is unchanged.
- `valid[N]` is not cleared — outgoing proofs from `N` to dependents remain valid.
- Downstream dependents may later cache-revalidate through the preserved `valid[N]` proofs.

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
    freshness[M] = "potentially-outdated"
    propagate freshness through valid[M] without removing validity
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

### External invalidation without value change (explicit invalidation)

```
invalidate(N):

if N is not materialized:
    return

freshness[N] = "potentially-outdated"

for every D in inputEdges(N):
    valid[D].remove(N)

for every M in snapshot(valid[N]):
    freshness[M] = "potentially-outdated"
    propagate freshness through valid[M] without removing validity
```

The next pull supplies the cached value as `oldValue`, pulls dependencies, and checks incoming proofs. Since `N`'s incoming proofs were removed, the cache predicate fails and the computor is invoked.

### Explicit and propagated invalidation

Explicit invalidation removes every incoming proof for the root node, guaranteeing that its next pull invokes the computor.

Propagated invalidation is freshness-only: it marks downstream nodes stale but preserves all validity edges. A downstream node reached through propagation retains its incoming proofs and may cache-revalidate when later pulled.

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
commit changes to `valid` for `N` until the computor result has been accepted. All
mutations to `valid`, `values`, and `freshness` caused by recomputing `N`
must be committed only after the computor successfully returns a valid result.

If the computor throws or returns an invalid value:

- do not write `values[N]`,
- do not add validity flags,
- do not mark `freshness[N]` as up-to-date,
- do not partially mutate structural metadata for `N`.

Dependency pulls may already have committed independently according to the existing transaction
model. That is acceptable, but `N`'s own recomputation effects must not be partially committed.

Persisted structural records for `N` are created or refreshed only after `N` is successfully
materialized or successfully validated. On an up-to-date fast path, do not rewrite structural records merely
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

1. Transports compatible `valid` entries from both source sides where provenance, value identity,
   and structural compatibility justify preserving the exact proof.
2. Identifies **direct invalidation roots**: nodes whose decision is `invalidate`, equal-version
   staleness, host-only invalidation, or any up-to-date node whose required incoming proof could
   not be transported. All incoming proofs are removed from each direct root.
3. Propagates stale freshness from each direct root through the transported validity frontier
   without removing traversed validity edges. Descendants reached through propagated staleness
   retain all incoming and outgoing proofs.
4. Removes entries for deleted or discarded identifiers.
5. Entries whose dependent no longer exists or whose derived input edges no longer contain the
   dependency are removed.

### Migration

Migration rebuilds `valid` from the final migrated graph state:

- `create` nodes marked `up-to-date` receive incoming valid flags for their current derived inputs because the migration callback supplies an up-to-date value.
- `create` nodes marked `potentially-outdated` receive no incoming valid flags.
- `override` and `keep` nodes preserve incoming valid flags when previous proof, schema compatibility, value identity, and freshness rules justify preserving that exact proof.
- **Explicit `invalidate`** nodes receive no incoming valid flags. Outgoing proofs from the explicitly invalidated node to its dependents survive when structurally and semantically transportable.
- **Propagated `invalidate`** nodes preserve all historical incoming and outgoing proofs subject to normal structural compatibility and endpoint survival. Propagated invalidation changes freshness only.
- `delete` nodes do not appear in `valid`.
- Any `valid` entry pointing to a deleted identifier is absent after migration.

The migration path validates the target replica before activating it, checking the invariants
described in the Invariants section above.

## Proof Sketches

### Theorem 1: Cache safety

**Claim:** If `pull(N)` returns a cached value for `N`, then every current dependency value used to justify that cache is the same stored value relative to which `N` was last validated.

**Proof sketch:**

- A direct fast-path cache return requires `freshness[N] === "up-to-date"`.
- The invariant `freshness[N] === "up-to-date"` implies all incoming validity proofs exist
  (by the writer contract: handleUnchanged and handleChanged always write validity flags
  before marking up-to-date).
- In the potentially-outdated recompute path, dependencies are pulled before `N` checks
  whether it can become up-to-date. Recalculation restores all incoming validity
  proofs.
- Therefore `N` cannot be returned merely because some old outgoing validity edge exists.
  Its own freshness and incoming validity must be established.

### Theorem 2: Changed values revoke downstream authorization

**Claim:** If a node `D` is recomputed and its value changes, then cached values depending on the old value of `D` cannot be returned as clean without recomputation or proof repair.

**Proof sketch:**

- On changed result, the algorithm reads `valid[D]` as the downstream frontier.
- It clears `valid[D]`.
- It marks direct downstream nodes potentially-outdated.
- It propagates stale freshness through outgoing validity frontiers to mark transitive dependents stale.
- Since `valid[D]` is cleared, any direct dependent requiring `D ⇝ N` cannot be up-to-date until it recomputes and re-establishes the proof.

### Theorem 3: Preserved outgoing proofs authorize downstream cache revalidation

**Claim:** A stale node `N` with preserved outgoing proofs `valid[N]` may authorize a dependent to cache-revalidate without invoking its own computor, provided the dependent's incoming proofs survive.

**Proof sketch:**

- Recursive invalidation propagates freshness without removing validity edges.
- `Unchanged` preserves `valid[N]`; dependents still have `valid[N].has(dependent)`.
- When a downstream dependent later pulls, it checks its incoming proofs. If `valid[N].has(dependent)` survived, the dependent may cache-revalidate.

### Theorem 4: Runtime invalidation can use "valid" as a frontier

**Claim:** For runtime invalidation of a changed or potentially changed node, walking `valid[D]` is sufficient to find clean cached nodes that need to be marked stale.

**Proof sketch:**

- By the required incoming validity invariant (enforced by writers, not the read path), any up-to-date node `N` structurally depending on `D` must have `N ∈ valid[D]`.
- Therefore every clean dependent that can be returned from cache is on the `valid` frontier.
- If a structural dependent is absent from `valid[D]`, it already lacks the causal proof for that dependency.
- Therefore it does not need to be discovered through `valid[D]`; operations that need all structural dependents use `inputEdges`.

This theorem is about runtime cache invalidation, not about structural graph operations.

### Theorem 5: "valid" is not a structural graph replacement

**Claim:** `valid` is safe as an up-to-date proof relation and runtime invalidation frontier, but it is not safe as the complete structural reverse dependency graph.

**Proof sketch:**

- Stale nodes may lack some incoming validity proofs.
- Missing validity does not imply missing structural dependency.
- Therefore migration deletion propagation and any operation that needs all structural dependents must use the derived `inputEdges`.

Document this explicitly because it prevents a future reader from treating `valid` as a renamed reverse-dependency index.

### Theorem 6: Merge validity reconstruction preserves soundness

**Claim:** After sync merge validity reconstruction, the final state satisfies:

- every `valid[D]` entry points only to known identifiers;
- every validity edge is compatible with the derived `inputEdges`;
- every up-to-date node has all required incoming validity proofs;
- stale nodes are not accidentally promoted to clean by proof reconstruction.

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
