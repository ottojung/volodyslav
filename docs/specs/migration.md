# Incremental Graph Migration

This document describes the **migration system** for upgrading incremental-graph database state between application versions.

## Overview

When the application version changes, any computed values stored in the previous version's namespace may become stale or structurally incompatible with the new schema.  The migration system provides a strict, fail-fast API—`MigrationStorage`—that lets migration authors:

* **read** old values,
* **decide** what happens to each previously-materialized node (keep, override, invalidate, or delete),
* **traverse** the previous version's dependency graph.

All writes are applied atomically.  If anything goes wrong during planning or validation, the new version's namespace remains unmodified.

---

## Concepts

### Migration scope `S`

`S` is the set of all nodes materialized in the previous version.  A node is materialized if it has an entry in the `inputs` database (even if no computed value was stored).

After the user-supplied migration callback returns, **every node in `S` must have exactly one decision**.  Missing decisions cause `UndecidedNodesError`.

### Previous-version graph edges

Traversal helpers expose the **persisted** dependency metadata:

* `getInputs(N)` — the inputs `N` last depended on.
* `getDependents(N)` — reverse edges: nodes that depended on `N`.

Traversal never re-executes computors; it only reads stored metadata.

---

## `MigrationStorage` API

All methods are `async`.

### Decision methods

| Method | Description |
|--------|-------------|
| `get(nodeKey)` | Return the previous-version value. |
| `keep(nodeKey)` | Preserve node as-is in the new version. |
| `override(nodeKey, value)` | Replace the node's value with `value`. |
| `invalidate(nodeKey)` | Mark the node for recomputation. |
| `delete(nodeKey)` | Remove the node from the new version entirely. |
| `create(nodeKey, value)` | Create a new node (not in the previous version) in the new schema with `value` as its initial value. |

### Traversal methods

| Method | Description |
|--------|-------------|
| `has(nodeKey)` | `true` if `nodeKey ∈ S`. |
| `listMaterializedNodes()` | `AsyncIterable<NodeKeyString>` of all nodes in `S`. |
| `getInputs(nodeKey)` | Previous-version inputs list. |
| `getDependents(nodeKey)` | Previous-version dependents list. |

---

## Decision rules

### Idempotency

Calling the same decision twice (except for same-value `override` and `create`) is allowed and has no effect.

### Conflict detection

* Calling **different** decisions on the same node throws `DecisionConflictError`.
* Calling `override()` twice with **different values** throws `OverrideConflictError`.
* Calling `create()` twice on the same node throws `DecisionConflictError`.
* Calling `create()` on a node that exists in the previous version throws `CreateExistingNodeError`.

### Schema compatibility

`keep`, `override`, `invalidate`, and `create` check that the node's functor and arity exist in the new schema.  Incompatible nodes must be explicitly `delete`d.  Violation throws `SchemaCompatibilityError`.

### Propagation rules

#### OVERRIDE / INVALIDATE → propagate INVALIDATE downstream

When a node is overridden or invalidated, all its dependents are automatically marked `INVALIDATE` (recursively), unless they are already `DELETE`d.  If a dependent already has a `KEEP` or `OVERRIDE` decision, `DecisionConflictError` is thrown immediately.

#### DELETE → propagate DELETE downstream (deferred, fan-in strict)

DELETE propagation runs at finalization (after the callback returns), via a BFS over dependents:

* A dependent `D` is auto-deleted only if **all** of `D`'s inputs are deleted.
* If `D` has some-but-not-all inputs deleted, `PartialDeleteFanInError` is thrown.

This means that to delete a fan-in node `D = f(B, C)`, both `B` and `C` must be deleted (directly or via propagation).

---

## Error types

| Error class | When thrown |
|-------------|------------|
| `DecisionConflictError` | Two different decisions assigned to the same node. |
| `OverrideConflictError` | `override()` called twice with different values. |
| `CreateExistingNodeError` | `create()` called for a node that already exists in the previous version. |
| `UndecidedNodesError` | Some nodes in `S` have no decision after the callback. |
| `PartialDeleteFanInError` | DELETE propagation reaches a fan-in node not all of whose inputs are deleted. |
| `SchemaCompatibilityError` | `keep`/`override`/`invalidate`/`create` on a node absent from the new schema. |
| `GetMissingNodeError` | `get()`/traversal called for a node not in `S`. |
| `GetMissingValueError` | `get()` called for a node in `S` with no computed value. |
| `MissingDependencyMetadataError` | A materialized node has missing or corrupted inputs metadata. |

---

## Running a migration

Use `runMigration()` from the `incremental_graph` module:

```js
const { runMigration } = require('./generators/incremental_graph');

await runMigration(rootDatabase, newVersionNodeDefs, async (storage) => {
    for await (const nodeKey of storage.listMaterializedNodes()) {
        // Decide what to do with each node
        if (shouldKeep(nodeKey)) {
            await storage.keep(nodeKey);
        } else {
            await storage.delete(nodeKey);
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

Decisions are collected in memory during the callback.  The single write to the new version's storage happens only after all validation passes.  If any error is thrown before that write, the new version remains empty.
