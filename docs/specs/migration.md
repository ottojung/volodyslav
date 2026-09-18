# Incremental Graph Migration

This document describes the **migration system** for upgrading incremental-graph database state between application versions.

> Note: this migration flow always performs a replica cutover on success. Even
> when node values appear unchanged, migrations still bump `meta/version`, so
> there is no no-op replica-switch optimization in the migration path.

## Overview

When the application version changes, any computed values stored in the previous version's namespace may become stale or structurally incompatible with the new schema. The migration system provides a strict, fail-fast API—`MigrationStorage`—that lets migration authors:

* **read** old values,
* **decide** what happens to each previously-materialized node (keep, invalidate, or delete),
* **create** new materialized nodes when the target schema requires them, and
* **traverse** the previous version's dependency graph.

A failed migration never activates the target replica. Failures before unification leave the target replica untouched. Failures after unification may leave the inactive replica written, but the active replica remains unchanged.

---

## Concepts

### Migration scope `S`

`S` is the set of all nodes materialized in the previous version. A node is materialized if and only if its identifier exists in `identifiers_keys_map`, `values`, `freshness`, and `timestamps`. A fresh node has freshness `"up-to-date"`; a stale node has freshness `"potentially-outdated"`.

After the user-supplied migration callback returns, **every node in `S` must have exactly one decision**. Missing decisions cause `UndecidedNodesError`.

### Previous-version graph edges

Traversal helpers expose dependency metadata derived from durable graph metadata:

* Dependencies are derived from the stored graph scheme and identifiers lookup.
* `listValidDependents(N)` — nodes in `valid[N]` (outgoing validity frontier).

Traversal never re-executes computors; it derives dependency edges from `global/graph_scheme` and `identifiers_keys_map`.

---

## `MigrationStorage` API

All methods are `async`.

### Decision methods

| Method | Description |
|--------|-------------|
| `get(nodeIdentifier)` | Return the previous-version value. |
| `keep(nodeIdentifier)` | Preserve node as-is in the new version. |
| `invalidate(nodeIdentifier)` | Mark the node for recomputation. |
| `delete(nodeIdentifier)` | Remove the node from the new version entirely. |
| `create(nodeKeyString, value, freshness)` | Create a new cached node (not in the previous version) in the new schema with the result of `value(nodeIdentifier)` (a `NodeIdentifier => Promise<ComputedValue>`), as its initial value. `freshness` must be `"up-to-date"` or `"potentially-outdated"`. `nodeKeyString` is a `NodeKeyString` — the semantic key by which the node will be identified in the new schema. A fresh `NodeIdentifier` is allocated automatically. |

### Traversal methods

| Method | Description |
|--------|-------------|
| `has(nodeIdentifier)` | `true` if `nodeIdentifier ∈ S`. |
| `listMaterializedNodes()` | `AsyncIterable<NodeIdentifier>` of all nodes in `S`. |
| Dependency inspection | Derived from the stored graph scheme and identifiers lookup. |
| `listValidDependents(nodeIdentifier)` | Previous-version validity frontier (returns `NodeIdentifier[]`). |
| `resolveNodeKey(nodeIdentifier)` | Resolve a `NodeIdentifier` to the parsed semantic `NodeKey` used by the previous replica, if available. |

---

## Decision rules

### Idempotency

Calling the same decision twice is allowed and has no effect, except that `create()` twice for the same target node is a conflict.

### Conflict detection

* Calling **different** decisions on the same node throws `DecisionConflictError`.
* Calling `create()` twice on the same node throws `DecisionConflictError`.
* Calling `create()` on a node that exists in the previous version throws `CreateExistingNodeError`.

### Schema compatibility

`keep`, `invalidate`, and `create` check that the node's functor and arity exist in the new schema. Incompatible nodes must be explicitly `delete`d. Violation throws `SchemaCompatibilityError`.

### Operation semantics

`keep` preserves the semantic occurrence, timestamps, freshness, and every incoming validity edge supplied by the source replay whose explicit input-key set is still compatible with the target node's direct-input set. Staleness alone does not discard incoming proof: Journal history distinguishes explicit node invalidation, occurrence-scoped stale state, proof-edge barriers, and recursive input staleness, so Journal-aware migration does not need the old conservative “stale keep loses proof” heuristic.

A kept certificate whose input-key set no longer matches the target direct-input set remains historical evidence but is not current-shape-compatible proof. Schema change may therefore remove validity because the edge/input shape genuinely changed, not merely because the kept node was stale.

**Migration-time propagated invalidation** is different: the migration callback explicitly calls `invalidate()` on a node, and the propagation runs in memory with full provenance. In that case outgoing proofs survive and freshness-only propagation preserves validity edges.

### Representation-only changes

Representation-only changes use `keep`; retained Journal records are rewritten by the version transition's canonical whole-Journal format codec as specified below and in `incremental-graph-journal-migrations.md`.

Once Journal history exists, the format codec is the single source of target representation bytes for every retained affected occurrence, selected or historical. There is no second value-producing migration decision for representation rewriting.

A pre-Journal database that would require a value-producing representation migration before Journal identity can be established is not migrated by the Journal 3 lifecycle. It must first reach a supported pre-Journal source state using software which owns that older transition, or bootstrap a supported identity state and perform the representation transition afterward under the Journal-aware codec.

### Journal format codec

Each directed database-version transition may define one pure `JournalFormatCodec`:

```text
JournalFormatCodec {
    rewriteNodeKey(sourceKey: NodeKey) -> NodeKey
    rewriteComputedValue(
        sourceKey: NodeKey,
        payload: ComputedValue
    ) -> ComputedValue
}
```

If a function is omitted, it defaults to the identity transform.

Both functions are synchronous and deterministic. They receive only their explicit arguments plus the fixed source->target migration definition; they receive no database handle, network/filesystem capability, clock, randomness, allocator, migration traversal state, or other mutable replica-local capability.

`rewriteNodeKey` changes representation only: its result must denote the same historical semantic node under the target version. It must also be **injective over the complete supported source NodeKey semantic domain**, independent of which keys one replica happens to retain.

Define `SourceNodeKeyDomain(sourceVersion)` as every distinct valid canonical semantic NodeKey which may occur in supported source-version Journal history, including keys for historical node families no longer present in the target schema. For every `K1`, `K2` in that domain:

```text
K1 != K2
    => rewriteNodeKey(K1) != rewriteNodeKey(K2)
```

This is a contract of the source->target codec definition, not a property established solely by scanning one replica's retained history. A local rewrite may still reject any collision it actually observes as defensive validation, but absence of a local collision does not prove global injectivity. A many-to-one node merge is a semantic migration, not a representation rewrite, and cannot preserve both historical node identities through this codec.

`rewriteComputedValue` likewise changes representation only and must preserve the historical semantic value represented by the source ValueEvent. Semantic creation/replacement/merging belongs to migration decisions, not to the format codec.

The whole-history rewrite pipeline is:

1. decode each retained record under the source database version into the Journal semantic model;
2. rewrite every embedded `NodeKey` with `rewriteNodeKey`, including record node keys, `ValidationBasis.input`, and `proof(V,D)` input keys;
3. for every retained `ValueEvent`, rewrite its payload with `rewriteComputedValue(sourceKey, payload)`, including non-selected values and values for node families absent from the target schema;
4. preserve `JournalRecordId`, writer sequence, contexts, AuthorityTime meaning, ValueId/reference identity, NodeIdentifier, and timestamps;
5. re-canonicalize target-format structures after rewriting — in particular, sort every ValidationBasis by the target version's canonical persisted `NodeKeyString` order; and
6. encode the transformed semantic record using the target version's canonical record encoding.

The codec is total only if that pipeline succeeds for **every retained source-version record** and the retained-domain `rewriteNodeKey` mapping is injective. Any codec throw, missing transform result, invalid target NodeKey/value representation, collision of two distinct retained source NodeKeys onto one target NodeKey, or other inability to produce the required target semantic record makes the source->target transition incompatible and fails `JournalVersionCompatibilityError` before cutover.

Two replicas applying the same source->target transition to the same historical record must therefore produce the same target-format record body.

`invalidate` preserves the cached value if it exists, marks nodes as `"potentially-outdated"`, and preserves `modifiedAt`.

**Explicit invalidation** removes only the explicitly named node's incoming validity proofs. Its outgoing proofs remain intact because its stored semantic value has not changed.

**Propagated invalidation** (automatic recursive propagation) preserves all validity proofs — both incoming and outgoing. It is freshness-only: downstream nodes are marked stale but retain their complete proof sets.

`create(..., "up-to-date")` is a clean-cache assertion. The migration validates this assertion before writing the migrated state.
`create(..., "potentially-outdated")` seeds a cached value without claiming it is clean.

### Propagation rules

#### INVALIDATE → propagate INVALIDATE downstream

When a node is invalidated, all its dependents are automatically marked `INVALIDATE` (recursively), unless they are already `DELETE`d. If a dependent already has a `KEEP` decision, `DecisionConflictError` is thrown immediately.

#### DELETE → propagate DELETE downstream (deferred, dependency-closed)

DELETE propagation runs at finalization (after the callback returns), via a BFS over dependents. One deleted input is sufficient to delete an undecided dependent, and that deletion propagates through every transitive materialized dependent.

This preserves the materialization invariant that every materialized node has all of its concrete inputs materialized. If a dependent already has an explicit `KEEP` or `INVALIDATE` decision, `DecisionConflictError` is thrown.

---

## Error types

| Error class | When thrown |
|-------------|------------|
| `DecisionConflictError` | Two different decisions assigned to the same node. |
| `CreateExistingNodeError` | `create()` called for a node that already exists in the previous version. |
| `UndecidedNodesError` | Some nodes in `S` have no decision after the callback. |
| `SchemaCompatibilityError` | `keep`/`invalidate`/`create` on a node absent from the new schema. |
| `InvalidMigrationDecisionError` | `create` violates its semantic/cache-state contract. |
| `GetMissingNodeError` | `get()`/traversal called for a node not in `S`. |
| `MissingDependencyMetadataError` | A materialized node has missing or corrupted dependency metadata. |

Journal-format-codec failure is not a migration-decision error; it is `JournalVersionCompatibilityError` under the Journal 3 lifecycle.

---

## Running a migration

Use `runMigration()` from the `incremental_graph` module:

```js
const { runMigration } = require('./generators/incremental_graph');

await runMigration(rootDatabase, newVersionNodeDefs, async (storage) => {
    for await (const nodeIdentifier of storage.listMaterializedNodes()) {
        // Decide what to do with each node
        if (shouldKeep(nodeIdentifier)) {
            await storage.keep(nodeIdentifier);
        } else {
            await storage.delete(nodeIdentifier);
        }
    }
});
```

`runMigration` will:

1. Detect the previous version by examining stored schema namespaces.
2. Create a `MigrationStorage` backed by the previous version's data.
3. Execute the callback.
4. Call `finalize()` internally (propagate deletes, check completeness).
5. Apply all decisions **atomically** to the new version's storage.

If no previous version is found, the migration is a no-op.

---

## Atomicity guarantee

Decisions are collected in memory during the callback. The desired state is unified into the target replica's storage, then validated with `assertValidFinalMergeState` before the replica pointer is switched. A failed migration never activates the target replica. Failures before unification leave the target replica untouched. Failures after unification may leave the inactive replica written, but the active replica remains unchanged.