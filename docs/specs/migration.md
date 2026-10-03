# Incremental Graph Migration

This document describes the **migration system** for upgrading incremental-graph database state between application versions.

## Scope: this is the pre-Journal `MigrationStorage` API

This document owns the materialized-node migration API described by
`MigrationStorage`: scope `S`, the per-node decisions, propagation, and
`runMigration`. That API is still the implemented migration path in
`migration_storage_class.js`, `migration_decisions.js`, and `migration_runner.js`.

Journal 3 adds a second, different mechanism beside it. When a database-version
transition changes the persisted representation of Journal records themselves, the
rewrite is owned by the Journal-aware `JournalFormatCodec` described in
`incremental-graph-journal-migrations.md`, not by this document. The two do not
overlap: this API migrates materialized nodes of a replica whose format is not being
rewritten; that codec rewrites retained Journal history in place, preserving record
identities and historical meaning.

A pre-Journal source that requires semantic, time, or allocator-dependent migration
before Journal identity exists is bootstrap-incompatible rather than migratable, and
startup fails it by name. `incremental-graph-journal-migrations.md` states that rule and
the `JournalVersionCompatibilityError` it raises.

## Startup ordering

Migration is one of two gates. Startup runs them in this order, and ordinary
synchronization runs after both:

1. the migration gate, described below;
2. the canonical-bootstrap gate — `runCanonicalBootstrapGate`, re-exported from
   `incremental_graph/index.js` and called by `interface/lifecycle.js` between the
   migration gate and `createIncrementalGraph`. A replica that is fresh, empty, or
   already retains Journal records is left alone; a supported pre-Journal replica has a
   canonical cut installed and its replica pointer moved; an indeterminate cohort answer
   installs nothing and raises `UnresolvedCanonicalBootstrapError`.

Synchronization does not perform either gate. A fixture or deployment that represents
pre-Journal state supplies its own `CohortBootstrapSource`, because that transport is
deployment configuration rather than persisted database state.

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

### `override` is retained API, and this is a known gap

`incremental-graph-journal-checklist.md` §16a requires the legacy `override` API,
`OverrideConflictError`, and `override` decision documentation to be deleted from this
document when the code path is deleted. The code path still exists:
`migration_storage_class.js` defines `override()`, `migration_decisions.js` declares the
`override` decision variant, and `migration_errors.js` defines
`OverrideConflictError` and `InvalidMigrationDecisionError`.

The requirement is therefore **not discharged**, and this section is deliberately left in
place rather than deleted ahead of the code. Two properties make that the honest state:

* `override` is still callable, so removing its documentation would leave a live,
  undocumented public method on `MigrationStorage`;
* the Journal-aware replacement is not a drop-in substitute. `JournalFormatCodec` is a
  pure directed source→target rewrite over retained history, and it does not accept a
  per-node callback that is told the previous-version node value. `override` also carries
  a cache-state proof requirement (`InvalidMigrationDecisionError`), which the codec
  does not express.

When the `override` path is deleted from the source, this section, the `override` row in
the decision-method table, the `OverrideConflictError` and `InvalidMigrationDecisionError`
rows in the error table, and the idempotency exception that names `override` must be
deleted in the same change.

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
