# Flag-Based Inverse Validity Algorithm

## Purpose

The incremental graph stores materialized node records and cached values. A node may depend on other nodes, and its
computor may either produce a new value or report that the current cached value is unchanged.

The graph needs a way to decide whether a node can safely reuse its current cached value.
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
- `valid` is the inverse validity relation for cached values. `valid[D]` contains dependents `N` whose cached value is known to be valid with respect to `D`'s current cached value.

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

Question 2: If the node is only potentially-outdated, may the runtime still reuse
            its old value without calling the computor?
Answer:    Yes, iff all current inputs still validate it:
             inputEdges(N) is non-empty
             and for every D in inputEdges(N): valid[D].has(N).
           Zero-input nodes cannot pass this predicate and must recompute.
```

Distinguishing these two questions is the core of the flag-based design:

- `freshness[N]` is the **read-path state** — it decides whether the runtime can return `N` immediately.
- `valid[D]` is the proof set for up-to-date dependents and the outgoing frontier consumed by invalidation propagation.
- `valid` is also the **invalidation propagation frontier** — it identifies all up-to-date dependents that must be marked stale when `D` changes value.

## Input Terminology

There are two related but distinct concepts, both derived (not persisted per node):

**inputPositions(N)** — the ordered concrete input positions derived from the node definition and
bindings. Duplicates are preserved. This list drives recursive pulls and the argument array passed
to the computor.

Example: `inputPositions(N) = [A, A, B]` means the computor receives `[value(A), value(A), value(B)]`.

**inputEdges(N)** — the normalized structural dependency-edge list. Duplicate input positions
collapse to one edge, preserving first occurrence for deterministic ordering. This list drives the
`valid` relation (via proof restoration in `addValidityFlags`).

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
- `valid` is not the complete reverse dependency relation. It is the proof relation for up-to-date nodes and the invalidation-frontier relation.
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

#### 3. Stale-cache reuse predicate

A potentially-outdated node `N` may reuse its old cached value without running the computor
iff:

- a cached value for `N` exists;
- `inputEdges(N)` is non-empty;
- for every `D ∈ inputEdges(N)`, `N ∈ valid[D]`.

This predicate applies **only** to potentially-outdated nodes. For up-to-date nodes, the
stored value is returned directly without consulting validity flags, because the invariant
`freshness[N] === "up-to-date"` implies that all required validity flags exist in
well-formed storage.

**Zero-input nodes** have `inputEdges(N) = []`, so the predicate cannot pass.
An up-to-date zero-input node returns immediately through the freshness fast path.
A potentially-outdated zero-input node must recompute.

#### 4. Validity is allowed to be incomplete

Missing `D ⇝ N` does not mean `N` is not a structural dependent of `D`. It only means `N` does not currently have a cache proof with respect to `D`.

Therefore, operations that need the full structural graph, such as migration delete propagation, must use the derived `inputEdges`, not `valid`.

#### 5. Stale nodes may retain conditional outgoing proofs

A potentially-outdated node may still have a nonempty `valid[N]`. These outgoing validity flags
are conditional proofs for downstream nodes. They are not sufficient to return `N` itself from
cache, because `N`'s own freshness blocks that.

These flags become useful only after `N` is pulled:

- if `N` recomputes and changes value, `valid[N]` is cleared and downstream nodes remain stale;
- if `N` returns "unchanged", its own incoming proofs are restored; downstream proofs are restored only when downstream nodes recompute.

## Intuition

```
freshness decides whether a node is clean enough to return immediately.

valid decides whether a stale node's old value survived the changes that made it stale.

Invalidation changes freshness but does not erase valid proofs. A later pull may discover
that all inputs are still valid and reuse the old value.

A changed value clears outgoing validity from that node, because dependents validated against
the old value can no longer trust it.

An Unchanged result preserves outgoing validity, because the node's value did not change.
```

## Pull Algorithm

```
pull(N):

1. If freshness[N] is "up-to-date":
       require values[N] exists;
       return values[N].

2. Pull every input position of N.

3. Let inputEdges(N) be the deduplicated structural input list.

4. If N has a stored value and inputEdges(N) is non-empty
   and all incoming validity flags exist (valid[D].has(N) for all D):
       freshness[N] = "up-to-date";
       return values[N].

5. Run N's computor.

6. If the computor returns Unchanged:
       add incoming validity flags for N;
       set freshness[N] = "up-to-date";
       preserve valid[N].

7. If the computor returns a new value:
       remove old incoming validity for N;
       capture and clear valid[N];
       write the new value;
       add new incoming validity for N;
       set freshness[N] = "up-to-date";
       mark captured dependents potentially-outdated and propagate.
```

### Up-to-date fast path (step 1)

For up-to-date nodes, the stored value is returned directly without consulting validity
flags. The completeness of validity flags for up-to-date nodes is a storage invariant
enforced by writers, not the read fast path.

If the invariant is violated — an up-to-date node lacks a cached value — the
implementation throws an error. This is not a runtime recovery scenario but a
corruption/integrity check.

Zero-input nodes follow the same fast path: an up-to-date zero-input node returns its
value immediately.

### Potentially-outdated cache reuse (step 4)

A potentially-outdated node `N` may reuse its stored value without running the computor iff:

1. `N` has a stored value,
2. `inputEdges(N)` is non-empty,
3. for every `D` in `inputEdges(N)`: `valid[D].has(N)`.

Condition 2 excludes zero-input nodes. A zero-input node has no dependencies to validate
against, so the predicate cannot pass and the node must run its computor.

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

Marking a node potentially-outdated does not by itself change its cached value:

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
cached values. Marking freshness as potentially-outdated does not by itself falsify those
edge facts. On subsequent `pull`, an affected stale node pulls inputs and invokes its computor; up-to-date nodes require `valid[D].has(N)` for every input
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

For non-zero-input nodes, invalidation revokes at least one incoming validity proof and consumes outgoing proofs. The next pull invokes the computor before the node can become up-to-date.

For zero-input nodes, `inputEdges(N)` is empty, so there are no incoming validity proofs to revoke. Freshness still forces recomputation: an invalidated zero-input node always runs its computor on the next pull.

No stale-cache predicate exists: potentially-outdated nodes recompute regardless of their arity.

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
- It consumes outgoing validity frontiers to mark transitive dependents stale and revoke causal proofs.
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
- Therefore migration deletion propagation and any operation that needs all structural dependents must use the derived `inputEdges`.

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

## Strong invalidation validity semantics

Invalidation revokes validity proofs and therefore implies recomputation before an affected materialized node can become up-to-date again. Freshness records whether a materialized node may return immediately: an `up-to-date` node may return its cached value, while a `potentially-outdated` node pulls its dependencies and invokes its computor with the cached value as `oldValue`.

The `valid` relation is not a stale-cache reuse predicate. An incoming edge `valid[D].has(N)` is a proof required for `N` to be up-to-date. An outgoing set `valid[N]` is the proof frontier consumed by invalidation propagation.

Explicit invalidation of `N` marks `N` potentially-outdated, removes every incoming proof from each structural input into `N`, and consumes `N`'s outgoing validity frontier. Propagated invalidation removes the causal proof or proofs by which invalidation reached the dependent, marks the dependent potentially-outdated, and consumes that dependent's outgoing frontier. In diamonds, edge processing is separate from node expansion, so every causal edge is removed even if a downstream node is expanded only once.

A stale materialized node has no outgoing validity proofs. A stale non-source node lacks at least one incoming structural proof. Synchronization and migration preserve cached values but must not mint replacement proofs for invalidated nodes; their final replicas must satisfy the same strong-invalidation invariants before cutover.
