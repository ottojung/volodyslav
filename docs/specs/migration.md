# Incremental Graph Migration

This document describes the **migration system** for upgrading incremental-graph database state between application versions.

> Note: this migration flow always performs a replica cutover on success. Even
> when node values appear unchanged, migrations still bump `meta/version`, so
> there is no no-op replica-switch optimization in the migration path.

## Overview

When the application version changes, any computed values stored in the previous version's namespace may become stale or structurally incompatible with the new schema.  The migration system provides a strict, fail-fast API—`MigrationStorage`—that lets migration authors:

* **read** old values,
* **decide** what happens to each previously-materialized node (keep, override, invalidate, or delete),
* **traverse** the previous version's dependency graph.

A failed migration never activates the target replica.  Failures before unification leave the target replica untouched.  Failures after unification may leave the inactive replica written, but the active replica remains unchanged.

---

## Concepts

### Migration scope `S`

`S` is the set of all nodes materialized in the previous version. A node is materialized if and only if its identifier exists in `identifiers_keys_map`, `values`, `freshness`, and `timestamps`. A fresh node has freshness `"up-to-date"`; a stale node has freshness `"potentially-outdated"`.

After the user-supplied migration callback returns, **every node in `S` must have exactly one decision**.  Missing decisions cause `UndecidedNodesError`.

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
| `override(nodeIdentifier, value)` | Rewrite an existing cached value with the result of `value(nodeIdentifier)` (a `NodeIdentifier => Promise<ComputedValue>`), while preserving its cache-state proof envelope. |
| `invalidate(nodeIdentifier)` | Mark the node for recomputation. |
| `delete(nodeIdentifier)` | Remove the node from the new version entirely. |
| `create(nodeKeyString, value, freshness)` | Create a new cached node (not in the previous version) in the new schema with the result of `value(nodeIdentifier)` (a `NodeIdentifier => Promise<ComputedValue>`) as its initial value. `freshness` must be `"up-to-date"` or `"potentially-outdated"`. `nodeKeyString` is a `NodeKeyString` — the semantic key by which the node will be identified in the new schema. A fresh `NodeIdentifier` is allocated automatically. |

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

Calling the same decision twice (except for `override` and `create`) is allowed and has no effect.

### Conflict detection

* Calling **different** decisions on the same node throws `DecisionConflictError`.
* Calling `override()` more than once on the same node throws `OverrideConflictError`.
* Calling `create()` twice on the same node throws `DecisionConflictError`.
* Calling `create()` on a node that exists in the previous version throws `CreateExistingNodeError`.

### Schema compatibility

`keep`, `override`, `invalidate`, and `create` check that the node's functor and arity exist in the new schema.  Incompatible nodes must be explicitly `delete`d.  Violation throws `SchemaCompatibilityError`.

### Operation semantics

`keep` preserves the value, freshness, timestamps, and — for up-to-date nodes — compatible incoming validity. A stale node carried through `keep` loses its incoming proofs: persisted storage does not encode whether its staleness was explicit or propagated, so it is conservatively treated as a direct invalidation root.

Within a **preexisting stale `keep`/`override` region**, every stale node loses incoming proofs, so validity edges inside the region may disappear. A stale B whose dependent C is also stale loses both `A⇝B` and `B⇝C` during migration, and both nodes must recompute.

**Migration-time propagated invalidation** is different: the migration callback explicitly calls `invalidate()` on a node, and the propagation runs in memory with full provenance. In that case outgoing proofs survive and freshness-only propagation preserves validity edges.

`override` is a **semantic-preserving representation rewrite**. It changes the stored representation (e.g. on-disk format) while preserving the semantic value as seen by dependents. Because the value is semantically unchanged, `override()` does not propagate invalidation — it inherits freshness, timestamps, and validity from the old record. The same stale-node rule applies: a stale node carried through `override` loses its incoming proofs.

`override()` MUST NOT be used when the migration changes the meaning or value of a node. If the value itself changes, use `invalidate()` instead, which triggers downstream recomputation so that dependents observe the new value.

The intended use case is format migration: the database version changes the serialization format but the represented value is still meaningfully the same value. In that scenario missing invalidation in `override()` is correct by design — not a bug.

#### Replica-stability of identity-preserving override

An `override()` which preserves the identity of an existing semantic value occurrence MUST be replica-stable. Given two supported replicas which represent the same pre-migration semantic value occurrence and run the same migration into the same target database/schema version, the override must produce the same exact post-migration payload and `modifiedAt` on both replicas.

The legacy `createdAt` field is excluded from this requirement. It is node-scoped metadata for the current materialization/head lineage, not part of the identity of one value occurrence. For database versions using Journal 2, synchronization retains it in the node summary and merges it by the head-scoped rule in `incremental-graph-journal-projection.md`; it may move earlier for a fixed selected head or later when head selection changes.

This requirement is about the value-occurrence output, not merely about programmer intent. The transformation may receive a physical `NodeIdentifier`, but it MUST NOT allow differences in that identifier, hostname, local wall clock, randomness, mutable host-local state, external service state, iteration order, or other replica-local inputs to make one preserved semantic occurrence migrate to different post-migration payloads or `modifiedAt` values. Any such migration is not a semantic-preserving representation rewrite in the sense required by `override()`.

For a Journal-2-aware migration this rule is load-bearing: `override()` preserves the existing `ValueId`, and one `ValueId` denotes one exact semantic value occurrence. Synchronization is therefore allowed to assume that replicas carrying the same `ValueId` also carry the same migrated payload and `modifiedAt` without comparing payloads.

If a transformation cannot guarantee replica-stable output, it MUST NOT use identity-preserving `override()`. The migration must instead model the result as a semantic replacement which receives a new value identity under the version's migration rules, or invalidate/delete the old cache so ordinary recomputation creates the replacement. The generic `MigrationStorage` API does not turn an arbitrary host-dependent override into a safe identity-preserving rewrite.

`invalidate` preserves the cached value if it exists, marks nodes as `"potentially-outdated"`, and preserves `modifiedAt`.

**Explicit invalidation** removes only the explicitly named node's incoming validity proofs. Its outgoing proofs remain intact because its stored semantic value has not changed.

**Propagated invalidation** (automatic recursive propagation) preserves all validity proofs — both incoming and outgoing. It is freshness-only: downstream nodes are marked stale but retain their complete proof sets.

`create(..., "up-to-date")` is a clean-cache assertion. The migration validates this assertion before writing the migrated state.
`create(..., "potentially-outdated")` seeds a cached value without claiming it is clean.

### Propagation rules

#### INVALIDATE → propagate INVALIDATE downstream

When a node is invalidated, all its dependents are automatically marked `INVALIDATE` (recursively), unless they are already `DELETE`d.  If a dependent already has a `KEEP` or `OVERRIDE` decision, `DecisionConflictError` is thrown immediately.

#### DELETE → propagate DELETE downstream (deferred, dependency-closed)

DELETE propagation runs at finalization (after the callback returns), via a BFS over dependents. One deleted input is sufficient to delete an undecided dependent, and that deletion propagates through every transitive materialized dependent.

This preserves the materialization invariant that every materialized node has all of its concrete inputs materialized. If a dependent already has an explicit `KEEP`, `OVERRIDE`, or `INVALIDATE` decision, `DecisionConflictError` is thrown.

---

## Error types

| Error class | When thrown |
|-------------|------------|
| `DecisionConflictError` | Two different decisions assigned to the same node. |
| `OverrideConflictError` | `override()` called more than once on the same node. |
| `CreateExistingNodeError` | `create()` called for a node that already exists in the previous version. |
| `UndecidedNodesError` | Some nodes in `S` have no decision after the callback. |
| `SchemaCompatibilityError` | `keep`/`override`/`invalidate`/`create` on a node absent from the new schema. |
| `InvalidMigrationDecisionError` | `override` or `create` called without the cache-state proof required by its API. |
| `GetMissingNodeError` | `get()`/traversal called for a node not in `S`. |
| `MissingDependencyMetadataError` | A materialized node has missing or corrupted dependency metadata. |

---

### Migration version identity

The migration lifecycle already supplies the exact persisted source database version and the exact running target database version. Those two values identify the declared version transition; `runMigration()` does not accept or allocate a separate migration registry ID.

For database versions using Journal 2, the historical `MigrationId` stored in an optional high-level migration operation record is exactly `{ fromVersion, toVersion }` as defined in `incremental-graph-journal-types.md`. It is derived from lifecycle version metadata, not from callback identity, registration order, or an additional migration registry. If two migrations would need incompatible semantics while claiming the same source and target version, the versioning contract itself is insufficiently specific and the target database version must change.

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

Decisions are collected in memory during the callback.  The desired state is unified into the target replica's storage, then validated with `assertValidFinalMergeState` before the replica pointer is switched.  A failed migration never activates the target replica.  Failures before unification leave the target replica untouched.  Failures after unification may leave the inactive replica written, but the active replica remains unchanged.
